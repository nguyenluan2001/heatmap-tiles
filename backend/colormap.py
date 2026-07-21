"""Lightweight, dependency-free colormaps for tile rendering.

We avoid matplotlib by interpolating a small set of control points into a
256-entry lookup table. The LUT is built once at import time.
"""
from __future__ import annotations

import numpy as np

# 10-stop viridis (matches the canonical ColorBrewer-like viridis scale).
_VIRIDIS_STOPS = [
    (68, 1, 84),
    (72, 40, 120),
    (62, 73, 137),
    (49, 104, 142),
    (38, 130, 142),
    (31, 158, 137),
    (53, 183, 121),
    (110, 206, 88),
    (181, 222, 43),
    (253, 231, 37),
]

# 9-stop magma (good for expression heatmaps, perceptually uniform).
_MAGMA_STOPS = [
    (0, 0, 4),
    (28, 16, 68),
    (79, 18, 123),
    (129, 37, 129),
    (181, 54, 122),
    (229, 80, 100),
    (251, 135, 97),
    (254, 194, 135),
    (252, 253, 191),
]

_STOPS = {
    "viridis": _VIRIDIS_STOPS,
    "magma": _MAGMA_STOPS,
}


def build_lut(stops: list[tuple[int, int, int]], n: int = 256) -> np.ndarray:
    """Interpolate ``stops`` into an ``(n, 3)`` uint8 RGB lookup table."""
    stops_arr = np.asarray(stops, dtype=np.float32)
    lut = np.zeros((n, 3), dtype=np.uint8)
    for i in range(n):
        t = i / (n - 1) * (len(stops_arr) - 1)
        j = int(t)
        f = t - j
        if j >= len(stops_arr) - 1:
            j = len(stops_arr) - 2
            f = 1.0
        c0 = stops_arr[j]
        c1 = stops_arr[j + 1]
        lut[i] = (c0 * (1.0 - f) + c1 * f).astype(np.uint8)
    return lut


def get_lut(name: str) -> np.ndarray:
    stops = _STOPS.get(name, _VIRIDIS_STOPS)
    return build_lut(stops)


def values_to_rgba(
    values: np.ndarray,
    vmin: float,
    vmax: float,
    lut: np.ndarray | None = None,
) -> np.ndarray:
    """Map a 2D float array to an ``(H, W, 4)`` uint8 RGBA image.

    ``NaN`` values become fully transparent (alpha 0) so edge-padded tiles do
    not draw fake data outside the matrix.
    """
    if lut is None:
        lut = build_lut(_VIRIDIS_STOPS)
    nan_mask = np.isnan(values)
    span = (vmax - vmin) or 1.0
    # Replace NaN with 0 before normalising so the int cast never sees NaN
    # (which would otherwise become int32 min and blow up the LUT lookup).
    safe = np.where(nan_mask, 0.0, values)
    norm = np.clip((safe - vmin) / span, 0.0, 1.0)
    idx = (norm * (lut.shape[0] - 1)).astype(np.int32)
    rgb = lut[idx]  # (H, W, 3)
    alpha = np.where(nan_mask, 0, 255).astype(np.uint8)
    return np.dstack([rgb, alpha])
