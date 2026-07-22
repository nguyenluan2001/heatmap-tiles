/**
 * Client-side colormap utilities.
 *
 * Per the architecture spec (Rule #2), colour mapping is 100% handled on the
 * GPU via a 256x1 LUT texture. These helpers build the LUT pixel data for each
 * palette and provide CSS colours for the legend / colour bar.
 */

export type PaletteName = "viridis" | "magma" | "plasma" | "inferno" | "YlOrRd";

/** RGB control-point stops for each palette (matching matplotlib). */
const PALETTE_STOPS: Record<PaletteName, [number, number, number][]> = {
  viridis: [
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
  ],
  magma: [
    [0, 0, 4],
    [28, 16, 68],
    [79, 18, 123],
    [129, 37, 129],
    [181, 54, 122],
    [229, 80, 100],
    [251, 135, 97],
    [254, 194, 135],
    [252, 253, 191],
  ],
  plasma: [
    [13, 8, 135],
    [75, 3, 161],
    [125, 3, 168],
    [168, 34, 150],
    [203, 70, 121],
    [229, 107, 93],
    [248, 148, 65],
    [253, 195, 40],
    [240, 249, 33],
  ],
  inferno: [
    [0, 0, 4],
    [31, 12, 72],
    [85, 15, 109],
    [136, 34, 106],
    [186, 54, 85],
    [227, 89, 51],
    [249, 140, 10],
    [249, 201, 50],
    [252, 255, 164],
  ],
  YlOrRd: [
    [255, 255, 204],
    [255, 237, 160],
    [254, 217, 118],
    [254, 178, 76],
    [253, 141, 60],
    [252, 78, 42],
    [227, 26, 28],
    [189, 0, 38],
    [128, 0, 38],
  ],
};

export const PALETTE_NAMES: PaletteName[] = [
  "YlOrRd",
  "viridis",
  "magma",
  "plasma",
  "inferno",
];

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
  ];
}

/** Map a normalised value in [0,1] to an RGB triple for a given palette. */
export function paletteColor(
  palette: PaletteName,
  t: number,
): [number, number, number] {
  const stops = PALETTE_STOPS[palette];
  const x = Math.min(1, Math.max(0, t));
  const scaled = x * (stops.length - 1);
  const i = Math.floor(scaled);
  const f = scaled - i;
  if (i >= stops.length - 1) return stops[stops.length - 1];
  return lerpColor(stops[i], stops[i + 1], f);
}

/** Backward-compatible viridis helper. */
export function viridis(t: number): [number, number, number] {
  return paletteColor("viridis", t);
}

/** CSS rgb() string for a normalised value in a given palette. */
export function paletteCss(palette: PaletteName, t: number): string {
  const [r, g, b] = paletteColor(palette, t);
  return `rgb(${r}, ${g}, ${b})`;
}

/** Backward-compatible viridis CSS helper. */
export function viridisCss(t: number): string {
  return paletteCss("viridis", t);
}

export const LUT_SIZE = 256;

/**
 * Build a 256x1 RGBA LUT texture as a flat Uint8Array (1024 bytes).
 *
 * The GPU fragment shader samples this 1D texture with the normalised
 * expression value to obtain the heatmap colour. Index 0 maps to the lowest
 * expression; index 255 to the highest.
 */
export function buildLutData(palette: PaletteName): Uint8Array {
  const data = new Uint8Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1);
    const [r, g, b] = paletteColor(palette, t);
    data[i * 4 + 0] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return data;
}

/** Cache of LUT pixel data per palette (built once, reused). */
const _lutCache = new Map<PaletteName, Uint8Array>();

/** Get the cached LUT data for a palette, building it on first use. */
export function getLutData(palette: PaletteName): Uint8Array {
  let data = _lutCache.get(palette);
  if (!data) {
    data = buildLutData(palette);
    _lutCache.set(palette, data);
  }
  return data;
}
