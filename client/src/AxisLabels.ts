import { LineLayer, TextLayer } from "@deck.gl/layers";

import type { GroupConfig, PyramidMeta } from "./api";
import { SpatialLayout } from "./SpatialLayout";

/** Spacing (world units) reserved on each side for axis labels. */
export const AXIS_MARGIN = 0.06; // fraction of the matrix dimension

/** A stable colour per cluster id (deterministic hash -> hue). */
function clusterColor(id: string): [number, number, number, number] {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return hslToRgb(hue, 0.6, 0.62);
}

function hslToRgb(
  h: number,
  s: number,
  l: number,
): [number, number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
    230,
  ];
}

/**
 * Build cluster annotation layers: a thin coloured underline tick beneath each
 * cluster name, plus the cluster name centred above its column span.
 *
 * Uses the {@link SpatialLayout} so the annotations line up exactly with the
 * cluster-gap-split heatmap columns. The tick sits just above the matrix
 * (y = -tickGap) and the label sits above the tick. Only a single horizontal
 * line per cluster is drawn (no filled rectangle) so it stays clean at every
 * zoom level.
 */
export function createClusterAnnotationLayers(
  meta: PyramidMeta,
  groups: GroupConfig[],
  layout: SpatialLayout,
  zoom: number,
) {
  if (!groups.length) return [];
  // Font size grows slightly when zoomed in so labels stay legible.
  const fontSize = Math.min(16, Math.max(10, 10 + Math.max(0, zoom) * 0.5));
  // World-unit gap between the matrix top edge and the underline tick.
  const tickGap = 2;
  const labelY = -tickGap - 2; // label sits above the tick
  const tickY = -tickGap; // tick sits just above the matrix
  const matrixHeight = meta.n_genes;

  const tickData: {
    start: [number, number];
    end: [number, number];
    color: [number, number, number, number];
  }[] = [];
  const labelData: {
    position: [number, number];
    text: string;
    color: [number, number, number, number];
  }[] = [];

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    // Compute the world-X span of this cluster via the layout.
    const rawColStart = layout.groupRawStarts[i] ?? 0;
    const rawColEnd = rawColStart + group.size;
    const worldStart = layout.mapColToWorldX(rawColStart);
    const worldEnd = layout.mapColToWorldX(Math.max(0, rawColEnd - 1)) + 1;
    const worldCenter = (worldStart + worldEnd) / 2;
    const color = clusterColor(group.id);
    // A single horizontal underline spanning the cluster's world-X range.
    tickData.push({
      start: [worldStart, tickY],
      end: [worldEnd, tickY],
      color,
    });
    // Faint vertical guide lines at the cluster edges, from the tick down
    // to the matrix bottom, to visually delineate the cluster column.
    tickData.push({
      start: [worldStart, tickY],
      end: [worldStart, matrixHeight],
      color: [color[0], color[1], color[2], 60],
    });
    tickData.push({
      start: [worldEnd, tickY],
      end: [worldEnd, matrixHeight],
      color: [color[0], color[1], color[2], 60],
    });
    labelData.push({
      position: [worldCenter, labelY],
      text: group.id,
      color,
    });
  }

  const tickLayer = new LineLayer({
    id: "cluster-annotation-tick",
    data: tickData,
    getSourcePosition: (d: { start: [number, number] }) => d.start,
    getTargetPosition: (d: { end: [number, number] }) => d.end,
    getColor: (d: { color: [number, number, number, number] }) => d.color,
    getWidth: 8,
    widthUnits: "pixels",
    pickable: false,
  });

  const labelLayer = new TextLayer({
    id: "cluster-annotation-labels",
    data: labelData,
    getPosition: (d: { position: [number, number] }) => d.position,
    getText: (d: { text: string }) => d.text,
    size: fontSize,
    sizeScale: 1,
    getColor: (d: { color: [number, number, number, number] }) => d.color,
    getAngle: 0,
    getTextAnchor: "middle",
    getAlignmentBaseline: "bottom",
    billboard: true,
    pickable: false,
  });

  return [tickLayer, labelLayer];
}

/**
 * Build TextLayers for cell names (X axis, bottom) and gene names (Y axis, left).
 *
 * Orientation: X axis = cells (columns), Y axis = genes (rows). This matches
 * the transposed matrix layout where the heatmap world rectangle is
 * [0, n_cells] x [0, n_genes].
 *
 * With thousands of cells/genes we cannot draw every label. Instead we sample
 * labels at a stride chosen so that, at the current zoom, adjacent labels are
 * ~90px apart on screen. Labels are positioned in world space so they
 * pan/zoom with the heatmap.
 */
export function createAxisLayers(
  meta: PyramidMeta,
  cellIds: string[],
  varNames: string[],
  zoom: number,
  _width: number,
  _height: number,
) {
  // Screen pixels per world unit at this zoom.
  const pxPerUnit = Math.pow(2, zoom);
  // Desired on-screen spacing between labels (px).
  const TARGET_SPACING = 90;

  // --- X axis: cell names (bottom side) ---
  // Cells are along the X axis (columns). Stride in cells so labels are
  // ~TARGET_SPACING px apart.
  const cellStride = Math.max(1, Math.round(TARGET_SPACING / pxPerUnit));
  const cellData: { position: [number, number]; text: string }[] = [];
  for (let i = 0; i < cellIds.length; i += cellStride) {
    cellData.push({
      position: [i + 0.5, meta.n_genes + 2], // just below the matrix, centred on the column
      text: cellIds[i],
    });
  }

  // --- Y axis: gene names (left side) ---
  // Genes are along the Y axis (rows).
  // When few genes are selected (custom pyramid), always show ALL of them
  // regardless of zoom — the stride would otherwise skip most of them.
  const geneStride =
    varNames.length <= 50
      ? 1
      : Math.max(1, Math.round(TARGET_SPACING / pxPerUnit));
  const geneData: { position: [number, number]; text: string }[] = [];
  // When n_genes < TILE_SIZE, the tile is padded with NaN and the GPU shader
  // stretches the data rows (vExtent) to fill the full 256-pixel tile. So
  // gene j visually occupies the range [j, j+1) * (TILE_SIZE / n_genes) in
  // world coordinates. Labels must match this stretched layout.
  const nGenes = meta.n_genes;
  const TILE = meta.tile_size;
  const geneScale = nGenes > 0 && nGenes < TILE ? TILE / nGenes : 1;
  for (let j = 0; j < varNames.length; j += geneStride) {
    const yPos = (j + 0.5) * geneScale;
    geneData.push({
      position: [-2, yPos], // just left of the matrix, centred on the row
      text: varNames[j],
    });
  }

  // Font size scales mildly with zoom but is clamped.
  const fontSize = Math.min(16, Math.max(9, 12));

  // X axis: cell names along the bottom, rotated -90° so they read downward.
  const cellLayer = new TextLayer({
    id: "axis-x-cells",
    // data: cellData,
    data: [],
    getPosition: (d: { position: [number, number] }) => d.position,
    getText: (d: { text: string }) => d.text,
    size: fontSize,
    sizeScale: 1,
    getColor: [230, 237, 243, 220],
    getAngle: -90, // rotate cell names so they read along the column
    getTextAnchor: "start",
    getAlignmentBaseline: "center",
    billboard: true,
    pickable: false,
  });

  // Y axis: gene names on the left, horizontal.
  const geneLayer = new TextLayer({
    id: "axis-y-genes",
    data: geneData,
    getPosition: (d: { position: [number, number] }) => d.position,
    getText: (d: { text: string }) => d.text,
    size: fontSize,
    sizeScale: 1,
    getColor: [230, 237, 243, 220],
    getAngle: 0,
    getTextAnchor: "end",
    getAlignmentBaseline: "center",
    billboard: true,
    pickable: false,
  });

  return [cellLayer, geneLayer];
}
