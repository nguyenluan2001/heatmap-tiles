import { BitmapLayer } from '@deck.gl/layers'

import { tileUrl } from './api'
import type { PyramidMeta } from './api'

/** Function that builds a tile PNG URL from (level, row, col). */
export type TileUrlFn = (level: number, row: number, col: number) => string

/** A single visible tile with its world-space bounds (4 corners). */
export interface VisibleTile {
    level: number
    row: number
    col: number
    bounds: [[number, number], [number, number], [number, number], [number, number]]
}

/**
 * Compute which tiles are visible in the current viewport and which pyramid
 * level best matches the zoom.
 *
 * World coordinate system: the matrix occupies [0, n_genes] × [0, n_cells]
 * (y increases downward). At viewport zoom z, 1 world unit = 2^z pixels, so
 * the visible world span is (viewportSize / 2^z).
 *
 * Level selection: at level L the matrix is downsampled by 2^L, so one
 * level-L cell spans 2^L world units = 2^(z+L) screen pixels. We want ~1
 * screen pixel per cell, i.e. z + L ≈ 0  =>  L ≈ -z (clamped to [0, maxLevel]).
 */
export function computeVisibleTiles(
    meta: PyramidMeta,
    target: [number, number, number],
    zoom: number,
    width: number,
    height: number,
): VisibleTile[] {
    const { n_genes: W, n_cells: H, tile_size: TILE, levels, n_levels } = meta
    const maxLevel = n_levels - 1

    // Visible world rectangle (clamped to the matrix bounds).
    const visW = width / Math.pow(2, zoom)
    const visH = height / Math.pow(2, zoom)
    const west = target[0] - visW / 2
    const east = target[0] + visW / 2
    const north = target[1] - visH / 2
    const south = target[1] + visH / 2

    // Pick the pyramid level for this zoom. We floor (not round) so we prefer
    // finer levels — a slightly-too-fine tile downscaled by the GPU with
    // nearest filtering stays crisp, whereas a coarser tile looks blurry.
    let level = Math.floor(-zoom)
    level = Math.max(0, Math.min(maxLevel, level))

    const [h, w] = levels[level]
    const nRows = Math.ceil(h / TILE)
    const nCols = Math.ceil(w / TILE)

    // World size of one tile at this level. At level 0, 1 cell = 1 world
    // unit, so a tile spans TILE world units. Each level halves the
    // resolution, so at level L a tile spans TILE * 2^L world units.
    const downsample = Math.pow(2, level)
    const tileWorldW = TILE * downsample
    const tileWorldH = TILE * downsample

    // Visible tile index range (clamped to valid tiles). Add a +2 buffer
    // on both edges so partially-visible tiles are always included. This
    // accounts for float rounding and tiles that are just off-screen.
    const minCol = Math.max(0, Math.floor(west / tileWorldW) - 1)
    const maxCol = Math.min(nCols - 1, Math.floor(east / tileWorldW) + 2)
    const minRow = Math.max(0, Math.floor(north / tileWorldH) - 1)
    const maxRow = Math.min(nRows - 1, Math.floor(south / tileWorldH) + 2)

    const tiles: VisibleTile[] = []
    for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
            // Use the FULL tile bounds (not clamped to matrix). The PNG is
            // NaN-padded beyond the data, so the transparent padding renders
            // harmlessly outside the matrix. This ensures the data pixels
            // map 1:1 to their correct world positions (e.g. row 10's 78
            // data cells map to the top 78/256 of the tile, not stretched
            // across the whole 78-unit clamped region).
            const x0 = c * tileWorldW
            const y0 = r * tileWorldH
            const x1 = (c + 1) * tileWorldW
            const y1 = (r + 1) * tileWorldH
            tiles.push({
                level,
                row: r,
                col: c,
                // 4-corner bounds: [topLeft, topRight, bottomRight, bottomLeft]
                bounds: [
                    [x0, y0],
                    [x1, y0],
                    [x1, y1],
                    [x0, y1],
                ],
            })
        }
    }
    return tiles
}

/**
 * Build an array of BitmapLayers, one per visible tile. We preload each
 * tile PNG as an HTMLImageElement and pass it to BitmapLayer, which is more
 * reliable than passing a URL string (which depends on deck.gl's async
 * image prop handling).
 */
export function createTileLayers(
    tiles: VisibleTile[],
    urlFn: TileUrlFn = tileUrl,
    idPrefix = 'tile',
) {
    return tiles.map(
        (t) =>
            new BitmapLayer({
                id: `${idPrefix}-${t.level}-${t.row}-${t.col}`,
                image: urlFn(t.level, t.row, t.col),
                bounds: t.bounds,
                // Nearest filtering keeps each cell-gene a crisp square instead
                // of blurring neighbours together.
                textureParameters: {
                    minFilter: 'nearest',
                    magFilter: 'nearest',
                },
            }),
    )
}
