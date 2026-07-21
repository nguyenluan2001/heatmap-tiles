import { TextLayer } from '@deck.gl/layers'

import type { PyramidMeta } from './api'

/** Spacing (world units) reserved on each side for axis labels. */
export const AXIS_MARGIN = 0.06 // fraction of the matrix dimension

/**
 * Build TextLayers for cell names (Y axis, left) and gene names (X axis, top).
 *
 * With 2638 cells and 32310 genes we cannot draw every label. Instead we
 * sample labels at a stride chosen so that, at the current zoom, adjacent
 * labels are ~80px apart on screen. Labels are positioned in world space so
 * they pan/zoom with the heatmap.
 */
export function createAxisLayers(
    meta: PyramidMeta,
    cellIds: string[],
    varNames: string[],
    zoom: number,
    width: number,
    height: number,
) {
    // Screen pixels per world unit at this zoom.
    const pxPerUnit = Math.pow(2, zoom)
    // Desired on-screen spacing between labels (px).
    const TARGET_SPACING = 90

    // --- Y axis: cell names (left side) ---
    // Stride in cells so labels are ~TARGET_SPACING px apart.
    const cellStride = Math.max(1, Math.round(TARGET_SPACING / pxPerUnit))
    const cellData: { position: [number, number]; text: string }[] = []
    for (let i = 0; i < cellIds.length; i += cellStride) {
        cellData.push({
            position: [-2, i + 0.5], // just left of the matrix, centred on the row
            text: cellIds[i],
        })
    }

    // --- X axis: gene names (top) ---
    const geneStride = Math.max(1, Math.round(TARGET_SPACING / pxPerUnit))
    const geneData: { position: [number, number]; text: string }[] = []
    for (let j = 0; j < varNames.length; j += geneStride) {
        geneData.push({
            position: [j + 0.5, -2], // just above the matrix, centred on the column
            text: varNames[j],
        })
    }

    // Font size scales mildly with zoom but is clamped.
    const fontSize = Math.min(16, Math.max(9, 12))

    const cellLayer = new TextLayer({
        id: 'axis-y-cells',
        data: cellData,
        getPosition: (d: { position: [number, number] }) => d.position,
        getText: (d: { text: string }) => d.text,
        // `size` is the font size in px; `sizeScale` multiplies it (default 1).
        size: fontSize,
        sizeScale: 1,
        getColor: [230, 237, 243, 220],
        getAngle: 0,
        getTextAnchor: 'end',
        getAlignmentBaseline: 'center',
        billboard: true,
        pickable: false,
    })

    const geneLayer = new TextLayer({
        id: 'axis-x-genes',
        data: geneData,
        getPosition: (d: { position: [number, number] }) => d.position,
        getText: (d: { text: string }) => d.text,
        size: fontSize,
        sizeScale: 1,
        getColor: [230, 237, 243, 220],
        getAngle: 90, // rotate gene names 90° so they read along the column
        getTextAnchor: 'start',
        getAlignmentBaseline: 'center',
        billboard: true,
        pickable: false,
    })

    return [cellLayer, geneLayer]
}
