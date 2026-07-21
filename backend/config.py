"""Central configuration for the heatmap backend.

All paths are resolved relative to the project root so the package can be
imported regardless of the current working directory.
"""

from __future__ import annotations

import os
from pathlib import Path

# Project root = parent of the backend/ package directory.
BASE_DIR = Path(__file__).resolve().parent.parent

DATA_DIR = BASE_DIR / "data"
H5AD_PATH = Path(os.environ.get("HEATMAP_H5AD", DATA_DIR / "TBD_Anndata.h5ad"))
ZARR_PATH = Path(os.environ.get("HEATMAP_ZARR", DATA_DIR / "heatmap.zarr"))

# Edge length (in cells/genes) of a single square tile at every pyramid level.
TILE_SIZE = int(os.environ.get("HEATMAP_TILE_SIZE", "256"))

# Which anndata matrix to turn into a heatmap.
# Priority: this env var -> "log_normalize" layer -> "X".
LAYER_KEY = os.environ.get("HEATMAP_LAYER", "log_normalize")

# Colormap used when rendering tiles server-side.
COLORMAP = os.environ.get("HEATMAP_COLORMAP", "viridis")

# Host/port for the FastAPI dev server.
HOST = os.environ.get("HEATMAP_HOST", "0.0.0.0")
PORT = int(os.environ.get("HEATMAP_PORT", "8000"))
