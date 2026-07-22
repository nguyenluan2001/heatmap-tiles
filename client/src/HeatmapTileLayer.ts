import { Texture } from "@luma.gl/core";
import { PolygonLayer, SolidPolygonLayer } from "@deck.gl/layers";

import { GroupedHeatmapLayer } from "./GroupedHeatmapLayer";
import { SpatialLayout } from "./SpatialLayout";
import { tileUrl } from "./api";
import type { PyramidMeta } from "./api";

/** App background colour (matches --bg in App.css) used to mask gap regions. */
const GAP_MASK_COLOR: [number, number, number, number] = [13, 17, 23, 255];

/** Function that builds a tile PNG URL from (level, row, col). */
export type TileUrlFn = (level: number, row: number, col: number) => string;

/** A single visible tile with its world-space bounds (4 corners) and data extent.
 *
 * The PNG tile is always 256×256 pixels, but edge tiles may contain fewer
 * real data pixels (the rest is byte-0 padding). `dataExtent` gives the
 * fraction [0,1] of the texture that holds real data along each axis, so the
 * shader can remap UVs to fill the world bounds with only the data region.
 */
export interface VisibleTile {
  level: number;
  row: number;
  col: number;
  /** 4-corner world bounds in deck.gl BitmapLayer order:
   *  [bottomLeft, topLeft, topRight, bottomRight]. */
  bounds: [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ];
  /** Fraction of the 256px texture holding real data: [uExtent, vExtent].
   *  Interior tiles are [1,1]; edge tiles are < 1 on the trimmed axis. */
  dataExtent: [number, number];
}

/**
 * Compute which tiles are visible in the current viewport and which pyramid
 * level best matches the zoom, applying cluster-gap offsets via the layout.
 *
 * World coordinate system: the matrix occupies [0, n_cells] × [0, n_genes]
 * (X = cells, Y = genes, y increases downward), with cluster gaps inserted
 * along the X-axis by the {@link SpatialLayout}. At viewport zoom z, 1 world
 * unit = 2^z pixels, so the visible world span is (viewportSize / 2^z).
 *
 * Level selection: at level L the matrix is downsampled by 2^L, so one
 * level-L cell spans 2^L world units = 2^(z+L) screen pixels. We want ~1
 * screen pixel per cell, i.e. z + L ≈ 0 => L ≈ -z (clamped to [0, maxLevel]).
 *
 * Performance (Phase 6 of the 20M-cell plan): instead of iterating ALL tiles
 * at the selected level (O(nRows × nCols) — 6.2M tiles at level 0 for 20M
 * cells, which freezes the browser), we compute the visible tile index range
 * directly from the viewport bounds. The Y axis (genes) is linear so the
 * row range is a direct floor/ceil. The X axis (cells) is linear when there
 * are no cluster gaps; when gaps are present we use a binary search over the
 * layout's group starts to find the first/last tile column intersecting the
 * viewport, then a tight reject loop only over that candidate range. This
 * keeps the work O(visible tiles) instead of O(total tiles).
 *
 * Per Rule #3 (No Matrix Padding Expansion), edge tiles retain standard full
 * bounds coordinates to avoid pixel distortion and aspect-ratio skewing.
 */
export function computeVisibleTiles(
  meta: PyramidMeta,
  target: [number, number, number],
  zoom: number,
  width: number,
  height: number,
  layout?: SpatialLayout,
): VisibleTile[] {
  const { tile_size: TILE, levels, n_levels } = meta;
  const maxLevel = n_levels - 1;

  // Visible world rectangle.
  const visW = width / Math.pow(2, zoom);
  const visH = height / Math.pow(2, zoom);
  const west = target[0] - visW / 2;
  const east = target[0] + visW / 2;
  const north = target[1] - visH / 2;
  const south = target[1] + visH / 2;

  console.log("computeTiles", {
    visW,
    visH,
    west,
    east,
    north,
    south,
  });

  // Pick the pyramid level for this zoom. We floor (not round) so we prefer
  // finer levels — a slightly-too-fine tile downscaled by the GPU with
  // nearest filtering stays crisp, whereas a coarser tile looks blurry.
  let level = Math.floor(-zoom);
  level = Math.max(0, Math.min(maxLevel, level));

  // Cap the level so the gene (row) dimension doesn't collapse below 1.
  // Each level halves the resolution, so the max level that keeps at least
  // 1 gene row is floor(log2(n_genes)). Without this cap, a custom pyramid
  // with 3 genes would show level 2+ where genes are merged into 0-1 rows,
  // causing axis labels to overlap.
  const nGenes = levels[0][0];
  if (nGenes > 0 && nGenes < TILE) {
    const maxGeneLevel = Math.floor(Math.log2(nGenes));
    level = Math.min(level, maxGeneLevel);
  }

  const [h, w] = levels[level];
  const nRows = Math.ceil(h / TILE);
  const nCols = Math.ceil(w / TILE);

  // World size of one tile at this level. At level 0, 1 cell = 1 world
  // unit, so a tile spans TILE world units. Each level halves the
  // resolution, so at level L a tile spans TILE * 2^L world units.
  const downsample = Math.pow(2, level);
  const tileWorldW = TILE * downsample;
  const tileWorldH = TILE * downsample;

  // Reject margin: a few tile widths so partially-visible edge tiles are
  // always included even when the viewport fit is slightly off or cluster
  // gaps stretch the world span.
  const marginX = tileWorldW * 3;
  const marginY = tileWorldH * 3;

  // ---- Y axis (genes): linear — compute row range directly ----
  const r0 = Math.max(0, Math.floor((north - marginY) / tileWorldH));
  const r1 = Math.min(nRows - 1, Math.floor((south + marginY) / tileWorldH));

  // ---- X axis (cells): compute column range ----
  // Without a layout (gap = 0) the X axis is linear too, so we can compute
  // the column range directly. With cluster gaps the world X is non-linear,
  // so we binary-search the layout for the first/last tile column whose
  // world bounds intersect [west - marginX, east + marginX], then do a
  // tight reject loop over that candidate range.
  let c0: number;
  let c1: number;
  const hasGapLayout = layout && layout.gapSize > 0 && layout.nGroups > 0;
  if (!hasGapLayout) {
    c0 = Math.max(0, Math.floor((west - marginX) / tileWorldW));
    c1 = Math.min(nCols - 1, Math.floor((east + marginX) / tileWorldW));
  } else {
    // Binary search for the first tile column with worldX >= west - margin.
    c0 = _findFirstTileColInViewport(
      layout,
      west - marginX,
      TILE,
      downsample,
      w,
    );
    c1 = _findLastTileColInViewport(
      layout,
      east + marginX,
      TILE,
      downsample,
      w,
    );
  }
  // Guard against empty ranges.
  if (r0 > r1 || c0 > c1) return [];

  const tiles: VisibleTile[] = [];
  for (let r = r0; r <= r1; r++) {
    const y0 = r * tileWorldH;
    const y1 = (r + 1) * tileWorldH;
    // Data extent along Y (genes/rows): how much of this tile row holds real
    // data vs. NaN padding. Interior rows are full (1.0); the last row may be
    // partial because h is not a multiple of TILE.
    const vExtent = Math.min(1, (h - r * TILE) / TILE);
    for (let c = c0; c <= c1; c++) {
      // X bounds: apply the SpatialLayout gap offset map so tiles are
      // positioned with cluster gaps. When no layout is provided (gap=0),
      // this reduces to the plain tile bounds.
      const startCol = c * TILE * downsample;
      const endCol = (c + 1) * TILE * downsample;
      const x0 = layout ? layout.mapColToWorldX(startCol) : c * tileWorldW;
      const x1 = layout ? layout.mapColToWorldX(endCol) : (c + 1) * tileWorldW;
      // Tight X reject: skip tiles entirely left/right of the viewport.
      if (x1 < west - marginX || x0 > east + marginX) continue;
      // Data extent along X (cells/cols): fraction of the tile that holds real
      // data. Interior tiles are full (1.0); the last column may be partial.
      const uExtent = Math.min(1, (w - c * TILE) / TILE);
      tiles.push({
        level,
        row: r,
        col: c,
        // 4-corner bounds in deck.gl BitmapLayer order:
        // [bottomLeft, topLeft, topRight, bottomRight].
        // World coords: X = cells (right), Y = genes (down).
        bounds: [
          [x0, y1], // bottomLeft
          [x0, y0], // topLeft
          [x1, y0], // topRight
          [x1, y1], // bottomRight
        ],
        dataExtent: [uExtent, vExtent],
      });
    }
  }
  return tiles;
}

/**
 * Binary search for the first tile column (at the given level) whose world-X
 * start is >= ``minWorldX``. Used when cluster gaps make the X axis
 * non-linear, so we can't compute the column range from world bounds directly.
 *
 * Returns a column index in [0, nCols-1]. If no tile reaches ``minWorldX``,
 * returns 0 (the leftmost tile).
 */
function _findFirstTileColInViewport(
  layout: SpatialLayout,
  minWorldX: number,
  tile: number,
  downsample: number,
  w: number,
): number {
  const nCols = Math.ceil(w / tile);
  if (minWorldX <= 0) return 0;
  let lo = 0;
  let hi = nCols - 1;
  let result = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const startCol = mid * tile * downsample;
    const x0 = layout.mapColToWorldX(startCol);
    if (x0 < minWorldX) {
      // This tile starts before the viewport; the answer is at or after mid.
      result = mid + 1 <= nCols - 1 ? mid + 1 : mid;
      lo = mid + 1;
    } else {
      // This tile starts at/after the viewport; it's a candidate, but an
      // earlier tile may also qualify (its end may still reach minWorldX).
      result = mid;
      hi = mid - 1;
    }
  }
  return Math.max(0, Math.min(result, nCols - 1));
}

/**
 * Binary search for the last tile column (at the given level) whose world-X
 * end is <= ``maxWorldX``. Returns a column index in [0, nCols-1].
 */
function _findLastTileColInViewport(
  layout: SpatialLayout,
  maxWorldX: number,
  tile: number,
  downsample: number,
  w: number,
): number {
  const nCols = Math.ceil(w / tile);
  const totalWorld = layout.totalWorldWidth;
  if (maxWorldX >= totalWorld) return nCols - 1;
  let lo = 0;
  let hi = nCols - 1;
  let result = nCols - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const endCol = (mid + 1) * tile * downsample;
    const x1 = layout.mapColToWorldX(Math.min(endCol, layout.totalRawWidth));
    if (x1 > maxWorldX) {
      // This tile ends after the viewport; the answer is at or before mid.
      result = mid - 1 >= 0 ? mid - 1 : mid;
      hi = mid - 1;
    } else {
      // This tile ends at/before the viewport; it's a candidate, but a later
      // tile may also qualify (its start may still be <= maxWorldX).
      result = mid;
      lo = mid + 1;
    }
  }
  return Math.max(0, Math.min(result, nCols - 1));
}

/**
 * Build an array of GroupedHeatmapLayers, one per visible tile. Each layer
 * loads its grayscale PNG tile and maps it through the shared colour LUT
 * texture on the GPU. The LUT texture is shared across all tiles so palette
 * switching is instant.
 */
export function createTileLayers(
  tiles: VisibleTile[],
  colorMapLUT: Texture,
  urlFn: TileUrlFn = tileUrl,
  idPrefix = "tile",
) {
  return tiles.map((t) => {
    // `colorMapLUT` is a custom prop on GroupedHeatmapLayer; cast the props
    // object so TypeScript accepts the extended property set.
    const props = {
      id: `${idPrefix}-${t.level}-${t.row}-${t.col}`,
      image: urlFn(t.level, t.row, t.col),
      bounds: t.bounds,
      colorMapLUT,
      // Data extent (fraction of the 256px texture holding real data) so the
      // shader can remap UVs and fill the world bounds with only the data
      // region, hiding the byte-0 padding on edge tiles.
      dataExtent: t.dataExtent,
      // Nearest filtering keeps each cell-gene a crisp square instead
      // of blurring neighbours together.
      textureParameters: {
        minFilter: "nearest",
        magFilter: "nearest",
      },
    } as any;
    return new GroupedHeatmapLayer(props);
  });
}

/**
 * Build solid-colour mask rectangles that cover the inter-cluster gap regions
 * (and the trailing space after the last cluster) so the heatmap appears
 * cleanly split into clusters.
 *
 * Tiles are static pre-rendered PNGs (Rule #1) and are linearly stretched
 * across their world-X bounds, so a tile that straddles a cluster boundary
 * would otherwise bleed content across the gap. These opaque polygons are
 * drawn ON TOP of the tiles in the exact gap spans to hide that bleed,
 * producing clean empty separators that line up with the cluster
 * annotations.
 *
 * Returns an empty array when there is no layout or the gap size is 0.
 */
export function createGapOverlayLayers(
  meta: PyramidMeta,
  layout: SpatialLayout | undefined,
) {
  if (!layout || layout.gapSize <= 0 || layout.nGroups <= 0) return [];
  const h = meta.n_genes;
  // One rectangle per inter-cluster gap. Each gap spans
  // [groupEnd_world, groupEnd_world + gapSize] in X, full height in Y.
  const polygons: [number, number][][] = [];
  for (let i = 0; i < layout.nGroups - 1; i++) {
    const rawStart = layout.groupRawStarts[i];
    const rawEnd = rawStart + layout.groups[i].size;
    const x0 = layout.mapColToWorldX(rawEnd - 1) + 1;
    const x1 = x0 + layout.gapSize;
    polygons.push([
      [x0, 0],
      [x1, 0],
      [x1, h],
      [x0, h],
    ]);
  }
  if (!polygons.length) return [];
  return [
    new SolidPolygonLayer({
      id: "cluster-gap-mask",
      data: polygons,
      getPolygon: (d: [number, number][]) => d,
      getFillColor: GAP_MASK_COLOR,
      pickable: false,
      // Drawn above tiles but below annotations/picking.
      // deck.gl draws layers in array order; the caller places this between
      // the tile layers and the annotation layers.
    } as any),
  ];
}

/**
 * Build a pickable PolygonLayer that draws a thin border around every visible
 * tile. The fill is fully transparent (so the heatmap shows through) but the
 * polygon is still pickable across its entire area, letting hover anywhere on
 * a tile trigger the tooltip. The stroke is a subtle accent-coloured outline;
 * the hovered tile is highlighted via autoHighlight.
 */
export function createTileBorderLayer(
  tiles: VisibleTile[],
  idPrefix = "tile-border",
) {
  return new PolygonLayer({
    id: idPrefix,
    data: tiles,
    getPolygon: (d: VisibleTile) => d.bounds,
    stroked: true,
    filled: true,
    getFillColor: [0, 0, 0, 0], // transparent fill, but pickable
    getLineColor: [88, 166, 255, 100], // subtle accent border
    getLineWidth: 1,
    lineWidthUnits: "pixels",
    pickable: true,
    autoHighlight: true,
    highlightColor: [88, 166, 255, 40],
    parameters: { depthTest: false },
  });
}
