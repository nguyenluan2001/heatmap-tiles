/**
 * SpatialLayout — cumulative offset calculator for cluster gaps.
 *
 * Cells are grouped into ordered clusters along the X-axis. Between each
 * cluster we insert a configurable gap (in world units). This class converts
 * raw matrix cell column indices into screen World X coordinates that include
 * the gap offsets, and back.
 *
 * Part of the High-Performance Single-Cell Heatmap Architecture (Step 2).
 *
 * Coordinate spaces
 * -----------------
 * - **Raw index space**: the column index in the original (cluster-sorted)
 *   matrix, 0 .. n_cells-1, with NO gaps. This is what tiles are addressed by.
 * - **World space**: the on-screen X coordinate, where each cluster is shifted
 *   right by `gapSize` world units per preceding cluster. This is what the
 *   deck.gl layer bounds use.
 *
 * The mapping is:  worldX = groupWorldStart + (rawIndex - groupRawStart)
 * i.e. within a group, world X advances 1:1 with the raw index, and the only
 * effect of gaps is to offset each group's world start.
 */

export interface GroupConfig {
  /** Cluster identifier (e.g. louvain label). */
  id: string;
  /** Number of cells in this cluster. */
  size: number;
}

export class SpatialLayout {
  /** Raw index where each group starts (no gaps): 0, size0, size0+size1, ... */
  groupRawStarts: number[] = [];
  /** World X where each group starts (with gaps, RELATIVE to originX):
   *  0-originX, s0+gap-originX, s0+s1+2*gap-originX, ... */
  groupWorldStarts: number[] = [];
  /** Total world width including all inter-cluster gaps (RELATIVE to originX). */
  totalWorldWidth: number = 0;
  /** Total number of cells (sum of group sizes, no gaps). */
  totalRawWidth: number = 0;
  /** Number of groups. */
  nGroups: number;
  /** The cluster groups. */
  groups: GroupConfig[];
  /** Gap size in world units between consecutive clusters. */
  gapSize: number;
  /** X origin offset for RTC (Relative-To-Center) precision. All world-X
   *  values returned by {@link mapColToWorldX} are relative to this origin,
   *  keeping them small (< viewport) so Float32 GPU precision is sufficient
   *  even for 20M+ cells. Default 0 = absolute coordinates (backward compat). */
  originX: number;

  constructor(groups: GroupConfig[], gapSize: number, originX: number = 0) {
    this.groups = groups;
    this.gapSize = gapSize;
    this.originX = originX;
    let rawX = 0;
    let worldX = 0;
    for (const group of groups) {
      this.groupRawStarts.push(rawX);
      // Store RELATIVE world starts (subtract originX) so all downstream
      // world-X values are small and Float32-safe.
      this.groupWorldStarts.push(worldX - originX);
      rawX += group.size;
      worldX += group.size + gapSize;
    }
    this.totalRawWidth = rawX;
    // The last gap is trailing whitespace; subtract it so the world width
    // exactly spans the data + inter-cluster gaps (no trailing gap).
    // Result is RELATIVE to originX.
    this.totalWorldWidth = Math.max(0, worldX - gapSize - originX);
    this.nGroups = groups.length;
  }

  /**
   * Convert a raw matrix cell column index into a Screen World X coordinate.
   *
   * Uses binary search over group raw starts for O(log n) performance —
   * important when there are hundreds of clusters and this is called per-tile.
   */
  mapColToWorldX(colIndex: number): number {
    if (colIndex < 0) return 0;
    if (colIndex >= this.totalRawWidth) return this.totalWorldWidth;
    // Binary search for the group whose [rawStart, rawStart+size) contains col.
    let lo = 0;
    let hi = this.groupRawStarts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const start = this.groupRawStarts[mid];
      const size = this.groups[mid].size;
      if (colIndex < start) {
        hi = mid - 1;
      } else if (colIndex >= start + size) {
        lo = mid + 1;
      } else {
        // Found: worldX = group's world start + offset within the group.
        return this.groupWorldStarts[mid] + (colIndex - start);
      }
    }
    // Fallback: linear scan (handles edge cases too).
    let remaining = colIndex;
    for (let i = 0; i < this.groups.length; i++) {
      const size = this.groups[i].size;
      if (remaining < size) {
        return this.groupWorldStarts[i] + remaining;
      }
      remaining -= size;
    }
    return this.totalWorldWidth;
  }

  /**
   * Map a world X coordinate back to a raw matrix column index (inverse of
   * {@link mapColToWorldX}). Returns -1 if the coordinate falls inside a gap
   * or outside the data.
   */
  mapWorldXToCol(worldX: number): number {
    if (worldX < 0 || worldX > this.totalWorldWidth) return -1;
    // Binary search over group WORLD starts for the group whose
    // [worldStart, worldStart+size) contains worldX.
    let lo = 0;
    let hi = this.groupWorldStarts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const start = this.groupWorldStarts[mid];
      const end = start + this.groups[mid].size;
      if (worldX < start) {
        hi = mid - 1;
      } else if (worldX >= end) {
        lo = mid + 1;
      } else {
        return this.groupRawStarts[mid] + Math.floor(worldX - start);
      }
    }
    // worldX is in a gap region between groups.
    return -1;
  }

  /** True if a world X coordinate falls inside a cluster gap. */
  isInGap(worldX: number): boolean {
    return (
      worldX >= 0 &&
      worldX <= this.totalWorldWidth &&
      this.mapWorldXToCol(worldX) === -1
    );
  }
}
