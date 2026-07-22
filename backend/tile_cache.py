"""Disk-backed LRU cache for rendered PNG tiles.

Phase 5 of the 20M-cell plan: the dynamic tile server renders PNGs on-the-fly
from the zarr pyramid. A disk LRU cache (via ``diskcache``) keeps recently
rendered tiles so that zoom/pan doesn't re-render the same tile repeatedly.

The cache is bounded by ``CACHE_MAX_SIZE`` bytes and evicts least-recently-used
entries when full. Tiles expire after ``CACHE_TTL`` seconds.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, Optional

try:
    import diskcache
except ImportError:  # pragma: no cover - optional dependency
    diskcache = None

try:
    from .config import CACHE_DIR, CACHE_MAX_SIZE, CACHE_TTL
except ImportError:  # allow running as a plain script
    from config import CACHE_DIR, CACHE_MAX_SIZE, CACHE_TTL


class TileCache:
    """Thin wrapper around ``diskcache.Cache`` with a graceful no-op fallback
    when ``diskcache`` is not installed."""

    def __init__(
        self, cache_dir: Path = CACHE_DIR, size_limit: int = CACHE_MAX_SIZE, ttl: int = CACHE_TTL
    ):
        self.enabled = diskcache is not None
        self.ttl = ttl
        if self.enabled:
            cache_dir.mkdir(parents=True, exist_ok=True)
            self._cache = diskcache.Cache(str(cache_dir), size_limit=size_limit)
        else:
            self._cache = None

    def get(self, key: str) -> Optional[bytes]:
        """Return cached PNG bytes for ``key`` or ``None`` on miss."""
        if not self.enabled:
            return None
        return self._cache.get(key)

    def set(self, key: str, png: bytes) -> None:
        """Store rendered PNG bytes under ``key``."""
        if not self.enabled:
            return
        self._cache.set(key, png, expire=self.ttl)

    def get_or_render(self, key: str, render_fn: Callable[[], bytes]) -> bytes:
        """Return the cached PNG for ``key``, rendering it via ``render_fn`` on
        a miss and storing the result."""
        if not self.enabled:
            return render_fn()
        png = self.get(key)
        if png is None:
            png = render_fn()
            self.set(key, png)
        return png

    def stats(self) -> dict:
        """Return cache hit/miss/size statistics."""
        if not self.enabled:
            return {"enabled": False}
        return {
            "enabled": True,
            "size": self._cache.volume(),
            "count": len(self._cache),
            "limit": self._cache.size_limit,
        }

    def close(self) -> None:
        if self._cache is not None:
            self._cache.close()


# Module-level singleton used by the server.
tile_cache = TileCache()
