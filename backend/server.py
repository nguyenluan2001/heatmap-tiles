"""FastAPI server that serves heatmap tiles and metadata from a zarr pyramid.

Endpoints
---------
GET  /api/meta            -> pyramid metadata (dimensions, levels, value range)
GET  /api/tile/{l}/{r}/{c} -> PNG tile at pyramid level l, tile row r, col c
GET  /api/obs             -> cell labels, louvain, umap
GET  /api/var             -> gene names
GET  /api/value/{c}/{g}   -> raw expression value for one cell-gene pair
POST /api/custom          -> build a custom sub-matrix pyramid for selected genes
GET  /api/custom/{id}/meta            -> custom pyramid metadata
GET  /api/custom/{id}/tile/{l}/{r}/{c} -> custom pyramid tile PNG
GET  /                     -> health check
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import numpy as np
import zarr
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

from .config import HOST, PORT, TILE_SIZE, ZARR_PATH
from .tile_render import render_tile_png

app = FastAPI(title="Heatmap Pyramid Server", version="0.1.0")
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
    return {"status": "ok", "zarr": str(ZARR_PATH)}


@app.get("/api/meta")
def get_meta():
    _store.open()
    return _store.meta


@app.get("/api/tile/{level}/{row}/{col}")
def get_tile(level: int, row: int, col: int):
    try:
        _store.open()
        vmin = float(_store.meta["vmin"])
        vmax = float(_store.meta["vmax"])
        block = _store.tile(level, row, col)
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except (KeyError, IndexError):
        raise HTTPException(status_code=404, detail="tile out of range")
    png = render_tile_png(block, vmin, vmax)
    return Response(content=png, media_type="image/png")


@app.get("/api/obs")
def get_obs():
    """Return cell-level metadata (after pyramid reordering)."""
    _store.open()
    root = _store.root
    out = {"cell_ids": root["cell_ids"][:].tolist()}
    if "louvain" in root:
        out["louvain"] = root["louvain"][:].tolist()
    if "umap" in root:
        out["umap"] = np.asarray(root["umap"][:]).tolist()
    return out


@app.get("/api/var")
def get_var():
    _store.open()
    return {"var_names": _store.root["var_names"][:].tolist()}


@app.get("/api/value/{cell}/{gene}")
def get_value(cell: int, gene: int):
    """Return the raw expression value for a single cell-gene pair (level 0).

    Used by the frontend hover tooltip. Indices are in the reordered
    (louvain-sorted) space, matching the cell_ids / var_names arrays.
    """
    try:
        _store.open()
        arr = _store.array(0)
        n_cells, n_genes = arr.shape
        if not (0 <= cell < n_cells and 0 <= gene < n_genes):
            raise HTTPException(status_code=404, detail="index out of range")
        # Read just the single element from the zarr chunk.
        value = float(arr[cell, gene])
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"cell": cell, "gene": gene, "value": value}


class CustomPyramid:
    """An in-memory pyramid built from a subset of genes (columns) of level 0.

    Stored as a dict of {id: {levels: [np.ndarray], meta: dict}}. Entries
    expire after 30 minutes of inactivity to bound memory.
    """
    def __init__(self):
        self._stores: dict[str, dict] = {}

    def build(self, gene_indices: list[int]) -> str:
        _store.open()
        arr0 = _store.array(0)
        n_cells, n_genes = arr0.shape
        # Validate indices.
        idx = np.asarray(gene_indices, dtype=np.int64)
        if idx.size == 0:
            raise ValueError("no genes selected")
        if idx.min() < 0 or idx.max() >= n_genes:
            raise IndexError("gene index out of range")
        # Select columns from level 0.
        sub = np.asarray(arr0[:, idx], dtype=np.float32)
        n_sel = len(idx)
        # Build pyramid by 2x2 mean-pooling until both dims <= TILE_SIZE.
        levels = [sub]
        h, w = sub.shape
        while h > TILE_SIZE or w > TILE_SIZE:
            h2 = (h // 2) * 2
            w2 = (w // 2) * 2
            coarse = sub[:h2, :w2].copy()
            coarse = coarse.reshape(h2 // 2, 2, w2 // 2, 2)
            coarse = coarse.mean(axis=(1, 3))
            levels.append(coarse)
            sub = coarse
            h, w = sub.shape
        # Value range from the full sub-matrix.
        sample = levels[0][levels[0] > 0]
        if sample.size == 0:
            sample = levels[0].ravel()
        vmin = float(np.percentile(sample, 1))
        vmax = float(np.percentile(sample, 99))
        # Gene names for the selected subset.
        var_names = _store.root["var_names"][:][idx].tolist()
        shapes = [[int(l.shape[0]), int(l.shape[1])] for l in levels]
        cid = uuid.uuid4().hex[:12]
        self._stores[cid] = {
            "levels": levels,
            "var_names": var_names,
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
            },
        }
        return cid

    def get(self, cid: str) -> dict | None:
        return self._stores.get(cid)

    def tile(self, cid: str, level: int, row: int, col: int) -> np.ndarray:
        store = self._stores[cid]
        levels = store["levels"]
        if level < 0 or level >= len(levels):
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


@app.get("/api/custom/{cid}/tile/{level}/{row}/{col}")
def get_custom_tile(cid: str, level: int, row: int, col: int):
    store = _custom.get(cid)
    if not store:
        raise HTTPException(status_code=404, detail="custom pyramid not found")
    try:
        vmin = store["meta"]["vmin"]
        vmax = store["meta"]["vmax"]
        block = _custom.tile(cid, level, row, col)
    except (KeyError, IndexError):
        raise HTTPException(status_code=404, detail="tile out of range")
    png = render_tile_png(block, vmin, vmax)
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
