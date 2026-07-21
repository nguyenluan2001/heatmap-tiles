import axios from 'axios'

/** Shape of the pyramid metadata returned by GET /api/meta. */
export interface PyramidMeta {
    n_cells: number
    n_genes: number
    tile_size: number
    n_levels: number
    /** [level] -> [height, width] of the full matrix at that level. */
    levels: [number, number][]
    vmin: number
    vmax: number
    layer: string
    colormap: string
}

/** Cell-level metadata returned by GET /api/obs. */
export interface ObsData {
    cell_ids: string[]
    louvain?: string[]
    umap?: [number, number][]
}

const http = axios.create({
    baseURL: '/api',
    timeout: 30000,
})

export async function fetchMeta(): Promise<PyramidMeta> {
    const { data } = await http.get<PyramidMeta>('/meta')
    return data
}

export async function fetchObs(): Promise<ObsData> {
    const { data } = await http.get<ObsData>('/obs')
    return data
}

export async function fetchVar(): Promise<{ var_names: string[] }> {
    const { data } = await http.get<{ var_names: string[] }>('/var')
    return data
}

export async function fetchValue(
    cell: number,
    gene: number,
): Promise<{ cell: number; gene: number; value: number }> {
    const { data } = await http.get(`/value/${cell}/${gene}`)
    return data
}

/** Build the URL for a single tile PNG. Using a direct URL (not axios) lets
 *  deck.gl's BitmapLayer manage image loading + caching efficiently. */
export function tileUrl(level: number, row: number, col: number): string {
    return `/api/tile/${level}/${row}/${col}`
}

/* ------------------------------------------------------------------ */
/* Custom pyramid (gene subset selection)                              */
/* ------------------------------------------------------------------ */

/** Response from POST /api/custom — includes the custom pyramid id + meta. */
export interface CustomPyramidResponse extends PyramidMeta {
    id: string
    gene_indices: number[]
}

/** Build a custom sub-matrix pyramid for the given gene indices.
 *  Returns the pyramid id + metadata. */
export async function createCustomPyramid(
    geneIndices: number[],
): Promise<CustomPyramidResponse> {
    const { data } = await http.post<CustomPyramidResponse>('/custom', {
        gene_indices: geneIndices,
    })
    return data
}

/** Fetch the gene names for a custom pyramid (the selected subset, in order). */
export async function fetchCustomVar(
    cid: string,
): Promise<{ var_names: string[] }> {
    const { data } = await http.get<{ var_names: string[] }>(
        `/custom/${cid}/var`,
    )
    return data
}

/** Build the URL for a custom pyramid tile PNG. */
export function customTileUrl(
    cid: string,
    level: number,
    row: number,
    col: number,
): string {
    return `/api/custom/${cid}/tile/${level}/${row}/${col}`
}
