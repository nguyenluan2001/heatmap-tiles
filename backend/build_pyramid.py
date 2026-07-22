"""Build a multi-resolution heatmap pyramid from an AnnData h5ad file into zarr.

Pipeline (out-of-core, supports 20M+ cells)
-------------------------------------------
Phase 1 — Streaming transpose:
    Read the h5ad in ``backed='r'`` mode (lazy, never loads the full matrix).
    Iterate over cell-chunks (``CELL_CHUNK_SIZE`` cells at a time), densify,
    transpose to gene-major ``(n_genes, n_cells)``, and write into an
    intermediate zarr store. Peak RAM ≈ one dense chunk (~4 GB).

Phase 2 — Cluster reorder:
    Compute the cluster permutation from ``obs`` (small, ~MB). Then gather
    each 256×256 tile from the intermediate zarr using zarr orthogonal fancy
    indexing, writing the reordered tile into the final ``level_0`` array.

Phase 3 — Pyramid coarsening:
    Use ``dask.array.from_zarr`` to read ``level_0`` lazily and 2×2 mean-pool
    into coarser levels until both dimensions fit inside a single tile.

Phase 4 — Streaming percentile:
    Draw a random sample of values from ``level_0`` (chunk-level sampling) and
    compute approximate p1/p99 for the colormap normalisation range. This
    avoids materialising the full 20B non-zero values.

Small datasets (< ``SMALL_DATASET_THRESHOLD`` cells) use the original in-memory
fast path for speed; large datasets use the streaming path to stay within RAM.

The resulting zarr store is self-describing: the FastAPI server reads
``meta.json`` and the ``level_{L}`` arrays to serve tiles.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import dask.array as da
import numpy as np
import zarr
from anndata import read_h5ad

try:
    from .config import (
        CELL_CHUNK_SIZE,
        H5AD_PATH,
        LAYER_KEY,
        PERCENTILE_SAMPLE_SIZE,
        TILE_SIZE,
        ZARR_CLEVEL,
        ZARR_INTERIM_PATH,
        ZARR_PATH,
    )
except ImportError:  # allow running as a plain script: python backend/build_pyramid.py
    from config import (
        CELL_CHUNK_SIZE,
        H5AD_PATH,
        LAYER_KEY,
        PERCENTILE_SAMPLE_SIZE,
        TILE_SIZE,
        ZARR_CLEVEL,
        ZARR_INTERIM_PATH,
        ZARR_PATH,
    )

# Datasets with fewer cells than this use the fast in-memory path.
SMALL_DATASET_THRESHOLD = int(2_000_000)


def _zarr_compressor():
    """Shared zstd compressor for all pyramid arrays."""
    return zarr.Blosc(cname="zstd", clevel=ZARR_CLEVEL, shuffle=zarr.Blosc.BITSHUFFLE)


def _cluster_order(adata) -> np.ndarray:
    """Return a permutation of cell indices grouped by cluster, with clusters
    ordered by descending size (largest cluster first).

    Prefers the ``louvain`` obs column (then a couple of fallbacks, including
    ``Sample id`` which is common in GEO datasets). Within a cluster the
    original cell order is preserved (stable sort). Falls back to identity
    ordering when no cluster column is found.
    """
    obs = adata.obs
    for col in (
        "louvain",
        "Louvain clustering (resolution=5.0)",
        "m1",
        "leiden",
        "cluster",
        "clusters",
        "Sample id",
        "sample",
        "batch",
        "Sample",
    ):
        if col in obs.columns:
            labels = obs[col].astype(str).to_numpy()
            # Count cells per cluster label.
            unique, inverse, counts = np.unique(labels, return_inverse=True, return_counts=True)
            # Rank clusters by descending size (largest first). Ties keep the
            # original label order (stable).
            cluster_rank = np.argsort(-counts, kind="stable")
            # Map each cluster label -> its descending-size rank.
            label_to_rank = np.empty(len(unique), dtype=np.int64)
            label_to_rank[cluster_rank] = np.arange(len(unique))
            rank_per_cell = label_to_rank[inverse]
            # Stable sort by rank: cells of the largest cluster come first,
            # and within a cluster the original order is kept.
            return np.argsort(rank_per_cell, kind="stable")
    return np.arange(adata.n_obs)


def _coarsen_mean(arr: da.Array, factor: int = 2) -> da.Array:
    """2x2 mean pooling. Edge rows/cols are trimmed to a multiple of ``factor``.

    When a dimension is already ≤ 1 (e.g. few genes in a custom pyramid), it
    is left untouched — only the other dimension is coarsened. This prevents
    the gene axis from collapsing to 0 rows.
    """
    h, w = arr.shape
    h2 = (h // factor) * factor
    w2 = (w // factor) * factor
    if h2 != h or w2 != w:
        arr = arr[:h2, :w2]
    axes = {}
    if h2 >= factor:
        axes[0] = factor
    if w2 >= factor:
        axes[1] = factor
    if not axes:
        return arr  # both dims too small — nothing to coarsen
    return da.coarsen(np.nanmean, arr, axes, trim_excess=False)


# ---------------------------------------------------------------------------
# Phase 1: Streaming transpose (sparse h5ad -> gene-major zarr, original order)
# ---------------------------------------------------------------------------


def _streaming_transpose(
    adata,
    zarr_interim: Path,
    layer_key: str,
    tile_size: int,
) -> tuple[str, str]:
    """Read the h5ad matrix in cell-chunks, transpose to gene-major, and write
    into an intermediate zarr store. Returns (used_key, array_name).

    The intermediate store keeps cells in their ORIGINAL (h5ad) order; cluster
    reordering happens in Phase 2.
    """
    n_cells, n_genes = adata.n_obs, adata.n_vars
    if layer_key and layer_key in adata.layers:
        mat_source = adata.layers[layer_key]
        used_key = layer_key
    else:
        mat_source = adata.X
        used_key = "X"

    # Prepare the intermediate zarr store: (n_genes, n_cells), tile-aligned.
    if zarr_interim.exists():
        shutil.rmtree(zarr_interim)
    store = zarr.DirectoryStore(str(zarr_interim))
    root = zarr.group(store=store, overwrite=True)
    arr = root.zeros(
        "level_0_raw",
        shape=(n_genes, n_cells),
        chunks=(tile_size, tile_size),
        dtype="f4",
        compressor=_zarr_compressor(),
        overwrite=True,
    )

    chunk = CELL_CHUNK_SIZE
    print(f"[build-phase1] streaming transpose: {n_cells} cells x {n_genes} genes, chunk={chunk}")
    for c0 in range(0, n_cells, chunk):
        c1 = min(c0 + chunk, n_cells)
        # Read a slice of cells from the backed anndata (sparse CSR).
        sparse_block = mat_source[c0:c1, :]
        if hasattr(sparse_block, "toarray"):
            dense_block = sparse_block.toarray()  # (chunk, n_genes)
        else:
            dense_block = np.asarray(sparse_block, dtype=np.float32)
        # Replace non-finite with 0 so pooling is well-defined downstream.
        np.nan_to_num(dense_block, copy=False, nan=0.0, posinf=0.0, neginf=0.0)
        dense_block = dense_block.astype(np.float32, copy=False)
        # Transpose to gene-major (n_genes, chunk) and write tile-aligned.
        transposed = np.ascontiguousarray(dense_block.T)  # (n_genes, chunk)
        arr[:, c0:c1] = transposed
        if (c0 // chunk) % 20 == 0 or c1 == n_cells:
            print(f"[build-phase1] transposed {c1}/{n_cells} cells")
    print(f"[build-phase1] done -> {zarr_interim}")
    return used_key, "level_0_raw"


# ---------------------------------------------------------------------------
# Phase 2: Cluster reorder (interim zarr -> final level_0, reordered)
# ---------------------------------------------------------------------------


def _reorder_cells(
    zarr_interim: Path,
    zarr_final: Path,
    order: np.ndarray,
    tile_size: int,
) -> zarr.Array:
    """Gather tiles from the interim store in cluster-reordered cell order and
    write the final ``level_0`` array. Returns the final zarr root.
    """
    src = zarr.open(str(zarr_interim / "level_0_raw"), mode="r")
    n_genes, n_cells = src.shape

    # Prepare the final zarr store.
    if zarr_final.exists():
        shutil.rmtree(zarr_final)
    store = zarr.DirectoryStore(str(zarr_final))
    root = zarr.group(store=store, overwrite=True)
    dst = root.zeros(
        "level_0",
        shape=(n_genes, n_cells),
        chunks=(tile_size, tile_size),
        dtype="f4",
        compressor=_zarr_compressor(),
        overwrite=True,
    )

    n_gene_tiles = (n_genes + tile_size - 1) // tile_size
    n_cell_tiles = (n_cells + tile_size - 1) // tile_size
    print(f"[build-phase2] reorder: {n_gene_tiles} gene-tiles x {n_cell_tiles} cell-tiles")
    for gt in range(n_gene_tiles):
        g0 = gt * tile_size
        g1 = min(g0 + tile_size, n_genes)
        for ct in range(n_cell_tiles):
            c_start = ct * tile_size
            c_end = min(c_start + tile_size, n_cells)
            # The 256 cell indices in the REORDERED space.
            reordered_indices = order[c_start:c_end]
            # Orthogonal fancy indexing: read (g1-g0, c_end-c_start) tile.
            block = src.oindex[g0:g1, reordered_indices]
            block = np.asarray(block, dtype=np.float32)
            dst[g0:g1, c_start:c_end] = block
        if gt % 10 == 0 or gt == n_gene_tiles - 1:
            print(f"[build-phase2] gene tile {gt + 1}/{n_gene_tiles}")
    print("[build-phase2] done")
    return root


# ---------------------------------------------------------------------------
# Phase 4: Streaming percentile (approximate p1/p99 from a random sample)
# ---------------------------------------------------------------------------


def _streaming_percentile(
    zarr_final: Path,
    sample_size: int,
    tile_size: int,
) -> tuple[float, float]:
    """Approximate the 1st/99th percentile by sampling random tiles from
    ``level_0``. Avoids materialising the full non-zero set.
    """
    root = zarr.open(str(zarr_final), mode="r")
    arr = root["level_0"]
    n_genes, n_cells = arr.shape
    n_gene_chunks = (n_genes + tile_size - 1) // tile_size
    n_cell_chunks = (n_cells + tile_size - 1) // tile_size
    # How many random tiles do we need to reach the target sample size?
    values_per_tile = tile_size * tile_size
    n_sample_tiles = max(100, sample_size // values_per_tile)
    n_sample_tiles = min(n_sample_tiles, n_gene_chunks * n_cell_chunks)

    rng = np.random.default_rng(42)
    g_chunks = rng.integers(0, n_gene_chunks, size=n_sample_tiles)
    c_chunks = rng.integers(0, n_cell_chunks, size=n_sample_tiles)

    samples = []
    for g, c in zip(g_chunks, c_chunks):
        block = np.asarray(
            arr[g * tile_size : (g + 1) * tile_size, c * tile_size : (c + 1) * tile_size],
            dtype=np.float32,
        )
        # Keep finite, positive values (expression > 0).
        vals = block[np.isfinite(block) & (block > 0)]
        if vals.size:
            samples.append(vals.ravel())
    if not samples:
        # Fallback: scan all values (small dataset).
        all_vals = np.asarray(arr[:], dtype=np.float32).ravel()
        all_vals = all_vals[np.isfinite(all_vals)]
        if all_vals.size == 0:
            return 0.0, 1.0
        return float(np.percentile(all_vals, 1)), float(np.percentile(all_vals, 99))

    all_samples = np.concatenate(samples)
    vmin = float(np.percentile(all_samples, 1))
    vmax = float(np.percentile(all_samples, 99))
    print(
        f"[build-phase4] percentile sample: {all_samples.size} values -> vmin={vmin:.4f} vmax={vmax:.4f}"
    )
    return vmin, vmax


# ---------------------------------------------------------------------------
# Phase 3: Pyramid coarsening (dask, out-of-core)
# ---------------------------------------------------------------------------


def _build_pyramid_levels(root: zarr.Group, tile_size: int) -> int:
    """Read ``level_0`` lazily via dask and 2×2 mean-pool into coarser levels
    until both dimensions fit inside a single tile. Returns the number of
    levels (n_levels = max_level + 1).
    """
    arr0 = root["level_0"]
    n_genes, n_cells = arr0.shape
    max_level = 0
    h, w = n_genes, n_cells
    while h > tile_size or w > tile_size:
        h = h // 2
        w = w // 2
        max_level += 1
    n_levels = max_level + 1
    print(f"[build-phase3] pyramid: {n_levels} levels (0..{max_level})")

    current = da.from_zarr(arr0)
    for level in range(1, n_levels):
        coarse = _coarsen_mean(current, 2)
        h_l, w_l = coarse.shape
        chunks = (min(tile_size, h_l), min(tile_size, w_l))
        coarse = coarse.rechunk(chunks)
        z = root.zeros(
            f"level_{level}",
            shape=(h_l, w_l),
            chunks=chunks,
            dtype="f4",
            compressor=_zarr_compressor(),
            overwrite=True,
        )
        coarse.to_zarr(z.store, component=z.path, overwrite=True)
        print(f"[build-phase3] level {level}: {h_l} x {w_l}")
        current = da.from_zarr(z)
    return n_levels


# ---------------------------------------------------------------------------
# Metadata persistence
# ---------------------------------------------------------------------------


def _write_metadata(
    root: zarr.Group,
    adata,
    order: np.ndarray,
    n_levels: int,
    vmin: float,
    vmax: float,
    used_key: str,
    tile_size: int,
    zarr_path: Path,
) -> dict:
    """Persist cell/gene metadata arrays into zarr and write meta.json.

    NOTE: ``cell_order`` is stored as a zarr int32 array (lazy, chunked) instead
    of being embedded in meta.json — at 20M cells the JSON would be ~160 MB.
    """
    n_cells, n_genes = adata.n_obs, adata.n_vars
    obs = adata.obs.iloc[order]
    cell_ids = obs.index.astype(str).to_numpy()
    louvain = None
    louvain_col = None
    for col in (
        "louvain",
        "Louvain clustering (resolution=5.0)",
        "m1",
        "leiden",
        "cluster",
        "clusters",
        "Sample id",
        "sample",
        "batch",
        "Sample",
    ):
        if col in obs.columns:
            louvain = obs[col].astype(str).to_numpy()
            louvain_col = col
            break
    umap = None
    if "X_umap" in adata.obsm:
        umap = np.asarray(adata.obsm["X_umap"], dtype=np.float32)
    var_names = adata.var.index.astype(str).to_numpy()

    # cell_order as a chunked zarr array (NOT in meta.json for large datasets).
    root.array(
        "cell_order",
        order.astype(np.int32),
        dtype="i4",
        chunks=(tile_size,),
        overwrite=True,
    )
    root.array(
        "cell_ids",
        cell_ids,
        dtype="object",
        chunks=(tile_size,),
        object_codec=zarr.codecs.VLenUTF8(),
        overwrite=True,
    )
    if louvain is not None:
        root.array(
            "louvain",
            louvain,
            dtype="object",
            chunks=(tile_size,),
            object_codec=zarr.codecs.VLenUTF8(),
            overwrite=True,
        )
    if umap is not None:
        root.array("umap", umap, dtype="f4", chunks=(tile_size, 2), overwrite=True)
    root.array(
        "var_names",
        var_names,
        dtype="object",
        chunks=(tile_size,),
        object_codec=zarr.codecs.VLenUTF8(),
        overwrite=True,
    )

    # Per-level shape table for the client.
    shapes = []
    h, w = n_genes, n_cells
    for _level in range(n_levels):
        shapes.append([int(h), int(w)])
        h = h // 2
        w = w // 2

    # Cluster groups for the frontend SpatialLayout (gap math).
    groups = []
    if louvain is not None:
        prev = None
        start = 0
        for i, lab in enumerate(louvain):
            if lab != prev:
                if prev is not None:
                    groups.append({"id": str(prev), "size": i - start})
                prev = lab
                start = i
        if prev is not None:
            groups.append({"id": str(prev), "size": len(louvain) - start})
    if not groups:
        groups = [{"id": "0", "size": int(n_cells)}]
    print(f"[build] cluster groups: {len(groups)}")

    meta = {
        "n_cells": int(n_cells),
        "n_genes": int(n_genes),
        "tile_size": int(tile_size),
        "n_levels": int(n_levels),
        "levels": shapes,
        "vmin": vmin,
        "vmax": vmax,
        "layer": used_key,
        "colormap": "viridis",
        # cell_order is intentionally NOT here for large datasets — it lives
        # in the zarr "cell_order" array. Kept only for small datasets for
        # backward compatibility (the frontend no longer reads it).
        "groups": groups,
        "cluster_col": louvain_col,
    }
    with open(zarr_path / "meta.json", "w") as f:
        json.dump(meta, f, indent=2)
    print(f"[build] wrote meta to {zarr_path / 'meta.json'}")
    return meta


# ---------------------------------------------------------------------------
# Small-dataset fast path (in-memory, original behaviour)
# ---------------------------------------------------------------------------


def _build_small(
    adata,
    zarr_path: Path,
    layer_key: str,
    tile_size: int,
    overwrite: bool,
) -> dict:
    """Original in-memory build path for small datasets (< 2M cells)."""
    n_cells, n_genes = adata.n_obs, adata.n_vars
    print(f"[build] small dataset ({n_cells} cells) — in-memory path")

    if layer_key and layer_key in adata.layers:
        mat = adata.layers[layer_key]
        used_key = layer_key
    else:
        mat = adata.X
        used_key = "X"
    if hasattr(mat, "toarray"):
        mat = mat.toarray()
    mat = np.asarray(mat, dtype=np.float32).T  # (n_genes, n_cells)

    order = _cluster_order(adata)
    mat = mat[:, order]
    mat = np.where(np.isfinite(mat), mat, 0.0).astype(np.float32)

    sample = mat[mat > 0]
    if sample.size == 0:
        sample = mat.ravel()
    vmin = float(np.percentile(sample, 1))
    vmax = float(np.percentile(sample, 99))
    print(f"[build] value range: vmin={vmin:.4f} vmax={vmax:.4f}")

    level0 = da.from_array(mat, chunks=(tile_size, tile_size))
    max_level = 0
    h, w = n_genes, n_cells
    while h > tile_size or w > tile_size:
        h = h // 2
        w = w // 2
        max_level += 1
    n_levels = max_level + 1

    if zarr_path.exists() and overwrite:
        shutil.rmtree(zarr_path)
    store = zarr.DirectoryStore(str(zarr_path))
    root = zarr.group(store=store, overwrite=True)
    current = level0
    for level in range(n_levels):
        h_l, w_l = current.shape
        chunks = (min(tile_size, h_l), min(tile_size, w_l))
        current = current.rechunk(chunks)
        z = root.zeros(
            f"level_{level}",
            shape=(h_l, w_l),
            chunks=chunks,
            dtype="f4",
            compressor=_zarr_compressor(),
            overwrite=True,
        )
        current.to_zarr(z.store, component=z.path, overwrite=True)
        print(f"[build] level {level}: {h_l} x {w_l}  ({z.nchunks} chunks)")
        if level < max_level:
            current = _coarsen_mean(current, 2)

    return _write_metadata(root, adata, order, n_levels, vmin, vmax, used_key, tile_size, zarr_path)


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def build(
    h5ad_path: Path = H5AD_PATH,
    zarr_path: Path = ZARR_PATH,
    layer_key: str = LAYER_KEY,
    tile_size: int = TILE_SIZE,
    overwrite: bool = True,
    zarr_interim: Path = ZARR_INTERIM_PATH,
) -> dict:
    """Build a heatmap zarr pyramid from an h5ad file.

    Automatically selects the in-memory fast path for small datasets
    (< ``SMALL_DATASET_THRESHOLD`` cells) or the out-of-core streaming path for
    large datasets.
    """
    print(f"[build] reading {h5ad_path}")
    adata = read_h5ad(h5ad_path, backed="r")
    n_cells, n_genes = adata.n_obs, adata.n_vars
    print(f"[build] matrix: {n_cells} cells x {n_genes} genes")
    # Auto-shrink chunk size if the dense chunk would be too large for RAM.
    # 50K cells x 33K genes x f4 = ~6.7 GB — too much for 16 GB machines.
    # Target: keep the dense chunk under ~2 GB.
    global CELL_CHUNK_SIZE
    max_chunk = max(2000, int(2 * 10**9 // (n_genes * 4)))
    if CELL_CHUNK_SIZE > max_chunk:
        print(
            f"[build] auto-shrinking cell chunk: {CELL_CHUNK_SIZE} -> {max_chunk} "
            f"(n_genes={n_genes}, target <2 GB dense)"
        )
        CELL_CHUNK_SIZE = max_chunk

    # if n_cells < SMALL_DATASET_THRESHOLD:
    #     return _build_small(adata, zarr_path, layer_key, tile_size, overwrite)

    # ---- Large dataset: out-of-core streaming pipeline ----
    print(f"[build] large dataset ({n_cells} cells) — out-of-core streaming path")

    # Phase 1: streaming transpose into interim zarr (original cell order).
    used_key, _ = _streaming_transpose(adata, zarr_interim, layer_key, tile_size)

    # Phase 2: cluster reorder from interim -> final level_0.
    order = _cluster_order(adata)
    root = _reorder_cells(zarr_interim, zarr_path, order, tile_size)

    # Phase 3: pyramid coarsening (dask, out-of-core).
    n_levels = _build_pyramid_levels(root, tile_size)

    # Phase 4: streaming percentile.
    vmin, vmax = _streaming_percentile(zarr_path, PERCENTILE_SAMPLE_SIZE, tile_size)

    # Metadata + cleanup.
    meta = _write_metadata(root, adata, order, n_levels, vmin, vmax, used_key, tile_size, zarr_path)

    # Remove the interim store to reclaim disk space.
    if zarr_interim.exists():
        shutil.rmtree(zarr_interim)
        print(f"[build] removed interim store {zarr_interim}")

    print("[build] done")
    return meta


def main():
    p = argparse.ArgumentParser(description="Build heatmap zarr pyramid.")
    p.add_argument("--h5ad", type=Path, default=H5AD_PATH)
    p.add_argument("--zarr", type=Path, default=ZARR_PATH)
    p.add_argument("--interim", type=Path, default=ZARR_INTERIM_PATH)
    p.add_argument("--layer", type=str, default=LAYER_KEY)
    p.add_argument("--tile-size", type=int, default=TILE_SIZE)
    p.add_argument("--no-overwrite", action="store_true")
    args = p.parse_args()
    build(
        args.h5ad,
        args.zarr,
        args.layer,
        args.tile_size,
        overwrite=not args.no_overwrite,
        zarr_interim=args.interim,
    )


if __name__ == "__main__":
    main()
