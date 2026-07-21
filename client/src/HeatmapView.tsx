import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DeckGL from '@deck.gl/react'
import {
    OrthographicView,
    OrthographicController,
    type OrthographicViewState,
} from '@deck.gl/core'

import {
    fetchMeta,
    fetchObs,
    fetchVar,
    fetchValue,
    fetchCustomVar,
    createCustomPyramid,
    customTileUrl,
    type PyramidMeta,
    type ObsData,
    type CustomPyramidResponse,
} from './api'
import { computeVisibleTiles, createTileLayers } from './HeatmapTileLayer'
import { createAxisLayers } from './AxisLabels'
import { createPickingLayer, type PickSquare } from './PickingLayer'
import { viridisCss } from './colormap'
import GenePicker from './GenePicker'

/**
 * Interactive heatmap visualiser.
 *
 * Uses an OrthographicView (2D pan + zoom) over a world rectangle of
 * [0, n_genes] x [0, n_cells]. On every view change we compute which pyramid
 * tiles are visible and render each as a BitmapLayer. deck.gl's async `image`
 * prop handles PNG loading + texture caching, so tiles appear as they load.
 */
export default function HeatmapView() {
    const [meta, setMeta] = useState<PyramidMeta | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [size, setSize] = useState({ width: 800, height: 600 })

    const [obs, setObs] = useState<ObsData | null>(null)
    const [varNames, setVarNames] = useState<string[] | null>(null)

    // --- Gene selection (custom pyramid) state ---
    const [pickerOpen, setPickerOpen] = useState(false)
    const [selectedGenes, setSelectedGenes] = useState<Set<number>>(new Set())
    const [custom, setCustom] = useState<CustomPyramidResponse | null>(null)
    const [customVarNames, setCustomVarNames] = useState<string[] | null>(null)
    const [building, setBuilding] = useState(false)
    const [customError, setCustomError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        fetchMeta()
            .then((m) => {
                if (!cancelled) setMeta(m)
            })
            .catch((e) => {
                if (!cancelled) setError(e?.message ?? String(e))
            })
        // Fetch cell + gene names for axis labels (in parallel).
        fetchObs()
            .then((o) => {
                if (!cancelled) setObs(o)
            })
            .catch(() => {
                /* labels are optional */
            })
        fetchVar()
            .then((v) => {
                if (!cancelled) setVarNames(v.var_names)
            })
            .catch(() => {
                /* labels are optional */
            })
        return () => {
            cancelled = true
        }
    }, [])

    // Initial view: fit the whole matrix in the viewport.
    const [viewState, setViewState] = useState<OrthographicViewState>({
        target: [0, 0, 0],
        zoom: 0,
        minZoom: -3,
        maxZoom: 10,
    })

    // Once metadata arrives, fit the whole matrix in the viewport.
    useEffect(() => {
        if (!meta) return
        // Fit so the whole matrix is visible: zoom so the larger dimension
        // fills the viewport. 1 world unit = 2^zoom pixels.
        const fitZoom = Math.log2(
            Math.min(size.width / meta.n_genes, size.height / meta.n_cells),
        )
        setViewState((vs: OrthographicViewState) => ({
            ...vs,
            target: [meta.n_genes / 2, meta.n_cells / 2, 0],
            zoom: fitZoom,
        }))
    }, [meta, size])

    // Track the container size so we can compute visible tiles.
    const wrapRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
        if (!wrapRef.current) return
        const ro = new ResizeObserver((entries) => {
            const r = entries[0].contentRect
            setSize({ width: r.width, height: r.height })
        })
        ro.observe(wrapRef.current)
        return () => ro.disconnect()
    }, [])

    // Hover tooltip state.
    const [hover, setHover] = useState<{
        x: number
        y: number
        cell: number
        gene: number
        cellName: string
        geneName: string
        value: number | null
    } | null>(null)

    // The "active" metadata + gene names: custom pyramid when built, else full.
    const activeMeta: PyramidMeta | null = custom ?? meta
    const activeVarNames: string[] | null = custom ? customVarNames : varNames

    // Compute visible tiles + axis labels + picking overlay.
    const layers = useMemo(() => {
        if (!activeMeta) return []
        const zoom = Number(viewState.zoom ?? 0)
        console.log("🚀 ===== HeatmapView ===== viewState:", viewState);
        const target = viewState.target as [number, number, number]
        const tiles = computeVisibleTiles(activeMeta, target, zoom, size.width, size.height)
        console.log("🚀 ===== HeatmapView ===== tiles:", tiles);
        // Use custom tile URL + id prefix when in custom mode.
        const urlFn = custom
            ? (l: number, r: number, c: number) => customTileUrl(custom.id, l, r, c)
            : undefined
        const tileLayers = createTileLayers(tiles, urlFn, custom ? 'ctile' : 'tile')
        // Axis labels (only when cell/gene names have loaded).
        const cellIds = obs?.cell_ids ?? []
        const genes = activeVarNames ?? []
        const axisLayers =
            cellIds.length || genes.length
                ? createAxisLayers(activeMeta, cellIds, genes, zoom, size.width, size.height)
                : []
        // Picking overlay (only when zoomed in enough that few squares are visible).
        const pickingLayer = createPickingLayer(activeMeta, target, zoom, size.width, size.height)
        return [...tileLayers, ...axisLayers, ...(pickingLayer ? [pickingLayer] : [])]
    }, [activeMeta, custom, viewState, size, obs, activeVarNames])

    // Re-fit the viewport when switching between full and custom pyramid.
    const fitTrigger = custom ? `custom-${custom.id}` : 'full'
    useEffect(() => {
        if (!activeMeta) return
        const fitZoom = Math.log2(
            Math.min(size.width / activeMeta.n_genes, size.height / activeMeta.n_cells),
        )
        setViewState((vs: OrthographicViewState) => ({
            ...vs,
            target: [activeMeta.n_genes / 2, activeMeta.n_cells / 2, 0],
            zoom: fitZoom,
        }))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fitTrigger])

    // --- Gene picker handlers ---
    const toggleGene = useCallback((index: number) => {
        setSelectedGenes((prev) => {
            const next = new Set(prev)
            if (next.has(index)) next.delete(index)
            else next.add(index)
            return next
        })
    }, [])

    const applyGeneSelection = useCallback(() => {
        if (selectedGenes.size === 0) return
        setBuilding(true)
        setCustomError(null)
        const indices = Array.from(selectedGenes).sort((a, b) => a - b)
        createCustomPyramid(indices)
            .then((res) => {
                setCustom(res)
                setPickerOpen(false)
                // Fetch the selected gene names for axis labels.
                fetchCustomVar(res.id)
                    .then((v) => setCustomVarNames(v.var_names))
                    .catch(() => setCustomVarNames(null))
            })
            .catch((e) => {
                setCustomError(e?.message ?? String(e))
            })
            .finally(() => setBuilding(false))
    }, [selectedGenes])

    const resetToFull = useCallback(() => {
        setCustom(null)
        setCustomVarNames(null)
        setCustomError(null)
    }, [])

    // On hover over a picking square, fetch the expression value + names.
    const onHover = useCallback(
        (info: { x?: number; y?: number; object?: PickSquare } | null) => {
            if (!info || !info.object) {
                setHover(null)
                return
            }
            const { cell, gene } = info.object
            const cellName = obs?.cell_ids?.[cell] ?? `cell ${cell}`
            const geneName = activeVarNames?.[gene] ?? `gene ${gene}`
            setHover({
                x: info.x ?? 0,
                y: info.y ?? 0,
                cell,
                gene,
                cellName,
                geneName,
                value: null,
            })
            // Fetch the raw value asynchronously. In custom mode, the gene
            // index is relative to the custom pyramid's column order, so we
            // map it back to the original gene index for the /api/value call.
            const origGene = custom ? custom.gene_indices[gene] : gene
            fetchValue(cell, origGene)
                .then((r) => {
                    setHover((h) =>
                        h && h.cell === cell && h.gene === gene
                            ? { ...h, value: r.value }
                            : h,
                    )
                })
                .catch(() => { })
        },
        [obs, activeVarNames, custom],
    )

    if (error) {
        return (
            <div className="loading">
                <h2>Failed to load</h2>
                <pre>{error}</pre>
                <p>Make sure the backend is running (uv run uvicorn backend.server:app).</p>
            </div>
        )
    }

    if (!meta) {
        return <div className="loading">Loading pyramid metadata…</div>
    }

    return (
        <div className="heatmap-wrap" ref={wrapRef}>
            <DeckGL
                views={new OrthographicView({ id: 'ortho', controller: true })}
                viewState={viewState}
                controller={OrthographicController}
                layers={layers}
                onViewStateChange={(e) =>
                    setViewState(e.viewState as OrthographicViewState)
                }
                onHover={onHover as any}
            />
            {/* Gene selection toolbar */}
            <div className="gene-toolbar">
                {custom ? (
                    <>
                        <span className="gt-badge">
                            {custom.n_genes} genes selected
                        </span>
                        <button className="gt-btn" onClick={() => setPickerOpen(true)}>
                            Edit selection
                        </button>
                        <button className="gt-btn gt-reset" onClick={resetToFull}>
                            Show all genes
                        </button>
                    </>
                ) : (
                    <button className="gt-btn" onClick={() => setPickerOpen(true)}>
                        Select genes…
                    </button>
                )}
            </div>
            {customError && (
                <div className="custom-error">{customError}</div>
            )}
            {pickerOpen && varNames && (
                <GenePicker
                    allGenes={varNames}
                    selected={selectedGenes}
                    onToggle={toggleGene}
                    onApply={applyGeneSelection}
                    onClear={() => setSelectedGenes(new Set())}
                    onClose={() => setPickerOpen(false)}
                    loading={building}
                />
            )}
            <Legend meta={activeMeta!} />
            <Info meta={activeMeta!} viewState={viewState} custom={custom} />
            {hover && <Tooltip hover={hover} />}
        </div>
    )
}

/** Hover tooltip showing gene, cell, and expression value. */
function Tooltip({
    hover,
}: {
    hover: {
        x: number
        y: number
        cellName: string
        geneName: string
        value: number | null
    }
}) {
    return (
        <div
            className="tooltip"
            style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
            <div><span className="tt-label">Gene:</span> {hover.geneName}</div>
            <div><span className="tt-label">Cell:</span> {hover.cellName}</div>
            <div>
                <span className="tt-label">Expression:</span>{' '}
                {hover.value === null
                    ? '…'
                    : hover.value.toFixed(4)}
            </div>
        </div>
    )
}

/** Colour bar legend showing the expression value range. */
function Legend({ meta }: { meta: PyramidMeta }) {
    const stops = Array.from({ length: 20 }, (_, i) => i / 19)
    return (
        <div className="legend">
            <div className="legend-title">log-normalised expression</div>
            <div className="legend-bar">
                {stops.map((t, i) => (
                    <div
                        key={i}
                        className="legend-swatch"
                        style={{ background: viridisCss(t) }}
                    />
                ))}
            </div>
            <div className="legend-scale">
                <span>{meta.vmin.toFixed(2)}</span>
                <span>{meta.vmax.toFixed(2)}</span>
            </div>
        </div>
    )
}

/** Small info panel showing matrix dimensions and current zoom. */
function Info({
    meta,
    viewState,
    custom,
}: {
    meta: PyramidMeta
    viewState: OrthographicViewState
    custom?: CustomPyramidResponse | null
}) {
    const zoom = Number(viewState.zoom ?? 0)
    const maxLevel = meta.n_levels - 1
    const level = Math.max(0, Math.min(maxLevel, maxLevel - Math.round(zoom)))
    return (
        <div className="info">
            <div>
                <strong>{meta.n_cells.toLocaleString()}</strong> cells ×{' '}
                <strong>{meta.n_genes.toLocaleString()}</strong> genes
            </div>
            <div>layer: {meta.layer}</div>
            <div>pyramid level: {level} / {maxLevel}</div>
            <div>zoom: {zoom.toFixed(2)}</div>
            {custom && <div className="info-custom">★ custom gene set</div>}
        </div>
    )
}
