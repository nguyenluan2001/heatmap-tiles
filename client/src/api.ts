import axios from "axios";

/** A cluster group (contiguous run of cells sharing a cluster label). */
export interface GroupConfig {
  id: string;
  size: number;
}

/** Shape of the pyramid metadata returned by GET /api/meta. */
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

/** Cell-level metadata returned by GET /api/obs (full, small datasets) or
 *  GET /api/obs/range (lazy, large datasets). */
export interface ObsData {
  cell_ids: string[];
  louvain?: string[];
  umap?: [number, number][];
  /** Range bounds (only present for /api/obs/range responses). */
  start?: number;
  end?: number;
}

const http = axios.create({
  baseURL: "/api",
  timeout: 30000,
});

export async function fetchMeta(): Promise<PyramidMeta> {
  const { data } = await http.get<PyramidMeta>("/meta");
  return data;
}

export async function fetchObs(): Promise<ObsData> {
  const { data } = await http.get<ObsData>("/obs");
  return data;
}

/** Fetch cell metadata for a half-open range [start, end) — for lazy axis
 *  label fetching on large datasets. Only the cells visible in the current
 *  viewport are requested, keeping browser memory bounded. */
export async function fetchObsRange(
  start: number,
  end: number,
): Promise<ObsData> {
  const { data } = await http.get<ObsData>("/obs/range", {
    params: { start, end },
  });
  return data;
}

export async function fetchVar(): Promise<{ var_names: string[] }> {
  const { data } = await http.get<{ var_names: string[] }>("/var");
  return data;
}

/** Fetch the cluster groups (id + size) for the SpatialLayout. */
export async function fetchGroups(): Promise<{ groups: GroupConfig[] }> {
  const { data } = await http.get<{ groups: GroupConfig[] }>("/groups");
  return data;
}

export async function fetchValue(
  cell: number,
  gene: number,
): Promise<{ cell: number; gene: number; value: number }> {
  const { data } = await http.get(`/value/${cell}/${gene}`);
  return data;
}

/**
 * Build the URL for a single tile PNG. For large datasets (>1M cells) we use
 * the dynamic zarr-backed endpoint (/api/tile/...) which renders tiles
 * on-the-fly and caches them on disk. For small datasets the static
 * pre-rendered path (/tiles/...) may be used (set HEATMAP_STATIC_TILES=1 on
 * the backend). Using a direct URL (not axios) lets deck.gl's BitmapLayer
 * manage image loading + caching efficiently.
 *
 * The dynamic flag is read from /api/meta once and cached here.
 */
let _useDynamicTiles = true;

/** Set whether to use dynamic tiles (called after fetching meta / health). */
export function setUseDynamicTiles(dynamic: boolean): void {
  _useDynamicTiles = dynamic;
}

export function tileUrl(level: number, row: number, col: number): string {
  if (_useDynamicTiles) {
    return `/api/tile/${level}/${row}/${col}`;
  }
  return `/tiles/${level}/${row}_${col}.png`;
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
  });
  return data;
}

/** Fetch the gene names for a custom pyramid (the selected subset, in order). */
export async function fetchCustomVar(
  cid: string,
): Promise<{ var_names: string[] }> {
  const { data } = await http.get<{ var_names: string[] }>(
    `/custom/${cid}/var`,
  );
  return data;
}

/** Build the URL for a custom pyramid tile PNG (always dynamic). */
export function customTileUrl(
  cid: string,
  level: number,
  row: number,
  col: number,
): string {
  return `/api/custom/${cid}/tile/${level}/${row}/${col}`;
}
