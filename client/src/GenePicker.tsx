import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Props for the gene picker panel.
 *
 * `allGenes` is the full ordered list of gene names (from /api/var).
 * `selected` is the set of gene indices currently chosen.
 * `onApply` is called when the user clicks "Apply" — the parent builds
 * a custom pyramid from these indices and switches the heatmap.
 */
export interface GenePickerProps {
  allGenes: string[];
  selected: Set<number>;
  onToggle: (index: number) => void;
  onApply: () => void;
  onClear: () => void;
  onClose: () => void;
  loading?: boolean;
}

/**
 * A searchable, scrollable gene selection panel.
 *
 * With 32k genes we cannot render all rows at once, so we virtualise by
 * only rendering the slice of genes visible in the scroll container (plus
 * a small overscan buffer). The search box filters by substring (case-
 * insensitive) and updates the visible list live.
 */
export default function GenePicker({
  allGenes,
  selected,
  onToggle,
  onApply,
  onClear,
  onClose,
  loading,
}: GenePickerProps) {
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Filtered gene list (index + name) matching the search query.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return allGenes.map((name, index) => ({ index, name }));
    }
    const out: { index: number; name: string }[] = [];
    for (let i = 0; i < allGenes.length; i++) {
      if (allGenes[i].toLowerCase().includes(q)) {
        out.push({ index: i, name: allGenes[i] });
      }
    }
    return out;
  }, [allGenes, query]);

  // Reset scroll when the filter changes.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [query]);

  // Track the scroll container height for virtualisation.
  useEffect(() => {
    if (!scrollRef.current) return;
    const ro = new ResizeObserver((entries) => {
      setViewportH(entries[0].contentRect.height);
    });
    ro.observe(scrollRef.current);
    return () => ro.disconnect();
  }, []);

  const ROW_H = 28;
  const totalRows = filtered.length;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
  const endIndex = Math.min(
    totalRows,
    Math.ceil((scrollTop + viewportH) / ROW_H) + 5,
  );
  const visibleRows = filtered.slice(startIndex, endIndex);

  return (
    <div className="gene-picker">
      <div className="gp-header">
        <h2>Select Genes</h2>
        <button className="gp-close" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="gp-search">
        <input
          type="text"
          placeholder="Search gene name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <span className="gp-count">
          {selected.size} selected · {totalRows} shown
        </span>
      </div>
      <div
        className="gp-list"
        ref={scrollRef}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        <div style={{ height: totalRows * ROW_H, position: "relative" }}>
          {visibleRows.map((g) => (
            <label
              key={g.index}
              className="gp-row"
              style={{ top: (startIndex + visibleRows.indexOf(g)) * ROW_H }}
            >
              <input
                type="checkbox"
                checked={selected.has(g.index)}
                onChange={() => onToggle(g.index)}
              />
              <span className="gp-gene-name">{g.name}</span>
              <span className="gp-gene-idx">#{g.index}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="gp-actions">
        <button
          className="gp-btn gp-clear"
          onClick={onClear}
          disabled={selected.size === 0}
        >
          Clear
        </button>
        <button
          className="gp-btn gp-apply"
          onClick={onApply}
          disabled={selected.size === 0 || loading}
        >
          {loading ? "Building…" : `Apply (${selected.size})`}
        </button>
      </div>
    </div>
  );
}
