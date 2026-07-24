/**
 * TileLoader — fetches tile PNGs via POST and manages blob URLs for deck.gl.
 *
 * deck.gl's BitmapLayer expects an `image` prop that is either a URL string
 * or an Image/Texture object. Since we switched all API endpoints to POST,
 * we can no longer use a simple GET URL for tiles. Instead, this loader:
 *   1. POSTs the tile request (level, row, col) to the backend.
 *   2. Receives the PNG as an ArrayBuffer.
 *   3. Creates a temporary blob URL (object URL) for the PNG.
 *   4. Caches the blob URL so repeated requests for the same tile are instant.
 *   5. Revokes old blob URLs (LRU) to prevent memory leaks.
 *
 * The loader returns a Promise<string> (blob URL) which deck.gl can use as
 * the `image` prop. BitmapLayer supports async image loading via the
 * `image` prop when it's a URL string.
 *
 * Integration pattern with React + deck.gl:
 *   - `getSync()` is called synchronously during render to get a cached URL
 *     (or null if not yet loaded). If null, it triggers an async fetch.
 *   - When the fetch completes, the `onLoad` callback fires, which the
 *     component uses to bump a counter and trigger a re-render. On the next
 *     render, `getSync()` returns the now-cached blob URL.
 */

/** Parameters identifying a single tile request. */
export interface TileParams {
  level: number;
  row: number;
  col: number;
}

/** A function that POSTs a tile request and returns the PNG ArrayBuffer. */
export type TileFetchFn = (params: TileParams) => Promise<ArrayBuffer>;

interface CacheEntry {
  url: string; // blob: URL for the PNG
  lastAccess: number; // timestamp for LRU eviction
}

/**
 * LRU cache of blob URLs for tiles fetched via POST.
 *
 * Usage:
 *   const loader = new TileLoader(fetchTile, 2000, () => bumpVersion());
 *   const url = await loader.get({ level: 2, row: 0, col: 3 });
 *   // → "blob:http://localhost:5173/abc-123" (deck.gl BitmapLayer image prop)
 *
 *   // Synchronous access during render:
 *   const cached = loader.getSync({ level: 2, row: 0, col: 3 });
 *   // → cached URL string, or null (triggers async fetch + onLoad callback)
 */
export class TileLoader {
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<string>>();
  private maxEntries: number;
  private fetchFn: TileFetchFn;
  private onLoad?: () => void;

  /**
   * @param fetchFn  Function that POSTs a tile request and returns PNG bytes.
   * @param maxEntries  Max blob URLs to keep in cache (LRU eviction). Each
   *                   entry is ~256KB (256×256 PNG), so 2000 entries ≈ 500MB.
   * @param onLoad  Optional callback fired whenever a NEW tile finishes loading
   *                (not on cache hits). Used to trigger a React re-render so
   *                deck.gl picks up the newly-available blob URL.
   */
  constructor(fetchFn: TileFetchFn, maxEntries = 2000, onLoad?: () => void) {
    this.fetchFn = fetchFn;
    this.maxEntries = maxEntries;
    this.onLoad = onLoad;
  }

  /** Generate a cache key from tile params. */
  private key(p: TileParams): string {
    return `${p.level}/${p.row}/${p.col}`;
  }

  /**
   * Get the blob URL for a tile. If already cached, returns instantly.
   * If a request is in-flight, returns the same promise (dedup).
   * Otherwise, POSTs the request and creates a blob URL.
   */
  async get(params: TileParams): Promise<string> {
    const k = this.key(params);
    const existing = this.cache.get(k);
    if (existing) {
      existing.lastAccess = Date.now();
      return existing.url;
    }

    // Dedup: if a request is already in-flight, wait for it.
    const pending = this.inFlight.get(k);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const buf = await this.fetchFn(params);
        const blob = new Blob([buf], { type: "image/png" });
        const url = URL.createObjectURL(blob);
        this.cache.set(k, { url, lastAccess: Date.now() });
        // LRU eviction: revoke oldest entries if over capacity.
        if (this.cache.size > this.maxEntries) {
          this.evictLRU();
        }
        // Notify the host that a new tile is available (triggers re-render).
        this.onLoad?.();
        return url;
      } finally {
        this.inFlight.delete(k);
      }
    })();

    this.inFlight.set(k, promise);
    return promise;
  }

  /**
   * Get a tile URL synchronously if cached, otherwise trigger an async fetch
   * and return null. The host should use `onLoad` to re-render when the fetch
   * completes, at which point a subsequent `getSync` returns the URL.
   */
  getSync(params: TileParams): string | null {
    const k = this.key(params);
    const entry = this.cache.get(k);
    if (entry) {
      entry.lastAccess = Date.now();
      return entry.url;
    }
    // Not cached — trigger async fetch (dedup prevents duplicate POSTs).
    if (!this.inFlight.has(k)) {
      this.get(params).catch(() => {
        /* ignore — tile will retry next frame */
      });
    }
    return null;
  }

  /** Evict the least-recently-accessed entries until under maxEntries. */
  private evictLRU(): void {
    // Map iteration is in insertion order; find oldest by lastAccess.
    const entries = [...this.cache.entries()].sort(
      (a, b) => a[1].lastAccess - b[1].lastAccess,
    );
    const toEvict = entries.slice(0, entries.length - this.maxEntries);
    for (const [k, entry] of toEvict) {
      URL.revokeObjectURL(entry.url);
      this.cache.delete(k);
    }
  }

  /** Preload a batch of tiles (fire all requests in parallel). */
  async preload(tiles: TileParams[]): Promise<void> {
    await Promise.allSettled(tiles.map((t) => this.get(t)));
  }

  /** Clear all cached blob URLs (e.g., when switching pyramids). */
  clear(): void {
    for (const entry of this.cache.values()) {
      URL.revokeObjectURL(entry.url);
    }
    this.cache.clear();
    this.inFlight.clear();
  }

  /** Number of cached entries. */
  get size(): number {
    return this.cache.size;
  }
}
