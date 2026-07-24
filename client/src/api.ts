import axios from "axios";

/** A cluster group (contiguous run of cells sharing a cluster label). */
export interface GroupConfig {
  id: string;
  size: number;
}

/** Shape of the pyramid metadata returned by POST /api/meta. */
export interface PyramidMeta {
  n_cells: number;
  n_genes: number;
  tile_size: number;
  n_levels: number;
  /** [level] -> [height, width] of the full matrix at that level. */
  levels: [number, number][];
  vmin: number;
  vmax: number;
  layer: string;
  colormap: string;
  /** Cluster groups for the SpatialLayout (gap math). */
  groups?: GroupConfig[];
}

/** Cell-level metadata returned by POST /api/obs (full, small datasets) or
 *  POST /api/obs/range (lazy, large datasets). */
export interface ObsData {
  cell_ids: string[];
  louvain?: string[];
  umap?: [number, number][];
  /** Range bounds (only present for /api/obs/range responses). */
  start?: number;
  end?: number;
}

/** A discovered dataset (from POST /api/datasets). */
export interface DatasetInfo {
  id: string;
  path: string;
}

const http = axios.create({
  baseURL: "/api",
  timeout: 30000,
});

/**
 * The active dataset ID. All tile/metadata requests include this in the
 * POST body so the backend's PyramidRegistry knows which zarr store to
 * read from. Defaults to "default" (the legacy heatmap.zarr).
 */
let _datasetId: string | null = null;

/** Set the active dataset ID (called when the user selects a heatmap). */
export function setDatasetId(id: string | null): void {
  _datasetId = id;
}

/** Get the active dataset ID (null = "default" on the backend). */
export function getDatasetId(): string | null {
  return _datasetId;
}

/** Build the request body, including dataset_id when set. */
function _body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return _datasetId ? { dataset_id: _datasetId, ...extra } : extra;
}

/** List all available heatmap datasets on the server. */
export async function fetchDatasets(): Promise<{ datasets: DatasetInfo[] }> {
  const { data } = await http.post<{ datasets: DatasetInfo[] }>(
    "/datasets",
    {},
  );
  return data;
}

export async function fetchMeta(): Promise<PyramidMeta> {
  const { data } = await http.post<PyramidMeta>("/meta", _body());
  return data;
}

export async function fetchObs(): Promise<ObsData> {
  const { data } = await http.post<ObsData>("/obs", _body());
  return data;
}

/** Fetch cell metadata for a half-open range [start, end) — for lazy axis
 *  label fetching on large datasets. Only the cells visible in the current
 *  viewport are requested, keeping browser memory bounded. */
export async function fetchObsRange(
  start: number,
  end: number,
): Promise<ObsData> {
  const { data } = await http.post<ObsData>(
    "/obs/range",
    _body({ start, end }),
  );
  return data;
}

export async function fetchVar(): Promise<{ var_names: string[] }> {
  const { data } = await http.post<{ var_names: string[] }>("/var", _body());
  return data;
}

/** Fetch the cluster groups (id + size) for the SpatialLayout. */
export async function fetchGroups(): Promise<{ groups: GroupConfig[] }> {
  const { data } = await http.post<{ groups: GroupConfig[] }>(
    "/groups",
    _body(),
  );
  return data;
}

export async function fetchValue(
  cell: number,
  gene: number,
): Promise<{ cell: number; gene: number; value: number }> {
  const { data } = await http.post(`/value`, _body({ cell, gene }));
  return data;
}

/**
 * Fetch a single tile PNG via POST. Returns the raw PNG bytes as an
 * ArrayBuffer so the TileLoader can create a blob URL for deck.gl.
 *
 * For large datasets (>1M cells) we use the dynamic zarr-backed endpoint
 * (/api/tile) which renders tiles on-the-fly and caches them on disk.
 * For small datasets the static pre-rendered path (/tiles/...) may be used
 * (set HEATMAP_STATIC_TILES=1 on the backend).
 *
 * The dynamic flag is read from /api/meta once and cached here.
 */
let _useDynamicTiles = true;

/** Set whether to use dynamic tiles (called after fetching meta / health). */
export function setUseDynamicTiles(dynamic: boolean): void {
  _useDynamicTiles = dynamic;
}

/**
 * POST a tile request and return the PNG as an ArrayBuffer.
 * Used by TileLoader to create blob URLs for deck.gl BitmapLayer.
 */
export async function fetchTileArrayBuffer(
  level: number,
  row: number,
  col: number,
): Promise<ArrayBuffer> {
  if (!_useDynamicTiles) {
    // Static tiles: fall back to GET (legacy path).
    const resp = await fetch(`/tiles/${level}/${row}_${col}.png`);
    if (!resp.ok) throw new Error(`tile ${level}/${row}/${col} not found`);
    return await resp.arrayBuffer();
  }
  const resp = await http.post("/tile", _body({ level, row, col }), {
    responseType: "arraybuffer",
  });
  return resp.data as ArrayBuffer;
}

/* ------------------------------------------------------------------ */
/* Custom pyramid (gene subset selection)                              */
/* ------------------------------------------------------------------ */

/** Response from POST /api/custom — includes the custom pyramid id + meta. */
export interface CustomPyramidResponse extends PyramidMeta {
  id: string;
  gene_indices: number[];
}

/** Build a custom sub-matrix pyramid for the given gene indices.
 *  Returns the pyramid id + metadata. */
export async function createCustomPyramid(
  geneIndices: number[],
): Promise<CustomPyramidResponse> {
  const { data } = await http.post<CustomPyramidResponse>("/custom", {
    gene_indices: geneIndices,
    dataset_id: _datasetId ?? undefined,
  });
  return data;
}

/** Fetch the gene names for a custom pyramid (the selected subset, in order). */
export async function fetchCustomVar(
  cid: string,
): Promise<{ var_names: string[] }> {
  const { data } = await http.post<{ var_names: string[] }>("/custom/var", {
    cid,
  });
  return data;
}

/**
 * POST a custom pyramid tile request and return the PNG as an ArrayBuffer.
 * Used by TileLoader to create blob URLs for deck.gl BitmapLayer.
 */
export async function fetchCustomTileArrayBuffer(
  cid: string,
  level: number,
  row: number,
  col: number,
): Promise<ArrayBuffer> {
  const resp = await http.post(
    "/custom/tile",
    { cid, level, row, col },
    { responseType: "arraybuffer" },
  );
  return resp.data as ArrayBuffer;
}
