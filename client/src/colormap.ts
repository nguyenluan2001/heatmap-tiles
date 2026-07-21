/**
 * Client-side colormap utilities.
 *
 * The server already renders tiles to coloured PNGs, so the client normally
 * just displays them. These helpers are used for the legend / colour bar and
 * for mapping expression values to colours in tooltips.
 */

// 10-stop viridis, matching backend/colormap.py.
const VIRIDIS_STOPS: [number, number, number][] = [
    [68, 1, 84],
    [72, 40, 120],
    [62, 73, 137],
    [49, 104, 142],
    [38, 130, 142],
    [31, 158, 137],
    [53, 183, 121],
    [110, 206, 88],
    [181, 222, 43],
    [253, 231, 37],
]

/** Linear interpolation between two RGB stops. */
function lerpColor(
    a: [number, number, number],
    b: [number, number, number],
    t: number,
): [number, number, number] {
    return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t),
    ]
}

/** Map a normalised value in [0,1] to an RGB triple. */
export function viridis(t: number): [number, number, number] {
    const x = Math.min(1, Math.max(0, t))
    const scaled = x * (VIRIDIS_STOPS.length - 1)
    const i = Math.floor(scaled)
    const f = scaled - i
    if (i >= VIRIDIS_STOPS.length - 1) return VIRIDIS_STOPS[VIRIDIS_STOPS.length - 1]
    return lerpColor(VIRIDIS_STOPS[i], VIRIDIS_STOPS[i + 1], f)
}

/** CSS rgb() string for a normalised value. */
export function viridisCss(t: number): string {
    const [r, g, b] = viridis(t)
    return `rgb(${r}, ${g}, ${b})`
}
