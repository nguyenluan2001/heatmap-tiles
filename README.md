# Single-cell Heatmap (cellxgene → zarr pyramid → deck.gl)

A full-stack project that turns a cellxgene single-cell AnnData matrix into a
multi-resolution **heatmap pyramid** stored in **zarr**, served as PNG tiles by
a **FastAPI** backend, and visualised interactively (zoom + pan) in the browser
with **deck.gl**.

```
data/TBD_AnnData.h5ad  ──►  backend.build_pyramid  ──►  data/heatmap.zarr
                                                        (8 levels, 256px tiles)
                                                                    │
                                                                    ▼
                              FastAPI  /api/meta  /api/tile/{l}/{r}/{c}
                                                                    │
                                                                    ▼
                          React + deck.gl TileLayer (OrthographicView)
```

## Architecture

### Backend (`backend/`)
| File | Role |
|------|------|
| [`config.py`](backend/config.py) | Paths, tile size, layer key, server host/port |
| [`colormap.py`](backend/colormap.py) | Dependency-free viridis/magma LUT + `values_to_rgba()` |
| [`tile_render.py`](backend/tile_render.py) | Render a 2D float tile → RGBA PNG (via Pillow) |
| [`build_pyramid.py`](backend/build_pyramid.py) | h5ad → zarr pyramid builder (dask 2×2 mean pooling) |
| [`server.py`](backend/server.py) | FastAPI app: `/api/meta`, `/api/tile/{l}/{r}/{c}`, `/api/obs`, `/api/var` |

**Pyramid scheme**
- Level 0 = full matrix (2638 cells × 32310 genes), chunked at 256×256.
- Each higher level = 2×2 mean-pool of the previous level.
- 8 levels total (2638×32310 → 20×252).
- Cells are reordered by louvain cluster so the heatmap shows block structure.
- Value range (1st–99th percentile) stored in `meta.json` for colormap normalisation.

**Tile request**
`GET /api/tile/{level}/{row}/{col}` → reads the 256×256 zarr chunk, NaN-pads to
full tile size, maps through viridis, returns a PNG. Out-of-range tiles → 404.

### Frontend (`client/`)
| File | Role |
|------|------|
| [`src/api.ts`](client/src/api.ts) | axios client + `tileUrl()` |
| [`src/colormap.ts`](client/src/colormap.ts) | Client-side viridis for the legend |
| [`src/HeatmapTileLayer.ts`](client/src/HeatmapTileLayer.ts) | Visible-tile computation → `BitmapLayer` per tile |
| [`src/AxisLabels.ts`](client/src/AxisLabels.ts) | `TextLayer` cell names (Y) + gene names (X), stride-sampled by zoom |
| [`src/HeatmapView.tsx`](client/src/HeatmapView.tsx) | `OrthographicView` + tiles + axis labels + legend + info panel |
| [`src/App.tsx`](client/src/App.tsx) | App shell |
| [`vite.config.ts`](client/vite.config.ts) | Vite dev server + `/api` proxy to backend |

**Coordinate system**: the matrix occupies world rect `[0, n_genes] × [0, n_cells]`
(y down). deck.gl zoom `z` maps to pyramid `level = maxLevel - z`, so zooming in
requests finer tiles.

## Requirements
- Python 3.10+ (managed by **uv**)
- **bun** (for the frontend)
- The h5ad file at `data/TBD_AnnData.h5ad`

## Quick start

### 1. Backend
```bash
# Install Python deps (uv creates a .venv automatically)
uv sync

# Build the zarr pyramid (one-time, ~30s)
uv run python -m backend.build_pyramid

# Start the tile server
uv run uvicorn backend.server:app --host 0.0.0.0 --port 8000
```

### 2. Frontend
```bash
cd client
bun install
bun dev
```

Open http://127.0.0.1:5173 — the Vite dev server proxies `/api/*` to the backend.

## Configuration (env vars)
| Variable | Default | Description |
|----------|---------|-------------|
| `HEATMAP_H5AD` | `data/TBD_AnnData.h5ad` | Input AnnData file |
| `HEATMAP_ZARR` | `data/heatmap.zarr` | Output zarr store |
| `HEATMAP_LAYER` | `log_normalize` | AnnData layer to use (fallback: `X`) |
| `HEATMAP_TILE_SIZE` | `256` | Tile edge length (px) |
| `HEATMAP_COLORMAP` | `viridis` | Server-side colormap |
| `HEATMAP_HOST` / `HEATMAP_PORT` | `0.0.0.0` / `8000` | Server bind address |

## API reference
| Endpoint | Returns |
|----------|---------|
| `GET /` | `{ status: "ok" }` health check |
| `GET /api/meta` | Pyramid metadata (dims, levels, value range) |
| `GET /api/tile/{level}/{row}/{col}` | 256×256 RGBA PNG |
| `GET /api/obs` | Cell ids, louvain, UMAP (after reordering) |
| `GET /api/var` | Gene names |

## Data
The included `data/TBD_AnnData.h5ad` is a 2638-cell × 32310-gene single-cell
dataset with a sparse CSR `X`, a `log_normalize` layer, louvain clustering, and
UMAP/tSNE embeddings.
