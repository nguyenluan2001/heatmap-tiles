"""Pre-render the zarr pyramid into static grayscale PNG tiles on disk.

Per the architecture specification (Rule #1: NO Dynamic PNG Rendering on
Backend API), all image tiles MUST be static PNG files pre-generated during
pipeline processing. The API server only acts as a static file server / CDN
proxy.

This script reads the zarr pyramid built by ``build_pyramid`` and slices every
level into 256x256 8-bit grayscale PNGs, writing them to:

    /tiles/{dataset_id}/{level}/{row}_{col}.png

Edge tiles are padded with ``0`` (null/padding) so every PNG has complete
256x256 bounds — the GPU shader discards ``0`` pixels.

Usage
-----
    uv run python -m backend.generate_pyramid
    uv run python -m backend.generate_pyramid --zarr data/heatmap.zarr --out tiles
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import zarr

try:
    from .config import TILE_SIZE, ZARR_PATH
    from .tile_render import render_tile_png
except ImportError:  # allow running as a plain script: python backend/generate_pyramid.py
    from config import TILE_SIZE, ZARR_PATH
    from tile_render import render_tile_png


def generate(
    zarr_path: Path = ZARR_PATH,
    out_dir: Path | None = None,
    dataset_id: str = "default",
    tile_size: int = TILE_SIZE,
) -> dict:
    """Pre-render all pyramid levels into static grayscale PNG tiles.

    Returns a summary dict with the number of tiles written per level.
    """
    if out_dir is None:
        out_dir = zarr_path.parent / "tiles"
    root = zarr.open(str(zarr_path), mode="r")
    with open(zarr_path / "meta.json") as f:
        meta = json.load(f)

    n_levels = meta["n_levels"]
    vmin = float(meta["vmin"])
    vmax = float(meta["vmax"])
    base = out_dir / dataset_id
    # Wipe any stale tiles from a previous orientation / build so the
    # directory only contains tiles matching the current pyramid. Without
    # this, regenerated tiles mix with old-orientation tiles and the client
    # may serve wrong-content or extra tiles.
    if base.exists():
        import shutil

        shutil.rmtree(base)
    base.mkdir(parents=True, exist_ok=True)

    summary = {"dataset_id": dataset_id, "out_dir": str(base), "levels": []}
    total = 0
    for level in range(n_levels):
        key = f"level_{level}"
        if key not in root:
            continue
        arr = root[key]
        h, w = arr.shape
        n_rows = int(np.ceil(h / tile_size))
        n_cols = int(np.ceil(w / tile_size))
        level_dir = base / str(level)
        level_dir.mkdir(parents=True, exist_ok=True)

        n_written = 0
        for r in range(n_rows):
            r0 = r * tile_size
            r1 = min(r0 + tile_size, h)
            for c in range(n_cols):
                c0 = c * tile_size
                c1 = min(c0 + tile_size, w)
                block = np.asarray(arr[r0:r1, c0:c1], dtype=np.float32)
                # Pad to full tile size with NaN -> rendered as 0 (null).
                if block.shape != (tile_size, tile_size):
                    padded = np.full((tile_size, tile_size), np.nan, dtype=np.float32)
                    padded[: r1 - r0, : c1 - c0] = block
                    block = padded
                png = render_tile_png(block, vmin, vmax)
                tile_path = level_dir / f"{r}_{c}.png"
                tile_path.write_bytes(png)
                n_written += 1
        print(f"[generate] level {level}: {h}x{w} -> {n_rows}x{n_cols} tiles ({n_written} written)")
        total += n_written
        summary["levels"].append(
            {
                "level": level,
                "shape": [int(h), int(w)],
                "n_tiles": n_written,
                "n_rows": n_rows,
                "n_cols": n_cols,
            }
        )

    # Write a manifest so the static server / client knows the layout.
    manifest = {
        "dataset_id": dataset_id,
        "tile_size": tile_size,
        "n_levels": n_levels,
        "levels": summary["levels"],
        "vmin": vmin,
        "vmax": vmax,
        "groups": meta.get("groups", []),
        "n_cells": meta.get("n_cells"),
        "n_genes": meta.get("n_genes"),
    }
    with open(base / "manifest.json", "w") as f:
        json.dump(manifest, f, indent=2)

    summary["total_tiles"] = total
    print(f"[generate] done: {total} tiles -> {base}")
    return summary


def main():
    p = argparse.ArgumentParser(
        description="Pre-render zarr pyramid into static grayscale PNG tiles."
    )
    p.add_argument("--zarr", type=Path, default=ZARR_PATH, help="Path to the zarr pyramid store.")
    p.add_argument(
        "--out", type=Path, default=None, help="Output directory (default: <zarr_parent>/tiles)."
    )
    p.add_argument(
        "--dataset-id", type=str, default="default", help="Dataset id subdirectory under --out."
    )
    p.add_argument("--tile-size", type=int, default=TILE_SIZE)
    args = p.parse_args()
    generate(args.zarr, args.out, args.dataset_id, args.tile_size)


if __name__ == "__main__":
    main()
