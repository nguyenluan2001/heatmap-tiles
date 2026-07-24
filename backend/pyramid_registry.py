"""PyramidRegistry — manages multiple heatmap zarr pyramids.

Each dataset (analysis) is a separate zarr pyramid store on disk. The
registry lazily opens stores on first access, caches open handles (LRU +
TTL), and provides cleanup strategies:

  - **LRU eviction**: when more than ``max_open`` stores are open, the
    least-recently-accessed store is closed (zarr handles released).
  - **TTL expiry**: a store not accessed for ``ttl`` seconds is closed on
    the next access cycle, freeing file handles.
  - **Explicit cleanup**: ``close(dataset_id)`` closes a specific store.
  - **Shutdown cleanup**: ``close_all()`` closes every open store (called
    on app shutdown via FastAPI's lifespan handler).

Directory layout (``REGISTRY_DIR`` = ``data/`` by default)::

    data/
    ├── heatmap.zarr/          → dataset_id = "default" (legacy single-store)
    ├── GSE145926.zarr/        → dataset_id = "GSE145926"
    ├── RP-01KXQQVM0C7A5ZKNDBZKSDRXEY.zarr/  → dataset_id = "RP-01KXQQVM0C7A5ZKNDBZKSDRXEY"
    └── ...

Discovery: any subdirectory ending in ``.zarr`` that contains a
``meta.json`` is registered. The ``dataset_id`` is the directory name
without the ``.zarr`` suffix. The legacy ``heatmap.zarr`` is registered as
``"default"``.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import zarr

try:
    from .config import REGISTRY_DIR, REGISTRY_MAX_OPEN, REGISTRY_TTL, TILE_SIZE
except ImportError:  # allow running as a plain script
    from config import REGISTRY_DIR, REGISTRY_MAX_OPEN, REGISTRY_TTL, TILE_SIZE


class PyramidStore:
    """Lazily open a single zarr pyramid store and cache arrays + metadata.

    This is the same class that was previously defined inline in
    ``server.py``; it has been moved here so the registry can manage
    multiple instances.
    """

    def __init__(self, zarr_path: Path, dataset_id: str = "default"):
        self.zarr_path = zarr_path
        self.dataset_id = dataset_id
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

    def close(self):
        """Release zarr handles and clear caches."""
        self.root = None
        self.meta = None
        self._arrays.clear()


class PyramidRegistry:
    """Registry of multiple heatmap zarr pyramids with LRU + TTL cleanup.

    Usage::

        registry = PyramidRegistry()
        store = registry.get("GSE145926")   # open (or reuse cached) store
        tile = store.tile(2, 0, 3)          # fetch a tile
        registry.close_all()                # shutdown cleanup
    """

    def __init__(
        self,
        registry_dir: Path = REGISTRY_DIR,
        max_open: int = REGISTRY_MAX_OPEN,
        ttl: float = REGISTRY_TTL,
    ):
        self.registry_dir = Path(registry_dir)
        self.max_open = max_open
        self.ttl = ttl
        # dataset_id -> {"store": PyramidStore, "last_access": float}
        self._open: dict[str, dict] = {}
        # dataset_id -> zarr_path (discovered on init; can be refreshed)
        self._paths: dict[str, Path] = {}
        self._discover()

    # ------------------------------------------------------------------
    # Discovery
    # ------------------------------------------------------------------

    def _discover(self):
        """Scan ``registry_dir`` for ``*.zarr`` directories with a meta.json.

        The legacy ``heatmap.zarr`` is registered as ``"default"``.
        """
        self._paths.clear()
        if not self.registry_dir.is_dir():
            return
        for child in sorted(self.registry_dir.iterdir()):
            if not child.is_dir() or not child.name.endswith(".zarr"):
                continue
            if not (child / "meta.json").is_file():
                continue
            ds_id = child.name[: -len(".zarr")]
            # Legacy heatmap.zarr → "default"
            if ds_id == "heatmap":
                ds_id = "default"
            self._paths[ds_id] = child

    def refresh(self):
        """Re-scan the registry directory for new/removed datasets."""
        self._discover()

    def list_datasets(self) -> list[str]:
        """Return all discovered dataset IDs (sorted)."""
        return sorted(self._paths.keys())

    def dataset_path(self, dataset_id: str) -> Path | None:
        """Return the zarr path for a dataset, or None if not found."""
        return self._paths.get(dataset_id)

    # ------------------------------------------------------------------
    # Store access (LRU + TTL)
    # ------------------------------------------------------------------

    def get(self, dataset_id: str | None = None) -> PyramidStore:
        """Return the open ``PyramidStore`` for ``dataset_id``.

        If the store is already open, it is returned immediately (and its
        last-access timestamp is bumped). If not, it is opened and cached.
        If ``dataset_id`` is None or "default", the legacy single-store
        path is used.

        Raises ``KeyError`` if the dataset is not found on disk.
        """
        # Normalise: None → "default"
        ds_id = dataset_id or "default"

        # Refresh discovery if the dataset is unknown (maybe just built).
        if ds_id not in self._paths:
            self._discover()

        path = self._paths.get(ds_id)
        if path is None:
            raise KeyError(f"Dataset '{ds_id}' not found. Available: {self.list_datasets()}")

        entry = self._open.get(ds_id)
        if entry is not None:
            entry["last_access"] = time.time()
            return entry["store"]

        # Not open — evict expired stores, then enforce LRU capacity.
        self._evict_expired()
        self._evict_lru()

        store = PyramidStore(path, ds_id)
        store.open()
        self._open[ds_id] = {"store": store, "last_access": time.time()}
        return store

    # ------------------------------------------------------------------
    # Cleanup strategies
    # ------------------------------------------------------------------

    def _evict_expired(self):
        """Close stores that have been idle longer than ``ttl`` seconds."""
        now = time.time()
        expired = [
            ds_id for ds_id, entry in self._open.items() if now - entry["last_access"] > self.ttl
        ]
        for ds_id in expired:
            self._close_entry(ds_id)

    def _evict_lru(self):
        """Close the least-recently-accessed stores until under ``max_open``."""
        while len(self._open) >= self.max_open:
            # Find the oldest entry by last_access.
            oldest_ds = min(self._open, key=lambda k: self._open[k]["last_access"])
            self._close_entry(oldest_ds)

    def _close_entry(self, ds_id: str):
        entry = self._open.pop(ds_id, None)
        if entry:
            entry["store"].close()

    def close(self, dataset_id: str | None = None):
        """Explicitly close a single store (frees zarr handles)."""
        ds_id = dataset_id or "default"
        self._close_entry(ds_id)

    def close_all(self):
        """Close all open stores — call on app shutdown."""
        for ds_id in list(self._open.keys()):
            self._close_entry(ds_id)

    @property
    def open_count(self) -> int:
        """Number of currently-open stores."""
        return len(self._open)

    def stats(self) -> dict:
        """Return registry statistics for /api/cache/stats."""
        return {
            "open_count": len(self._open),
            "max_open": self.max_open,
            "ttl_seconds": self.ttl,
            "datasets_discovered": len(self._paths),
            "datasets": self.list_datasets(),
        }
