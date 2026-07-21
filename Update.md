You can copy the content below directly into a new file named **`INSTRUCTIONS_AI_AGENT.md`** to serve as guidance documentation for AI Agents:

```markdown
# 🧬 Technical Specification & AI Agent Instructions: High-Performance Single-Cell Heatmap Architecture

> **STATUS: IMPLEMENTED** — This document reflects the **current, working state** of the codebase as of the latest session. All code examples below are the ACTUAL implementations (not pseudocode). Read this fully before making any changes.

---

## 1. Context & Objective

Target system: Interactive Heatmap for Large-scale Single-Cell RNA-seq (scRNA-seq) / Genomics Matrix.
- **Scale:** ~26,000 Genes (Rows/Y-axis) × ~50,000 Cells (Columns/X-axis) [test dataset].
- **Production target:** 20,000 Genes × 4,000,000 Cells.
- **Grouping:** Cells are grouped into ordered Clusters along the X-axis, sorted **descending by cluster size** (largest cluster first).
- **Performance Targets:** 60 FPS rendering, < 50ms tile response, < 200 MB Browser Memory usage.
- **UI Interaction:** Seamless zoom from full Cluster overview down to single-cell resolution, dynamic Cluster Gaps, instant Color Map switching, cluster annotation labels, gene selection for custom sub-heatmaps.

---

## 2. System Architecture Blueprint

```
┌───────────────────────────────────────────────────────────────────────────┐
│ BACKEND: Zarr Pyramid + Static Pre-rendered Grayscale Tile PNGs           │
│ - build_pyramid.py: Scanpy → sorted by cluster (desc) → Zarr pyramid      │
│ - generate_pyramid.py: Zarr → 256×256 8-bit grayscale PNG tiles on disk   │
│ - server.py: FastAPI static file server + custom pyramid builder           │
│ - Matrix orientation: (n_genes, n_cells) — rows=genes, cols=cells          │
│ - Encoding: gray = norm * 254 + 1  (bytes 1..255; 0 = null/padding)        │
└─────────────────────────────────────────────┬─────────────────────────────┘
│ Static HTTP GET /tiles/{level}/{row}_{col}.png
▼
┌───────────────────────────────────────────────────────────────────────────┐
│ FRONTEND: Deck.gl + Custom WebGL Fragment Shader                           │
│ - SpatialLayout.ts: Cluster gap math (raw vs world coordinate mapping)     │
│ - HeatmapTileLayer.ts: Intersection-test tile culling + gap overlay masks   │
│ - GroupedHeatmapLayer.ts: BitmapLayer subclass with LUT color shader       │
│ - AxisLabels.ts: Cluster annotation ticks + labels + axis labels           │
│ - HeatmapView.tsx: React UI, gap slider, palette switcher, gene picker      │
│ - Shader: byte 1..255 → LUT 0..1 (CRITICAL — see §6.3)                     │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Project File Structure

```
heatmap-tiles/
├── run.sh                    # Launch script (kills stale ports, starts backend+frontend)
├── pyproject.toml            # Python deps (fastapi, zarr, PIL, scanpy, uvicorn)
├── backend/
│   ├── build_pyramid.py      # h5ad → Zarr pyramid (cluster-sorted, transposed)
│   ├── generate_pyramid.py  # Zarr → static grayscale PNG tiles on disk
│   ├── server.py            # FastAPI: static tiles + /api/meta + custom pyramids
│   ├── tile_render.py       # render_tile_png(): expression → 8-bit grayscale
│   ├── colormap.py          # Backend LUT (for potential server-side rendering)
│   └── config.py            # Paths, ports, dataset config
├── client/
│   ├── package.json         # deps: deck.gl, luma.gl, react, vite
│   ├── vite.config.ts       # Dev server proxy /tiles → backend
│   └── src/
│       ├── App.tsx          # Root component
│       ├── HeatmapView.tsx  # Main view: DeckGL, controls, state management
│       ├── SpatialLayout.ts # Cluster gap math (groupRawStarts vs groupWorldStarts)
│       ├── HeatmapTileLayer.ts # computeVisibleTiles + createTileLayers + gap overlays
│       ├── GroupedHeatmapLayer.ts # BitmapLayer subclass with custom fragment shader
│       ├── AxisLabels.ts    # Cluster annotation layers + axis label layers
│       ├── colormap.ts      # Multi-palette LUT data (Viridis, Magma, Plasma, Inferno)
│       ├── api.ts           # API fetchers + tileUrl() + types
│       ├── PickingLayer.ts  # Hover/click picking layer
│       └── GenePicker.tsx   # Gene search + selection UI
└── data/
    ├── heatmap.zarr/        # Zarr pyramid (levels, cell_order, groups, meta.json)
    └── tiles/default/       # Static PNG tiles + manifest.json
```

---

## 4. Backend Implementation

### 4.1. Data Pipeline (`build_pyramid.py`)

Builds a Zarr pyramid from an AnnData h5ad file. Key details:

1. **Matrix Transposition:** The matrix is stored as **(n_genes, n_cells)** — genes are rows (Y-axis), cells are columns (X-axis). This is the OPPOSITE of the original spec. All downstream code must respect this.

2. **Cluster Sorting (descending by size):**
```python
def _cluster_order(adata) -> np.ndarray:
    obs = adata.obs
    for col in ("louvain", "Louvain clustering (resolution=5.0)", "m1"):
        if col in obs.columns:
            labels = obs[col].astype(str).to_numpy()
            unique, inverse, counts = np.unique(
                labels, return_inverse=True, return_counts=True
            )
            cluster_rank = np.argsort(-counts, kind="stable")  # DESCENDING
            label_to_rank = np.empty(len(unique), dtype=np.int64)
            label_to_rank[cluster_rank] = np.arange(len(unique))
            rank_per_cell = label_to_rank[inverse]
            return np.argsort(rank_per_cell, kind="stable")
    return np.arange(adata.n_obs)
```

3. **Pyramid Levels:** Level 0 = full resolution. Each level downsamples by factor 2 along the cells (X) dimension only. Genes (Y) are NOT downsampled.

4. **Metadata:** `meta.json` in the Zarr store contains `levels` (shapes per level), `cell_order` (permutation array), and `groups` (cluster id + size).

### 4.2. Static Tile Generation (`generate_pyramid.py`)

Pre-renders the Zarr pyramid into static 256×256 grayscale PNG tiles on disk.

- **Stale tile cleanup:** Before writing new tiles, the old tile directory is removed:
```python
base = out_dir / dataset_id
if base.exists():
    import shutil
    shutil.rmtree(base)
base.mkdir(parents=True, exist_ok=True)
```
This is CRITICAL — without it, stale tiles from a previous orientation/sort order persist and cause rendering bugs.

- **Output:** `data/tiles/default/{level}/{row}_{col}.png` + `manifest.json` (contains level shapes + groups).

### 4.3. Tile Rendering (`tile_render.py`)

Converts a 2D array of expression values to an 8-bit grayscale PNG:

```python
def render_tile_png(values: np.ndarray, vmin: float, vmax: float) -> bytes:
    # ...
    norm = np.clip((safe - vmin) / span, 0.0, 1.0)
    gray = (norm * 254.0 + 1.0).astype(np.uint8)  # 1..255, 0=padding
    gray = np.where(nan_mask, 0, gray).astype(np.uint8)
    # ... encode as PNG
```

**Encoding convention (NON-NEGOTIABLE):**
- Byte `0` = null/padding (discarded by shader)
- Byte `1` = vmin (lowest real expression) → LUT index `0.0`
- Byte `255` = vmax (highest expression) → LUT index `1.0`
- Formula: `gray = norm * 254 + 1`

### 4.4. Server (`server.py`)

FastAPI server that:
- Serves static tiles: `GET /tiles/{level}/{row}_{col}.png`
- Serves metadata: `GET /api/meta` (returns level shapes, groups, n_cells, n_genes)
- Serves dynamic tiles (fallback): `GET /api/tile/{level}/{row}/{col}`
- Builds custom pyramids: `POST /api/custom` (gene subset → in-memory pyramid)
- Serves custom tiles: `GET /api/custom/{cid}/tile/{level}/{row}/{col}`

**Custom pyramid `build()` (transposed matrix):**
```python
def build(self, gene_indices: list[int]) -> str:
    arr0 = _store.array(0)
    n_genes, n_cells = arr0.shape  # (genes, cells) — transposed
    idx = np.asarray(gene_indices, dtype=np.int64)
    sub = np.asarray(arr0[idx, :], dtype=np.float32)  # select ROWS (genes)
```

### 4.5. Launch Script (`run.sh`)

Kills stale processes on ports before starting:
```bash
kill_port() {
  local port="$1"
  local pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  elif command -v fuser >/dev/null 2>&1; then
    pids="$(fuser "$port"/tcp 2>/dev/null | tr -d ' ' || true)"
  fi
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true; sleep 1
  fi
}
kill_port "$HEATMAP_PORT"
kill_port "$FRONTEND_PORT"
```

---

## 5. Frontend Implementation

### 5.1. Layout Engine (`SpatialLayout.ts`)

**CRITICAL:** Maintains TWO separate start arrays to avoid conflation bugs:
- `groupRawStarts`: raw cell indices WITHOUT gaps (0, size0, size0+size1, ...)
- `groupWorldStarts`: world X coordinates WITH gaps (0, s0+gap, s0+s1+2*gap, ...)

```typescript
export class SpatialLayout {
  groupRawStarts: number[] = [];   // 0, size0, size0+size1, ...
  groupWorldStarts: number[] = []; // 0, s0+gap, s0+s1+2*gap, ...
  totalWorldWidth: number = 0;
  totalRawWidth: number = 0;

  constructor(groups: GroupConfig[], gapSize: number) {
    let rawX = 0, worldX = 0;
    for (let i = 0; i < groups.length; i++) {
      this.groupRawStarts.push(rawX);
      this.groupWorldStarts.push(worldX);
      rawX += groups[i].size;
      worldX += groups[i].size + (i < groups.length - 1 ? gapSize : 0);
    }
    this.totalRawWidth = rawX;
    this.totalWorldWidth = worldX;
  }

  // Raw cell column → World X (uses groupRawStarts for binary search,
  // returns groupWorldStarts[i] + offset)
  mapColToWorldX(colIndex: number): number { /* ... */ }

  // World X → nearest raw cell column (uses groupWorldStarts for binary search)
  mapWorldXToCol(worldX: number): number { /* ... */ }

  // Check if a world X coordinate falls in a gap region
  isInGap(worldX: number): boolean { /* ... */ }
}
```

**Why two arrays?** The previous implementation used a single `groupStarts` that mixed raw indices and world offsets, causing tiles to be placed at wrong positions when gaps were non-zero. `mapColToWorldX` must search by raw index but return world coordinates.

### 5.2. Tile Calculation (`HeatmapTileLayer.ts`)

Uses **intersection-test culling** (NOT index arithmetic) to determine visible tiles. This avoids fragile `minCol`/`maxCol` calculations that break with gaps:

```typescript
export function computeVisibleTiles(meta, target, zoom, viewW, viewH, layout) {
  // ... compute level, viewport bounds (west, east, north, south)
  const marginX = tileWorldW * 3;  // 3-tile margin
  const marginY = tileWorldH * 3;

  for (let r = 0; r < nRows; r++) {
    const y0 = r * tileWorldH, y1 = (r + 1) * tileWorldH;
    if (y1 < north - marginY || y0 > south + marginY) continue;
    for (let c = 0; c < nCols; c++) {
      const startCol = c * TILE * downsample;
      const endCol = (c + 1) * TILE * downsample;
      const x0 = layout.mapColToWorldX(startCol);
      const x1 = layout.mapColToWorldX(endCol);
      if (x1 < west - marginX || x0 > east + marginX) continue;
      tiles.push({ level, row: r, col: c, bounds: [[x0,y0],[x1,y0],[x1,y1],[x0,y1]] });
    }
  }
}
```

**Gap Overlay Masks:** SolidPolygonLayer rectangles drawn ON TOP of tiles in gap regions to hide boundary-tile bleed:
```typescript
const GAP_MASK_COLOR: [number, number, number, number] = [13, 17, 23, 255]; // matches --bg

export function createGapOverlayLayers(meta, layout) {
  // For each inter-cluster gap:
  // x0 = layout.mapColToWorldX(rawEnd - 1) + 1
  // x1 = x0 + layout.gapSize
  // SolidPolygonLayer rectangle from (x0, 0) to (x1, totalHeight)
}
```

### 5.3. Custom Fragment Shader (`GroupedHeatmapLayer.ts`) — **MOST CRITICAL FILE**

Extends deck.gl `BitmapLayer` with a custom fragment shader that maps grayscale bytes through a color LUT.

**⚠️ CRITICAL — Shader LUT Mapping (the #1 bug fixed this session):**

The shader must remap byte values `1..255` to LUT range `0..1`. Using the raw normalized texture value directly causes low-expression tiles to render as nearly-invisible dark pixels.

```glsl
void main(void) {
  vec2 uv = vTexCoord;
  // ... coordinate conversion (kept from base BitmapLayer)

  // 1. Fetch raw grayscale byte (0..255) from tile texture
  float grayByte = texture(bitmapTexture, uv).r * 255.0;

  // 2. Discard padding/null pixels (byte 0)
  if (grayByte <= 0.5) {
    discard;
  }

  // 3. Remap byte 1..255 (vmin..vmax) → LUT 0..1
  //    WITHOUT this, byte 1 → 0.0039 → darkest LUT (invisible on dark bg)
  float lutT = clamp((grayByte - 1.0) / 254.0, 0.0, 1.0);

  // 4. Lookup color from LUT texture
  vec4 color = texture(colorMapLUT, vec2(lutT, 0.5));
  fragColor = vec4(color.rgb, color.a * layer.opacity);
}
```

**The bug that was fixed:** Previously the shader did `texture(colorMapLUT, vec2(rawExpression, 0.5))` where `rawExpression` was the 0-1 normalized value. For byte `1` (lowest real expression), this gave `1/255 = 0.0039`, mapping to the darkest viridis color (nearly black on `#0d1117` background). Tiles `192_0`–`192_6` appeared "missing" but were actually rendering as invisible dark pixels. The fix remaps so byte `1` → LUT `0.0` (palette start, still dark but visible) and byte `255` → LUT `1.0` (palette end, bright).

**LUT Texture:** A 256×1 RGBA texture built from `colormap.ts getLutData()`. Switching palettes just swaps this texture (no tile re-fetch). The texture is created asynchronously via `Texture2D` from luma.gl and must be initialized before layers render (see `ensureLutTexture` in HeatmapView.tsx).

### 5.4. Cluster Annotations (`AxisLabels.ts`)

Creates annotation layers above the heatmap:
- **Cluster ticks:** Horizontal underline (LineLayer, `getWidth=8`, `widthUnits="pixels"`) at `y = -tickGap` for each cluster
- **Cluster labels:** TextLayer with cluster id, centered above each cluster, `fontSize = 10 + zoom * 0.5`
- **Vertical guide lines:** Optional lines from tick to heatmap top

```typescript
function clusterColor(id: string): [number, number, number, number] {
  // Hash id → hue → HSL → RGB → [r, g, b, 255]
}

export function createClusterAnnotationLayers(meta, groups, layout, zoom) {
  const tickGap = 2, tickY = -tickGap, labelY = -tickGap - 2;
  // For each group: horizontal tick + vertical guides + centered label
}
```

### 5.5. Main View (`HeatmapView.tsx`)

Key state and logic:

**Active groups source (priority order):**
```typescript
const activeGroups = useMemo(() => {
  if (custom?.groups?.length) return custom.groups;
  if (groups.length) return groups;
  if (meta?.groups?.length) return meta.groups;  // prefer meta.groups
  if (meta) return [{ id: "0", size: meta.n_cells }];
  return [];
}, [custom, groups, meta]);
```

**Fit-once guard (prevents re-fit on every gap slider tweak):**
```typescript
const didInitialFitRef = useRef<string | null>(null);
const fitKey = custom ? `custom-${custom.id}` : "full";

useEffect(() => {
  if (!meta || !activeGroups.length) return;
  if (didInitialFitRef.current === fitKey) return;  // already fitted
  didInitialFitRef.current = fitKey;
  // Fit viewport to gap-aware worldWidth + annotationMargin
}, [meta, activeGroups, fitKey]);
```

**Gap size default:** `useState(8)` (was 0 — clusters need visible gaps).

**Layer assembly order (bottom to top):**
1. Tile layers (GroupedHeatmapLayer per visible tile)
2. Gap overlay masks (SolidPolygonLayer)
3. Cluster annotation layers (ticks + labels)
4. Axis label layers
5. Picking layer

---

## 6. Key Guardrails & Non-Negotiable Rules

### 6.1. Static Tile Serving (Rule #1)
All image tiles MUST be static PNG files pre-generated by `generate_pyramid.py`. The API server acts as a static file server. The frontend `tileUrl()` returns `/tiles/{level}/{row}_{col}.png`, NOT a dynamic `/api/tile` endpoint.

### 6.2. GPU-Only Color Mapping (Rule #2)
The backend MUST NEVER output colored tiles. Tiles are 8-bit grayscale. Color mapping is 100% in the frontend WebGL fragment shader via a LUT texture.

### 6.3. Shader LUT Remapping (Rule #3 — CRITICAL)
The shader MUST remap byte `1..255` to LUT `0..1` using `lutT = (grayByte - 1.0) / 254.0`. NEVER use the raw normalized texture value directly as the LUT index — this makes low-expression tiles invisible.

### 6.4. Grayscale Encoding (Rule #4)
- Byte `0` = null/padding (shader discards)
- Byte `1` = vmin (lowest real expression)
- Byte `255` = vmax (highest expression)
- Formula: `gray = norm * 254 + 1`

### 6.5. Raw vs World Coordinates (Rule #5)
`SpatialLayout` must maintain `groupRawStarts` (no gaps) and `groupWorldStarts` (with gaps) as separate arrays. Never conflate them — this causes tiles to be placed at wrong positions.

### 6.6. Stale Tile Cleanup (Rule #6)
`generate_pyramid.py` MUST `shutil.rmtree` the old tile directory before writing new tiles. Without this, stale tiles from a previous orientation/sort persist and cause rendering bugs.

### 6.7. Intersection-Test Tile Culling (Rule #7)
Use intersection testing (iterate all tiles, keep those whose bounds intersect viewport with margin) instead of `minCol`/`maxCol` index arithmetic. Index arithmetic breaks with gaps.

### 6.8. Matrix Orientation (Rule #8)
The matrix is **(n_genes, n_cells)** — transposed from the original spec. Genes are rows (Y-axis), cells are columns (X-axis). All backend slicing must use `arr0[idx, :]` (select rows) for gene subsets, NOT `arr0[:, idx]`.

### 6.9. Fit-Once Guard (Rule #9)
Viewport fit must run ONCE per pyramid when groups load, not on every gap-slider change. Use a `useRef` guard keyed on pyramid identity.

### 6.10. Port Cleanup (Rule #10)
`run.sh` must kill stale processes on `HEATMAP_PORT` and `FRONTEND_PORT` before starting. Otherwise re-running fails with "port already in use".

---

## 7. Build & Run Commands

### 7.1. Build the Zarr Pyramid (from h5ad)
```bash
cd backend && python build_pyramid.py
```

### 7.2. Generate Static Tiles (from Zarr)
```bash
cd backend && python generate_pyramid.py
```

### 7.3. TypeScript Build (client)
```bash
cd client && "$HOME/.bun/bin/bun" ./node_modules/typescript/lib/tsc.js -b --pretty
```
> Note: `npx tsc` and `bun run tsc` may fail on systems with old Node.js. Use the direct path to the TypeScript compiler JS file.

### 7.4. Run the Full Stack
```bash
./run.sh
```
This kills stale ports, starts the FastAPI backend, and starts the Vite dev server.

---

## 8. Known Issues & Lessons Learned

### 8.1. "Missing Tiles" → Actually Invisible Tiles
Tiles `192_0`–`192_6` appeared "missing" but were actually rendering as nearly-invisible dark pixels. Root cause: shader used raw normalized value as LUT index. Fix: remap byte 1..255 → LUT 0..1 (§6.3).

### 8.2. Stale Tiles After Rebuild
After changing matrix orientation or cluster sort order, old tiles persist on disk. Always `shutil.rmtree` before regenerating (§6.6).

### 8.3. Gap Conflation in SpatialLayout
Using a single `groupStarts` array that mixed raw indices and world offsets caused tiles to be placed at wrong positions. Fix: separate `groupRawStarts` and `groupWorldStarts` (§6.5).

### 8.4. Fit Running Before Groups Load
The viewport fit effect must depend on `[meta, activeGroups, fitKey]` and use a ref guard, otherwise it runs before groups are loaded and fits to gapless width.

### 8.5. Boundary Tile Bleed
Tiles at cluster boundaries "bleed" into gap regions when stretched. Fix: gap overlay masks (SolidPolygonLayer rectangles) drawn on top of tiles in gap regions.

### 8.6. TypeScript Compiler on Old Node
`npx tsc` and `bun run tsc` fail on systems with Node.js < 18 (can't parse `??` syntax). Workaround: `"$HOME/.bun/bin/bun" ./node_modules/typescript/lib/tsc.js -b --pretty`.

---

## 9. Execution Checklist for AI Agent

When continuing work on this project:

* [ ] Read this document fully before making any changes.
* [ ] Check `data/heatmap.zarr/meta.json` for current orientation — should be `[n_genes, n_cells]`.
* [ ] Check `data/tiles/default/manifest.json` for tile level shapes — must match Zarr meta.
* [ ] If shapes don't match, regenerate tiles: `cd backend && python generate_pyramid.py`.
* [ ] After any frontend change, verify TypeScript: `cd client && "$HOME/.bun/bin/bun" ./node_modules/typescript/lib/tsc.js -b --pretty`.
* [ ] After any backend change, restart the server: `./run.sh`.
* [ ] NEVER use raw normalized texture value as LUT index — always remap byte 1..255 → 0..1.
* [ ] NEVER conflate raw and world coordinates in SpatialLayout.
* [ ] NEVER skip stale tile cleanup in generate_pyramid.py.
* [ ] NEVER use dynamic `/api/tile` endpoint for static tiles — use `/tiles/{level}/{row}_{col}.png`.

---

## 10. Future Work / TODO

- [ ] **Production scale testing:** Verify with 20K genes × 4M cells.
- [ ] **Tile cache limits:** Configure `maxCacheSize: 500` and `maxCacheByteSize: 64MB` on the TileLayer.
- [ ] **Custom pyramid tile caching:** Custom pyramids currently use dynamic `/api/custom/{cid}/tile/` — consider pre-rendering to static files.
- [ ] **Differential expression:** Highlight genes that differ between clusters.
- [ ] **Brush selection:** Allow users to brush a region and see cell/gene stats.
- [ ] **Export:** Export current view as PNG/SVG.
```
