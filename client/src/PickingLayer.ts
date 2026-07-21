import { SolidPolygonLayer } from "@deck.gl/layers";

import type { PyramidMeta } from "./api";

export interface PickSquare {
  cell: number;
  gene: number;
  polygon: [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ];
}

/**
 * Build a pickable overlay of 1×1 world-space squares for the visible region.
 *
 * Orientation: X axis = cells (columns), Y axis = genes (rows). Each square
 * corresponds to one cell-gene pair at level 0. We only generate squares for
 * the currently visible window (clamped to the matrix bounds) and cap the
 * count to avoid creating millions of polygons when zoomed far out.
 *
 * The squares are fully transparent — they exist only for picking so the
 * tooltip can report which cell/gene the cursor is over.
 */
export function createPickingLayer(
  meta: PyramidMeta,
  target: [number, number, number],
  zoom: number,
  width: number,
  height: number,
): SolidPolygonLayer | null {
  // X axis = cells (n_cells), Y axis = genes (n_genes).
  const { n_genes: H, n_cells: W } = meta;

  // Visible world rectangle.
  const visW = width / Math.pow(2, zoom);
  const visH = height / Math.pow(2, zoom);
  // west/east span the cell (X) axis; north/south span the gene (Y) axis.
  const west = Math.max(0, Math.floor(target[0] - visW / 2));
  const east = Math.min(W, Math.ceil(target[0] + visW / 2));
  const north = Math.max(0, Math.floor(target[1] - visH / 2));
  const south = Math.min(H, Math.ceil(target[1] + visH / 2));

  const nCells = east - west;
  const nGenes = south - north;
  // Cap: if more than ~40k squares, skip picking (too many to render).
  if (nCells * nGenes > 40000) return null;

  const data: PickSquare[] = [];
  // r = gene (Y), c = cell (X).
  for (let r = north; r < south; r++) {
    for (let c = west; c < east; c++) {
      data.push({
        cell: c,
        gene: r,
        polygon: [
          [c, r],
          [c + 1, r],
          [c + 1, r + 1],
          [c, r + 1],
        ],
      });
    }
  }

  return new SolidPolygonLayer({
    id: "picking-overlay",
    data,
    getPolygon: (d: PickSquare) => d.polygon,
    getFillColor: [0, 0, 0, 0], // fully transparent
    getElevation: 0,
    extruded: false,
    pickable: true,
    // Auto-highlight is invisible (alpha 0) but enables picking.
    autoHighlight: false,
    parameters: { depthTest: false },
  });
}
