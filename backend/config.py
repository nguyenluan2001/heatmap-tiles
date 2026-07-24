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

# Intermediate zarr store used during the out-of-core build pipeline
# (streaming transpose before cluster reordering). Removed after build.
ZARR_INTERIM_PATH = Path(os.environ.get("HEATMAP_ZARR_INTERIM", DATA_DIR / "heatmap_interim.zarr"))

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

# ---------------------------------------------------------------------------
# Out-of-core build pipeline settings (Phase 1-4 of the 20M-cell plan)
# ---------------------------------------------------------------------------

# Number of cells read per chunk during the streaming transpose.
# 50_000 cells x 20_000 genes x float32 = ~4 GB dense block — fits 16 GB RAM.
CELL_CHUNK_SIZE = int(os.environ.get("HEATMAP_CELL_CHUNK", "50000"))

# Zstd compression level for zarr arrays (1=fast, 9=smallest). 3 is a good
# balance for sparse-ish expression data.
ZARR_CLEVEL = int(os.environ.get("HEATMAP_ZARR_CLEVEL", "3"))

# Number of random sample values drawn from level 0 for the approximate
# percentile (vmin/vmax) computation. 10M values gives < 0.1% error at p1/p99.
PERCENTILE_SAMPLE_SIZE = int(os.environ.get("HEATMAP_PERCENTILE_SAMPLE", "10000000"))

# ---------------------------------------------------------------------------
# Tile cache settings (Phase 5 of the 20M-cell plan)
# ---------------------------------------------------------------------------

# Disk LRU cache directory for rendered PNG tiles.
CACHE_DIR = Path(os.environ.get("HEATMAP_CACHE_DIR", DATA_DIR / "tile_cache"))

# Maximum disk cache size in bytes (default 20 GB).
CACHE_MAX_SIZE = int(os.environ.get("HEATMAP_CACHE_GB", "20")) * 1_000_000_000

# Tile cache TTL in seconds (default 24h).
CACHE_TTL = int(os.environ.get("HEATMAP_CACHE_TTL", "86400"))

# Whether to use the dynamic zarr-backed tile endpoint (/api/tile) instead of
# the static pre-rendered PNG tiles (/tiles/...). For large datasets (>1M
# cells) the static path is infeasible (millions of files), so this defaults
# to True. Set HEATMAP_STATIC_TILES=1 to keep the old static-file behaviour
# for small datasets.
USE_DYNAMIC_TILES = os.environ.get("HEATMAP_STATIC_TILES", "0") != "1"

# Threshold (in number of cells) above which the full /api/obs endpoint (which
# loads ALL cell metadata into memory) is disabled in favour of the range-based
# /api/obs/range endpoint. Prevents browser OOM for large datasets.
# OBS_FULL_THRESHOLD = int(os.environ.get("HEATMAP_OBS_FULL_THRESHOLD", "1000000"))
OBS_FULL_THRESHOLD = int(os.environ.get("HEATMAP_OBS_FULL_THRESHOLD", "100000"))

# ---------------------------------------------------------------------------
# PyramidRegistry settings (multi-heatmap support)
# ---------------------------------------------------------------------------

# Directory containing multiple zarr pyramid stores, one per dataset.
# Each subdirectory matching the pattern "<dataset_id>.zarr" (or just a
# subdirectory with a meta.json inside) is treated as a separate heatmap.
# The default heatmap.zarr is registered as dataset_id "default".
REGISTRY_DIR = Path(os.environ.get("HEATMAP_REGISTRY_DIR", DATA_DIR))

# Maximum number of PyramidStore instances kept open simultaneously (LRU).
# Each open store holds zarr array handles + cached metadata (~MB), so
# limiting concurrent opens bounds server memory.
REGISTRY_MAX_OPEN = int(os.environ.get("HEATMAP_REGISTRY_MAX_OPEN", "4"))

# Idle TTL in seconds: a store not accessed for this long is closed (zarr
# handles released) and eligible for LRU eviction. Default 30 minutes.
REGISTRY_TTL = int(os.environ.get("HEATMAP_REGISTRY_TTL", "1800"))
