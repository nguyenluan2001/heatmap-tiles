"""Build a multi-resolution heatmap pyramid from an AnnData h5ad file into zarr.

Pipeline
--------
1. Load the chosen matrix (layer ``log_normalize`` by default, fallback to ``X``).
2. Reorder cells by louvain cluster so the heatmap shows block structure.
3. Convert to a dense dask array chunked at ``TILE_SIZE``.
4. Write level 0 to zarr, then repeatedly 2x2 mean-pool to build coarser levels
   until both dimensions fit inside a single tile.
5. Persist metadata (dimensions, levels, value range, cell/gene labels, UMAP).

The resulting zarr store is self-describing: the FastAPI server reads
``meta.json`` and the ``level_{L}`` arrays to serve tiles.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import dask.array as da
import numpy as np
import zarr
from anndata import read_h5ad

from .config import H5AD_PATH, LAYER_KEY, TILE_SIZE, ZARR_PATH


def _load_matrix(adata, layer_key: str) -> tuple[np.ndarray, str]:
    """Return a dense ``(n_cells, n_genes)`` float32 matrix and the key used."""
    if layer_key and layer_key in adata.layers:
        mat = adata.layers[layer_key]
        key = layer_key
    else:
        mat = adata.X
        key = "X"
    # Sparse CSR -> dense. 2638 x 32310 float32 ~= 340 MB, fits in RAM.
    if hasattr(mat, "toarray"):
        mat = mat.toarray()
    return np.asarray(mat, dtype=np.float32), key


def _cluster_order(adata) -> np.ndarray:
    """Return a permutation of cell indices sorted by the first categorical
    obs column (preferring ``louvain``). Falls back to identity ordering."""
    obs = adata.obs
    for col in ("louvain", "Louvain clustering (resolution=5.0)", "m1"):
        if col in obs.columns:
            codes = obs[col].astype("category").cat.codes.to_numpy()
            # Stable sort: keeps original order within a cluster.
            return np.argsort(codes, kind="stable")
    return np.arange(adata.n_obs)


def _coarsen_mean(arr: da.Array, factor: int = 2) -> da.Array:
    """2x2 mean pooling. Edge rows/cols are trimmed to a multiple of ``factor``."""
    h, w = arr.shape
    h2 = (h // factor) * factor
    w2 = (w // factor) * factor
    if h2 != h or w2 != w:
        arr = arr[:h2, :w2]
    return da.coarsen(np.nanmean, arr, {0: factor, 1: factor}, trim_excess=False)


def build(h5ad_path: Path = H5AD_PATH, zarr_path: Path = ZARR_PATH,
          layer_key: str = LAYER_KEY, tile_size: int = TILE_SIZE,
          overwrite: bool = True) -> dict:
    print(f"[build] reading {h5ad_path}")
    adata = read_h5ad(h5ad_path)
    n_cells, n_genes = adata.n_obs, adata.n_vars
    print(f"[build] matrix: {n_cells} cells x {n_genes} genes")

    mat, used_key = _load_matrix(adata, layer_key)
    print(f"[build] using layer '{used_key}'")

    order = _cluster_order(adata)
    mat = mat[order]

    # Replace any non-finite values with 0 so pooling is well-defined.
    mat = np.where(np.isfinite(mat), mat, 0.0).astype(np.float32)

    # Global value range from robust percentiles (for colormap normalisation).
    sample = mat[mat > 0]
    if sample.size == 0:
        sample = mat.ravel()
    vmin = float(np.percentile(sample, 1))
    vmax = float(np.percentile(sample, 99))
    print(f"[build] value range: vmin={vmin:.4f} vmax={vmax:.4f}")

    # Level 0 as a dask array chunked at tile boundaries.
    level0 = da.from_array(mat, chunks=(tile_size, tile_size))

    # Determine how many levels we need: keep halving until both dims <= tile.
    max_level = 0
    h, w = n_cells, n_genes
    while h > tile_size or w > tile_size:
        h = h // 2
        w = w // 2
        max_level += 1
    n_levels = max_level + 1
    print(f"[build] pyramid: {n_levels} levels (0..{max_level})")

    # Fresh zarr store.
    if zarr_path.exists() and overwrite:
        import shutil
        shutil.rmtree(zarr_path)
    store = zarr.DirectoryStore(str(zarr_path))
    root = zarr.group(store=store, overwrite=True)

    # Write each level.
    current = level0
    for level in range(n_levels):
        h_l, w_l = current.shape
        chunks = (min(tile_size, h_l), min(tile_size, w_l))
        z = root.zeros(
            f"level_{level}", shape=(h_l, w_l), chunks=chunks,
            dtype="f4", overwrite=True,
        )
        # Write chunk-by-chunk to keep memory bounded.
        current.to_zarr(z.store, component=z.path, overwrite=True)
        print(f"[build] level {level}: {h_l} x {w_l}  ({z.nchunks} chunks)")
        if level < max_level:
            current = _coarsen_mean(current, 2)

    # Cell metadata (after reordering).
    obs = adata.obs.iloc[order]
    cell_ids = obs.index.astype(str).to_numpy()
    louvain = None
    for col in ("louvain", "Louvain clustering (resolution=5.0)", "m1"):
        if col in obs.columns:
            louvain = obs[col].astype(str).to_numpy()
            break
    umap = None
    if "X_umap" in adata.obsm:
        umap = np.asarray(adata.obsm["X_umap"], dtype=np.float32)

    # Gene metadata.
    var_names = adata.var.index.astype(str).to_numpy()

    # Persist metadata arrays.
    root.array("cell_ids", cell_ids, dtype="object", chunks=(tile_size,),
               object_codec=zarr.codecs.VLenUTF8(), overwrite=True)
    if louvain is not None:
        root.array("louvain", louvain, dtype="object", chunks=(tile_size,),
                   object_codec=zarr.codecs.VLenUTF8(), overwrite=True)
    if umap is not None:
        root.array("umap", umap, dtype="f4", chunks=(tile_size, 2), overwrite=True)
    root.array("var_names", var_names, dtype="object",
               chunks=(tile_size,), object_codec=zarr.codecs.VLenUTF8(),
               overwrite=True)

    # Per-level shape table for the client.
    shapes = []
    h, w = n_cells, n_genes
    for level in range(n_levels):
        shapes.append([int(h), int(w)])
        h = h // 2
        w = w // 2

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
        "cell_order": order.tolist(),
    }
    with open(zarr_path / "meta.json", "w") as f:
        json.dump(meta, f, indent=2)
    print(f"[build] wrote meta to {zarr_path / 'meta.json'}")
    print("[build] done")
    return meta


def main():
    p = argparse.ArgumentParser(description="Build heatmap zarr pyramid.")
    p.add_argument("--h5ad", type=Path, default=H5AD_PATH)
    p.add_argument("--zarr", type=Path, default=ZARR_PATH)
    p.add_argument("--layer", type=str, default=LAYER_KEY)
    p.add_argument("--tile-size", type=int, default=TILE_SIZE)
    p.add_argument("--no-overwrite", action="store_true")
    args = p.parse_args()
    build(args.h5ad, args.zarr, args.layer, args.tile_size,
          overwrite=not args.no_overwrite)


if __name__ == "__main__":
    main()
