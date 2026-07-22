"""FastAPI server that serves heatmap tiles and metadata from a zarr pyramid.

Endoints
--------
GET  /api/meta                       -> pyramid metadata (dimensions, levels, value range)
GET  /api/tile/{l}/{r}/{c}            -> PNG tile at pyramid level l, tile row r, col c (dynamic, cached)
GET  /api/obs                         -> cell labels, louvain, umap (full — small datasets only)
GET  /api/obs/range?start=&end=        -> cell metadata for a range [start, end) (lazy, large datasets)
GET  /api/var                         -> gene names
GET  /api/groups                      -> cluster groups (id + size) for the SpatialLayout
GET  /api/value/{c}/{g}               -> raw expression value for one cell-gene pair
GET  /api/cell_order                  -> the cluster permutation array (chunked, lazy)
POST /api/custom                      -> build a custom sub-matrix pyramid for selected genes
GET  /api/custom/{id}/meta            -> custom pyramid metadata
GET  /api/custom/{id}/tile/{l}/{r}/{c} -> custom pyramid tile PNG (dynamic, cached)
GET  /api/custom/{id}/var             -> custom pyramid gene names
GET  /api/cache/stats                 -> tile cache statistics
GET  /tiles/{level}/{row}_{col}.png   -> static pre-rendered grayscale PNG (legacy, small datasets)
GET  /                               -> health check

For large datasets (>1M cells) the dynamic zarr-backed endpoints are the
primary path: the static PNG pre-rendering is infeasible (millions of files).
Tiles are rendered on-the-fly and cached on disk (see ``tile_cache.py``).
All tiles are 8-bit grayscale; colour mapping is done on the GPU (Rule #2).
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from pathlib import Path

import numpy as np
import zarr
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

try:
    from .config import (
        HOST,
        OBS_FULL_THRESHOLD,
        PORT,
        TILE_SIZE,
        USE_DYNAMIC_TILES,
        ZARR_PATH,
    )
    from .tile_cache import tile_cache
    from .tile_render import render_tile_png
except ImportError:  # allow running as a plain script
    from config import HOST, OBS_FULL_THRESHOLD, PORT, TILE_SIZE, USE_DYNAMIC_TILES, ZARR_PATH
    from tile_cache import tile_cache
    from tile_render import render_tile_png

# Directory of pre-rendered static grayscale PNG tiles (legacy path).
TILES_DIR = Path(os.environ.get("HEATMAP_TILES_DIR", ZARR_PATH.parent / "tiles"))
STATIC_DATASET_ID = os.environ.get("HEATMAP_DATASET_ID", "default")

app = FastAPI(title="Heatmap Pyramid Server", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class PyramidStore:
    """Lazily open the zarr store and cache arrays + metadata."""

    def __init__(self, zarr_path: Path):
        self.zarr_path = zarr_path
        self.root: zarr.Group | None = None
        self.meta: dict | None = None
        self._arrays: dict[int, zarr.Array] = {}

    def open(self):
        if self.root is not None:
            return
        if not self.zarr_path.exists():
            raise FileNotFoundError(
                f"Zarr store not found at {self.zarr_path}. "
                "Run `python -m backend.build_pyramid` first."
            )
        self.root = zarr.open(str(self.zarr_path), mode="r")
        with open(self.zarr_path / "meta.json") as f:
            self.meta = json.load(f)

    def array(self, level: int) -> zarr.Array:
        self.open()
        if level not in self._arrays:
            key = f"level_{level}"
            if key not in self.root:
                raise KeyError(f"Level {level} not in zarr store")
            self._arrays[level] = self.root[key]
        return self._arrays[level]

    def tile(self, level: int, row: int, col: int) -> np.ndarray:
        """Return a ``(tile_size, tile_size)`` float32 tile, NaN-padded."""
        arr = self.array(level)
        h, w = arr.shape
        # Reject negative or out-of-range tile indices.
        if row < 0 or col < 0:
            raise IndexError("tile outside matrix")
        r0 = row * TILE_SIZE
        c0 = col * TILE_SIZE
        if r0 >= h or c0 >= w:
            raise IndexError("tile outside matrix")
        r1 = min(r0 + TILE_SIZE, h)
        c1 = min(c0 + TILE_SIZE, w)
        block = np.asarray(arr[r0:r1, c0:c1], dtype=np.float32)
        # Pad to full tile size with NaN so PNGs are uniform.
        if block.shape != (TILE_SIZE, TILE_SIZE):
            padded = np.full((TILE_SIZE, TILE_SIZE), np.nan, dtype=np.float32)
            padded[: r1 - r0, : c1 - c0] = block
            return padded
        return block


_store = PyramidStore(ZARR_PATH)


@app.get("/")
def health():
    return {
        "status": "ok",
        "zarr": str(ZARR_PATH),
        "tiles_dir": str(TILES_DIR),
        "dynamic_tiles": USE_DYNAMIC_TILES,
        "cache": tile_cache.stats(),
    }


@app.get("/tiles/{level}/{row}_{col}.png")
def get_static_tile(level: int, row: int, col: int):
    """Serve a pre-rendered static grayscale PNG tile (legacy path)."""
    tile_path = TILES_DIR / STATIC_DATASET_ID / str(level) / f"{row}_{col}.png"
    if not tile_path.is_file():
        raise HTTPException(status_code=404, detail="static tile not found")
    return FileResponse(tile_path, media_type="image/png")


@app.get("/api/meta")
def get_meta():
    _store.open()
    return _store.meta


def _serve_tile_sync(level: int, row: int, col: int) -> bytes:
    """Render (or fetch from cache) a single tile's PNG bytes."""
    key = f"t/{level}/{row}/{col}"
    vmin = float(_store.meta["vmin"])
    vmax = float(_store.meta["vmax"])

    def render() -> bytes:
        block = _store.tile(level, row, col)
        return render_tile_png(block, vmin, vmax)

    return tile_cache.get_or_render(key, render)


@app.get("/api/tile/{level}/{row}/{col}")
async def get_tile(level: int, row: int, col: int):
    """Dynamic tile endpoint — renders from zarr on-the-fly, cached on disk.

    Runs the (CPU-bound) render in a thread so the event loop stays responsive
    to the many parallel tile requests deck.gl issues.
    """
    try:
        _store.open()
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))
    try:
        png = await asyncio.to_thread(_serve_tile_sync, level, row, col)
    except (KeyError, IndexError):
        raise HTTPException(status_code=404, detail="tile out of range")
    return Response(content=png, media_type="image/png")


@app.get("/api/obs")
def get_obs():
    """Return cell-level metadata (after pyramid reordering).

    For large datasets (>= ``OBS_FULL_THRESHOLD`` cells) this endpoint is
    disabled to prevent browser OOM; use ``/api/obs/range`` instead.
    """
    _store.open()
    n_cells = _store.meta.get("n_cells", 0)
    if n_cells >= OBS_FULL_THRESHOLD:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Dataset has {n_cells} cells — /api/obs is disabled for datasets "
                f"with >= {OBS_FULL_THRESHOLD} cells. Use /api/obs/range?start=&end= "
                "to fetch metadata lazily."
            ),
        )
    root = _store.root
    out = {"cell_ids": root["cell_ids"][:].tolist()}
    if "louvain" in root:
        out["louvain"] = root["louvain"][:].tolist()
    if "umap" in root:
        out["umap"] = np.asarray(root["umap"][:]).tolist()
    return out


@app.get("/api/obs/range")
def get_obs_range(start: int = Query(0, ge=0), end: int = Query(..., ge=0)):
    """Return cell metadata for a half-open range [start, end).

    Used by the frontend for lazy axis-label fetching: only the cells visible
    in the current viewport are requested, keeping the browser memory bounded
    even for 20M+ cell datasets.
    """
    try:
        _store.open()
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))
    root = _store.root
    n_cells = _store.meta.get("n_cells", 0)
    # Clamp the range to valid bounds.
    start = max(0, start)
    end = min(n_cells, end)
    if start >= end:
        return {"cell_ids": [], "start": start, "end": end}
    out: dict = {"cell_ids": root["cell_ids"][start:end].tolist(), "start": start, "end": end}
    if "louvain" in root:
        out["louvain"] = root["louvain"][start:end].tolist()
    if "umap" in root:
        out["umap"] = np.asarray(root["umap"][start:end]).tolist()
    return out


@app.get("/api/groups")
def get_groups():
    """Return the cluster groups (id + size) for the frontend SpatialLayout."""
    _store.open()
    return {"groups": _store.meta.get("groups", [])}


@app.get("/api/var")
def get_var():
    _store.open()
    return {"var_names": _store.root["var_names"][:].tolist()}


@app.get("/api/value/{cell}/{gene}")
def get_value(cell: int, gene: int):
    """Return the raw expression value for a single cell-gene pair (level 0)."""
    try:
        _store.open()
        arr = _store.array(0)
        # Matrix is transposed: (n_genes, n_cells) -> [gene, cell].
        n_genes, n_cells = arr.shape
        if not (0 <= cell < n_cells and 0 <= gene < n_genes):
            raise HTTPException(status_code=404, detail="index out of range")
        value = float(arr[gene, cell])
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"cell": cell, "gene": gene, "value": value}


@app.get("/api/cell_order")
def get_cell_order():
    """Return the cluster permutation array (reordered cell indices).

    Stored as a chunked zarr int32 array; read in full here (it is only needed
    if the frontend wants to map reordered indices back to original cell ids).
    For 20M cells this is ~80 MB — the frontend should request it lazily.
    """
    try:
        _store.open()
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))
    root = _store.root
    if "cell_order" not in root:
        raise HTTPException(status_code=404, detail="cell_order not stored")
    return {"cell_order": np.asarray(root["cell_order"][:]).tolist()}


@app.get("/api/cache/stats")
def get_cache_stats():
    """Return tile cache statistics."""
    return tile_cache.stats()


# ---------------------------------------------------------------------------
# Custom pyramid (gene subset selection) — out-of-core for large datasets
# ---------------------------------------------------------------------------


class CustomPyramid:
    """A pyramid built from a subset of genes (rows) of level 0.

    For small datasets the pyramid is held in memory (fast). For large
    datasets the selected gene rows are streamed from level 0 into a
    per-custom-pyramid zarr store on disk, and the pyramid levels are built
    via dask — keeping RAM bounded regardless of dataset size.

    Entries expire after 30 minutes of inactivity to bound disk usage.
    """

    def __init__(self):
        self._stores: dict[str, dict] = {}

    def _is_large(self) -> bool:
        _store.open()
        return _store.meta.get("n_cells", 0) >= OBS_FULL_THRESHOLD

    def build(self, gene_indices: list[int]) -> str:
        _store.open()
        arr0 = _store.array(0)
        n_genes_full, n_cells = arr0.shape
        idx = np.asarray(gene_indices, dtype=np.int64)
        if idx.size == 0:
            raise ValueError("no genes selected")
        if idx.min() < 0 or idx.max() >= n_genes_full:
            raise IndexError("gene index out of range")
        n_sel = len(idx)

        if self._is_large():
            return self._build_large(idx, n_sel, n_cells)
        return self._build_small(idx, n_sel, n_cells)

    def _build_small(self, idx: np.ndarray, n_sel: int, n_cells: int) -> str:
        """In-memory build for small datasets (original behaviour)."""
        arr0 = _store.array(0)
        sub = np.asarray(arr0[idx, :], dtype=np.float32)
        levels = [sub]
        h, w = sub.shape
        while h > TILE_SIZE or w > TILE_SIZE:
            h2 = (h // 2) * 2
            w2 = (w // 2) * 2
            # When the gene (row) dimension is already ≤ 1, only coarsen
            # the cell (column) dimension to avoid collapsing to 0 rows.
            if h <= 1:
                h2 = h
                coarse = sub[:h2, :w2].copy()
                coarse = coarse.reshape(h2, 1, w2 // 2, 2)
                coarse = coarse.mean(axis=(1, 3))
            else:
                coarse = sub[:h2, :w2].copy()
                coarse = coarse.reshape(h2 // 2, 2, w2 // 2, 2)
                coarse = coarse.mean(axis=(1, 3))
            levels.append(coarse)
            sub = coarse
            h, w = sub.shape
        sample = levels[0][levels[0] > 0]
        if sample.size == 0:
            sample = levels[0].ravel()
        vmin = float(np.percentile(sample, 1))
        vmax = float(np.percentile(sample, 99))
        var_names = _store.root["var_names"][:][idx].tolist()
        shapes = [[int(l.shape[0]), int(l.shape[1])] for l in levels]
        cid = uuid.uuid4().hex[:12]
        self._stores[cid] = {
            "levels": levels,
            "var_names": var_names,
            "zarr_path": None,
            "last_access": time.time(),
            "meta": {
                "n_cells": int(n_cells),
                "n_genes": int(n_sel),
                "tile_size": TILE_SIZE,
                "n_levels": len(levels),
                "levels": shapes,
                "vmin": vmin,
                "vmax": vmax,
                "layer": _store.meta.get("layer", "X"),
                "colormap": "viridis",
                "gene_indices": idx.tolist(),
                "groups": _store.meta.get("groups", [{"id": "0", "size": int(n_cells)}]),
            },
        }
        return cid

    def _build_large(self, idx: np.ndarray, n_sel: int, n_cells: int) -> str:
        """Out-of-core build for large datasets: stream selected gene rows
        from level 0 into a per-custom zarr store, then dask-pool the pyramid.
        """
        import dask.array as da

        arr0 = _store.array(0)
        cid = uuid.uuid4().hex[:12]
        custom_dir = ZARR_PATH.parent / f"custom_{cid}"
        store = zarr.DirectoryStore(str(custom_dir))
        root = zarr.group(store=store, overwrite=True)

        # Stream each selected gene row into a custom level_0 zarr array.
        # Each gene row is n_cells * 4 bytes (80 MB at 20M) — fits RAM.
        custom_arr = root.zeros(
            "level_0",
            shape=(n_sel, n_cells),
            chunks=(TILE_SIZE, TILE_SIZE),
            dtype="f4",
            compressor=zarr.Blosc(cname="zstd", clevel=3),
            overwrite=True,
        )
        for i, g in enumerate(idx):
            custom_arr[i, :] = np.asarray(arr0[g, :], dtype=np.float32)
        var_names = _store.root["var_names"][:][idx].tolist()

        # Build pyramid levels via dask (out-of-core).
        current = da.from_zarr(custom_arr)
        levels_shapes = [list(current.shape)]
        level = 0
        h, w = current.shape
        while h > TILE_SIZE or w > TILE_SIZE:
            h2 = (h // 2) * 2
            w2 = (w // 2) * 2
            # When the gene (row) dimension is already ≤ 1, only coarsen
            # the cell (column) dimension to avoid collapsing to 0 rows.
            if h <= 1:
                h2 = h
                coarse = current[:h2, :w2].rechunk((TILE_SIZE, TILE_SIZE))
                coarse = da.coarsen(np.nanmean, coarse, {1: 2}, trim_excess=False)
            else:
                coarse = current[:h2, :w2].rechunk((TILE_SIZE, TILE_SIZE))
                coarse = da.coarsen(np.nanmean, coarse, {0: 2, 1: 2}, trim_excess=False)
            h, w = coarse.shape
            chunks = (min(TILE_SIZE, h), min(TILE_SIZE, w))
            coarse = coarse.rechunk(chunks)
            level += 1
            z = root.zeros(
                f"level_{level}",
                shape=(h, w),
                chunks=chunks,
                dtype="f4",
                compressor=zarr.Blosc(cname="zstd", clevel=3),
                overwrite=True,
            )
            coarse.to_zarr(z.store, component=z.path, overwrite=True)
            levels_shapes.append([int(h), int(w)])
            current = da.from_zarr(z)

        n_levels = level + 1

        # Approximate percentile from a sample of level 0.
        rng = np.random.default_rng(42)
        n_cell_chunks = (n_cells + TILE_SIZE - 1) // TILE_SIZE
        n_sample = min(2000, n_sel * n_cell_chunks)
        g_sel = rng.integers(0, n_sel, size=n_sample)
        c_sel = rng.integers(0, n_cell_chunks, size=n_sample)
        samples = []
        for g, c in zip(g_sel, c_sel):
            block = np.asarray(
                custom_arr[g * 1 : (g + 1) * 1, c * TILE_SIZE : (c + 1) * TILE_SIZE],
                dtype=np.float32,
            )
            vals = block[np.isfinite(block) & (block > 0)]
            if vals.size:
                samples.append(vals.ravel())
        if samples:
            all_s = np.concatenate(samples)
            vmin = float(np.percentile(all_s, 1))
            vmax = float(np.percentile(all_s, 99))
        else:
            vmin, vmax = 0.0, 1.0

        self._stores[cid] = {
            "levels": None,  # on-disk, opened lazily
            "zarr_path": custom_dir,
            "var_names": var_names,
            "last_access": time.time(),
            "meta": {
                "n_cells": int(n_cells),
                "n_genes": int(n_sel),
                "tile_size": TILE_SIZE,
                "n_levels": n_levels,
                "levels": levels_shapes,
                "vmin": vmin,
                "vmax": vmax,
                "layer": _store.meta.get("layer", "X"),
                "colormap": "viridis",
                "gene_indices": idx.tolist(),
                "groups": _store.meta.get("groups", [{"id": "0", "size": int(n_cells)}]),
            },
        }
        return cid

    def _evict_expired(self, ttl: float = 1800.0) -> None:
        """Remove custom pyramids unused for ``ttl`` seconds."""
        now = time.time()
        expired = [cid for cid, s in self._stores.items() if now - s.get("last_access", now) > ttl]
        for cid in expired:
            store = self._stores.pop(cid, None)
            if store and store.get("zarr_path"):
                import shutil

                p = Path(store["zarr_path"])
                if p.exists():
                    shutil.rmtree(p, ignore_errors=True)

    def get(self, cid: str) -> dict | None:
        store = self._stores.get(cid)
        if store is None:
            return None
        store["last_access"] = time.time()
        return store

    def _open_levels(self, cid: str) -> list[np.ndarray] | None:
        """Open the on-disk custom pyramid levels lazily."""
        store = self._stores[cid]
        if store["levels"] is not None:
            return store["levels"]
        zarr_path = store.get("zarr_path")
        if not zarr_path:
            return None
        root = zarr.open(str(zarr_path), mode="r")
        n_levels = store["meta"]["n_levels"]
        store["levels"] = [root[f"level_{l}"] for l in range(n_levels)]
        return store["levels"]

    def tile(self, cid: str, level: int, row: int, col: int) -> np.ndarray:
        store = self._stores[cid]
        if store["levels"] is not None:
            levels = store["levels"]
        else:
            levels = self._open_levels(cid)
        if levels is None or level < 0 or level >= len(levels):
            raise IndexError("level out of range")
        arr = levels[level]
        h, w = arr.shape
        if row < 0 or col < 0:
            raise IndexError("tile outside matrix")
        r0 = row * TILE_SIZE
        c0 = col * TILE_SIZE
        if r0 >= h or c0 >= w:
            raise IndexError("tile outside matrix")
        r1 = min(r0 + TILE_SIZE, h)
        c1 = min(c0 + TILE_SIZE, w)
        block = np.asarray(arr[r0:r1, c0:c1], dtype=np.float32)
        if block.shape != (TILE_SIZE, TILE_SIZE):
            padded = np.full((TILE_SIZE, TILE_SIZE), np.nan, dtype=np.float32)
            padded[: r1 - r0, : c1 - c0] = block
            return padded
        return block


_custom = CustomPyramid()


class GeneSelection(BaseModel):
    gene_indices: list[int]


@app.post("/api/custom")
def create_custom(selection: GeneSelection):
    """Build a custom sub-matrix pyramid for the given gene indices."""
    _custom._evict_expired()
    try:
        _store.open()
        cid = _custom.build(selection.gene_indices)
    except (ValueError, IndexError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"id": cid, **_custom.get(cid)["meta"]}


@app.get("/api/custom/{cid}/meta")
def get_custom_meta(cid: str):
    store = _custom.get(cid)
    if not store:
        raise HTTPException(status_code=404, detail="custom pyramid not found")
    return store["meta"]


def _serve_custom_tile_sync(cid: str, level: int, row: int, col: int) -> bytes:
    store = _custom.get(cid)
    if not store:
        raise KeyError("custom pyramid not found")
    key = f"c/{cid}/{level}/{row}/{col}"
    vmin = store["meta"]["vmin"]
    vmax = store["meta"]["vmax"]

    def render() -> bytes:
        block = _custom.tile(cid, level, row, col)
        return render_tile_png(block, vmin, vmax)

    return tile_cache.get_or_render(key, render)


@app.get("/api/custom/{cid}/tile/{level}/{row}/{col}")
async def get_custom_tile(cid: str, level: int, row: int, col: int):
    store = _custom.get(cid)
    if not store:
        raise HTTPException(status_code=404, detail="custom pyramid not found")
    try:
        png = await asyncio.to_thread(_serve_custom_tile_sync, cid, level, row, col)
    except (KeyError, IndexError):
        raise HTTPException(status_code=404, detail="tile out of range")
    return Response(content=png, media_type="image/png")


@app.get("/api/custom/{cid}/var")
def get_custom_var(cid: str):
    store = _custom.get(cid)
    if not store:
        raise HTTPException(status_code=404, detail="custom pyramid not found")
    return {"var_names": store["var_names"]}


def main():
    import uvicorn

    uvicorn.run("backend.server:app", host=HOST, port=PORT, reload=False)


if __name__ == "__main__":
    main()
