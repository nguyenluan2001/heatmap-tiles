import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DeckGL from "@deck.gl/react";
import type { DeckGLRef } from "@deck.gl/react";
import { DynamicTexture } from "@luma.gl/engine";
import type { Texture } from "@luma.gl/core";
import {
  OrthographicView,
  OrthographicController,
  type OrthographicViewState,
} from "@deck.gl/core";

import {
  fetchMeta,
  fetchObs,
  fetchVar,
  fetchGroups,
  fetchValue,
  fetchCustomVar,
  createCustomPyramid,
  customTileUrl,
  type PyramidMeta,
  type ObsData,
  type CustomPyramidResponse,
  type GroupConfig,
} from "./api";
import {
  computeVisibleTiles,
  createTileLayers,
  createGapOverlayLayers,
} from "./HeatmapTileLayer";
import { createAxisLayers, createClusterAnnotationLayers } from "./AxisLabels";
import { createPickingLayer, type PickSquare } from "./PickingLayer";
import { SpatialLayout } from "./SpatialLayout";
import {
  getLutData,
  paletteCss,
  PALETTE_NAMES,
  type PaletteName,
} from "./colormap";
import GenePicker from "./GenePicker";

/**
 * Interactive heatmap visualiser.
 *
 * Uses an OrthographicView (2D pan + zoom) over a world rectangle whose width
 * is computed by the {@link SpatialLayout} (cluster gaps along the X-axis) and
 * height is [0, n_cells]. Tiles are 8-bit grayscale PNGs; colour mapping is
 * performed on the GPU via a 256x1 LUT texture, so switching palettes and
 * adjusting the cluster gap size are instant.
 */
export default function HeatmapView() {
  const [meta, setMeta] = useState<PyramidMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });

  const [obs, setObs] = useState<ObsData | null>(null);
  const [varNames, setVarNames] = useState<string[] | null>(null);
  const [groups, setGroups] = useState<GroupConfig[]>([]);

  // --- Gene selection (custom pyramid) state ---
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedGenes, setSelectedGenes] = useState<Set<number>>(new Set());
  const [custom, setCustom] = useState<CustomPyramidResponse | null>(null);
  const [customVarNames, setCustomVarNames] = useState<string[] | null>(null);
  const [building, setBuilding] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);

  // --- Interactive controls: cluster gap size + colour palette ---
  // Default gap > 0 so clusters are visibly separated on first load. The
  // gap is in world units (1 unit = 1 cell at level 0); ~2% of the cell
  // count gives a clear but compact split.
  const [gapSize, setGapSize] = useState(8);
  const [palette, setPalette] = useState<PaletteName>("viridis");

  // The deck.gl ref gives us access to the luma.gl device for creating the
  // colour LUT texture.
  const deckRef = useRef<DeckGLRef<any>>(null);
  const [lutTexture, setLutTexture] = useState<Texture | null>(null);
  const lutTextureRef = useRef<Texture | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMeta()
      .then((m) => {
        if (!cancelled) setMeta(m);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message ?? String(e));
      });
    // Fetch cell + gene names for axis labels (in parallel).
    fetchObs()
      .then((o) => {
        if (!cancelled) setObs(o);
      })
      .catch(() => {
        /* labels are optional */
      });
    fetchVar()
      .then((v) => {
        if (!cancelled) setVarNames(v.var_names);
      })
      .catch(() => {
        /* labels are optional */
      });
    fetchGroups()
      .then((g) => {
        if (!cancelled) setGroups(g.groups);
      })
      .catch(() => {
        /* groups are optional */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Create / recreate the colour LUT texture whenever the palette changes or
  // the device becomes available. The texture is shared across all tiles so
  // palette switching is instant (no tile re-fetch).
  //
  // DynamicTexture initializes asynchronously, so we must await `tex.ready`
  // before accessing `tex.texture` (otherwise it throws "Texture not
  // initialized yet").
  const ensureLutTexture = useCallback(
    async (device: any) => {
      if (!device) return;
      const data = getLutData(palette);
      // Destroy the previous texture if the palette changed.
      if (lutTextureRef.current) {
        lutTextureRef.current.destroy();
        lutTextureRef.current = null;
      }
      setLutTexture(null);
      const tex = new DynamicTexture(device, {
        format: "rgba8unorm",
        width: 256,
        height: 1,
        data: { data, width: 256, height: 1 },
        mipmaps: false,
        sampler: {
          minFilter: "linear",
          magFilter: "linear",
          addressModeU: "clamp-to-edge",
          addressModeV: "clamp-to-edge",
        },
      });
      // Wait for the GPU texture to finish uploading before using it.
      try {
        await tex.ready;
      } catch (e) {
        console.error("LUT texture init failed:", e);
        return;
      }
      lutTextureRef.current = tex.texture;
      setLutTexture(tex.texture);
    },
    [palette],
  );

  // Poll for the device shortly after mount (the deck initialises async).
  useEffect(() => {
    if (lutTexture) return;
    let cancelled = false;
    const id = setInterval(() => {
      const deck = deckRef.current?.deck as any;
      const device = deck?.device;
      if (device) {
        if (!cancelled) ensureLutTexture(device);
        clearInterval(id);
      }
    }, 100);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [lutTexture, ensureLutTexture]);

  // Recreate the LUT texture when the palette changes.
  useEffect(() => {
    const deck = deckRef.current?.deck as any;
    const device = deck?.device;
    if (device) ensureLutTexture(device);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [palette]);

  // Initial view: fit the whole matrix in the viewport.
  const [viewState, setViewState] = useState<OrthographicViewState>({
    target: [0, 0, 0],
    zoom: 0,
    minZoom: -3,
    maxZoom: 10,
  });
  // Guard so the initial fit runs only once per pyramid (full / custom),
  // not on every gap-size slider tweak (which would hijack the user's pan).
  const didInitialFitRef = useRef<string | null>(null);

  // The active groups: custom pyramid groups if built, else the groups
  // embedded in /api/meta (always present), with the separately-fetched
  // /api/groups as an override if it resolves. Falling back to a single
  // group only when no group data is available at all.
  const activeGroups: GroupConfig[] = useMemo(() => {
    if (custom?.groups?.length) return custom.groups;
    if (groups.length) return groups;
    if (meta?.groups?.length) return meta.groups;
    if (meta) return [{ id: "0", size: meta.n_cells }];
    return [];
  }, [custom, groups, meta]);

  // Build the SpatialLayout from the active groups + current gap size.
  const layout = useMemo(
    () => new SpatialLayout(activeGroups, gapSize),
    [activeGroups, gapSize],
  );

  // Total world width (cells, X axis) with gaps for fitting the viewport.
  // World height (Y axis) = number of genes.
  const worldWidth = layout.totalWorldWidth || meta?.n_cells || 1;
  const worldHeight = meta?.n_genes || 1;
  // Reserve space above the matrix for cluster annotation brackets + labels
  // (they live at negative Y). Add a top margin proportional to the gene
  // count so the fit zoom leaves room for them.
  const annotationMargin = activeGroups.length ? worldHeight * 0.04 + 8 : 0;

  // Fit the whole matrix (+ annotations) in the viewport. This runs once
  // per pyramid (full / custom) once the groups are available, so the fit
  // uses the gap-aware worldWidth instead of the gapless fallback. It does
  // NOT re-run on gap-size slider tweaks (guarded by didInitialFitRef) so
  // the user's pan/zoom is preserved.
  const fitKey = custom ? `custom-${custom.id}` : "full";
  useEffect(() => {
    if (!meta || !activeGroups.length) return;
    if (didInitialFitRef.current === fitKey) return;
    didInitialFitRef.current = fitKey;
    const fitWorldH = worldHeight + annotationMargin;
    const fitZoom = Math.log2(
      Math.min(size.width / worldWidth, size.height / fitWorldH),
    );
    setViewState((vs: OrthographicViewState) => ({
      ...vs,
      target: [worldWidth / 2, (worldHeight - annotationMargin) / 2, 0],
      zoom: fitZoom,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, activeGroups, fitKey]);

  // Track the container size so we can compute visible tiles.
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ width: r.width, height: r.height });
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // Hover tooltip state.
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    cell: number;
    gene: number;
    cellName: string;
    geneName: string;
    value: number | null;
  } | null>(null);

  // The "active" metadata + gene names: custom pyramid when built, else full.
  const activeMeta: PyramidMeta | null = custom ?? meta;
  const activeVarNames: string[] | null = custom ? customVarNames : varNames;

  // Compute visible tiles + axis labels + picking overlay.
  const layers = useMemo(() => {
    if (!activeMeta || !lutTexture) return [];
    const zoom = Number(viewState.zoom ?? 0);
    const target = viewState.target as [number, number, number];
    const tiles = computeVisibleTiles(
      activeMeta,
      target,
      zoom,
      size.width,
      size.height,
      layout,
    );
    // Use custom tile URL + id prefix when in custom mode.
    const urlFn = custom
      ? (l: number, r: number, c: number) => customTileUrl(custom.id, l, r, c)
      : undefined;
    const tileLayers = createTileLayers(
      tiles,
      lutTexture,
      urlFn,
      custom ? "ctile" : "tile",
    );
    // Opaque mask rectangles over the inter-cluster gaps, drawn ON TOP of
    // the tiles so stretched boundary tiles don't bleed across the gaps.
    const gapOverlayLayers = createGapOverlayLayers(activeMeta, layout);
    // Axis labels (only when cell/gene names have loaded).
    const cellIds = obs?.cell_ids ?? [];
    const genes = activeVarNames ?? [];
    const axisLayers =
      cellIds.length || genes.length
        ? createAxisLayers(
            activeMeta,
            cellIds,
            genes,
            zoom,
            size.width,
            size.height,
          )
        : [];
    // Cluster annotation ticks + labels above the heatmap, positioned
    // via the SpatialLayout so they line up with the cluster-gap split.
    const clusterAnnotationLayers = activeGroups.length
      ? createClusterAnnotationLayers(activeMeta, activeGroups, layout, zoom)
      : [];
    // Picking overlay (only when zoomed in enough that few squares are visible).
    const pickingLayer = createPickingLayer(
      activeMeta,
      target,
      zoom,
      size.width,
      size.height,
    );
    return [
      ...tileLayers,
      ...gapOverlayLayers,
      ...clusterAnnotationLayers,
      ...axisLayers,
      ...(pickingLayer ? [pickingLayer] : []),
    ];
  }, [
    activeMeta,
    custom,
    viewState,
    size,
    obs,
    activeVarNames,
    lutTexture,
    layout,
    activeGroups,
  ]);

  // (The initial fit above already handles full/custom switching via the
  // fitKey guard, so no separate re-fit effect is needed here.)

  // --- Gene picker handlers ---
  const toggleGene = useCallback((index: number) => {
    setSelectedGenes((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const applyGeneSelection = useCallback(() => {
    if (selectedGenes.size === 0) return;
    setBuilding(true);
    setCustomError(null);
    const indices = Array.from(selectedGenes).sort((a, b) => a - b);
    createCustomPyramid(indices)
      .then((res) => {
        setCustom(res);
        setPickerOpen(false);
        // Fetch the selected gene names for axis labels.
        fetchCustomVar(res.id)
          .then((v) => setCustomVarNames(v.var_names))
          .catch(() => setCustomVarNames(null));
      })
      .catch((e) => {
        setCustomError(e?.message ?? String(e));
      })
      .finally(() => setBuilding(false));
  }, [selectedGenes]);

  const resetToFull = useCallback(() => {
    setCustom(null);
    setCustomVarNames(null);
    setCustomError(null);
  }, []);

  // On hover over a picking square, fetch the expression value + names.
  const onHover = useCallback(
    (info: { x?: number; y?: number; object?: PickSquare } | null) => {
      if (!info || !info.object) {
        setHover(null);
        return;
      }
      const { cell, gene } = info.object;
      const cellName = obs?.cell_ids?.[cell] ?? `cell ${cell}`;
      const geneName = activeVarNames?.[gene] ?? `gene ${gene}`;
      setHover({
        x: info.x ?? 0,
        y: info.y ?? 0,
        cell,
        gene,
        cellName,
        geneName,
        value: null,
      });
      // Fetch the raw value asynchronously. In custom mode, the gene
      // index is relative to the custom pyramid's column order, so we
      // map it back to the original gene index for the /api/value call.
      const origGene = custom ? custom.gene_indices[gene] : gene;
      fetchValue(cell, origGene)
        .then((r) => {
          setHover((h) =>
            h && h.cell === cell && h.gene === gene
              ? { ...h, value: r.value }
              : h,
          );
        })
        .catch(() => {});
    },
    [obs, activeVarNames, custom],
  );

  if (error) {
    return (
      <div className="loading">
        <h2>Failed to load</h2>
        <pre>{error}</pre>
        <p>
          Make sure the backend is running (uv run uvicorn backend.server:app).
        </p>
      </div>
    );
  }

  if (!meta) {
    return <div className="loading">Loading pyramid metadata…</div>;
  }

  return (
    <div className="heatmap-wrap" ref={wrapRef}>
      <DeckGL
        ref={deckRef}
        views={new OrthographicView({ id: "ortho", controller: true })}
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
            <span className="gt-badge">{custom.n_genes} genes selected</span>
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
      {/* Cluster gap + palette controls */}
      <div className="controls">
        <div className="ctrl-row">
          <label
            className="ctrl-label"
            title="Gap between clusters (world units)"
          >
            Gap
          </label>
          <input
            type="range"
            min={0}
            max={Math.max(20, Math.round((meta.n_cells || 1) * 0.02))}
            step={1}
            value={gapSize}
            onChange={(e) => setGapSize(Number(e.target.value))}
          />
          <span className="ctrl-value">{gapSize}</span>
        </div>
        <div className="ctrl-row">
          <label className="ctrl-label">Palette</label>
          <div className="palette-swatches">
            {PALETTE_NAMES.map((p) => (
              <button
                key={p}
                className={`palette-btn${p === palette ? " active" : ""}`}
                onClick={() => setPalette(p)}
                title={p}
              >
                <span
                  className="palette-preview"
                  style={{
                    background: `linear-gradient(90deg, ${paletteCss(
                      p,
                      0,
                    )}, ${paletteCss(p, 0.5)}, ${paletteCss(p, 1)})`,
                  }}
                />
              </button>
            ))}
          </div>
        </div>
      </div>
      {customError && <div className="custom-error">{customError}</div>}
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
      <Legend meta={activeMeta!} palette={palette} />
      <Info meta={activeMeta!} viewState={viewState} custom={custom} />
      {hover && <Tooltip hover={hover} />}
    </div>
  );
}

/** Hover tooltip showing gene, cell, and expression value. */
function Tooltip({
  hover,
}: {
  hover: {
    x: number;
    y: number;
    cellName: string;
    geneName: string;
    value: number | null;
  };
}) {
  return (
    <div className="tooltip" style={{ left: hover.x + 12, top: hover.y + 12 }}>
      <div>
        <span className="tt-label">Gene:</span> {hover.geneName}
      </div>
      <div>
        <span className="tt-label">Cell:</span> {hover.cellName}
      </div>
      <div>
        <span className="tt-label">Expression:</span>{" "}
        {hover.value === null ? "…" : hover.value.toFixed(4)}
      </div>
    </div>
  );
}

/** Colour bar legend showing the expression value range for the active palette. */
function Legend({
  meta,
  palette,
}: {
  meta: PyramidMeta;
  palette: PaletteName;
}) {
  const stops = Array.from({ length: 20 }, (_, i) => i / 19);
  return (
    <div className="legend">
      <div className="legend-title">log-normalised expression</div>
      <div className="legend-bar">
        {stops.map((t, i) => (
          <div
            key={i}
            className="legend-swatch"
            style={{ background: paletteCss(palette, t) }}
          />
        ))}
      </div>
      <div className="legend-scale">
        <span>{meta.vmin.toFixed(2)}</span>
        <span>{meta.vmax.toFixed(2)}</span>
      </div>
    </div>
  );
}

/** Small info panel showing matrix dimensions and current zoom. */
function Info({
  meta,
  viewState,
  custom,
}: {
  meta: PyramidMeta;
  viewState: OrthographicViewState;
  custom?: CustomPyramidResponse | null;
}) {
  const zoom = Number(viewState.zoom ?? 0);
  const maxLevel = meta.n_levels - 1;
  const level = Math.max(0, Math.min(maxLevel, maxLevel - Math.round(zoom)));
  return (
    <div className="info">
      <div>
        <strong>{meta.n_cells.toLocaleString()}</strong> cells ×{" "}
        <strong>{meta.n_genes.toLocaleString()}</strong> genes
      </div>
      <div>layer: {meta.layer}</div>
      <div>
        pyramid level: {level} / {maxLevel}
      </div>
      <div>zoom: {zoom.toFixed(2)}</div>
      {custom && <div className="info-custom">★ custom gene set</div>}
    </div>
  );
}
