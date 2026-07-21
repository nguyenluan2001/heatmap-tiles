"""Render a 2D tile of expression values to a PNG byte string."""
from __future__ import annotations

import io

import numpy as np
from PIL import Image

from .colormap import get_lut, values_to_rgba
from .config import COLORMAP

_LUT = get_lut(COLORMAP)


def render_tile_png(values: np.ndarray, vmin: float, vmax: float) -> bytes:
    """Render ``values`` (2D float) to an RGBA PNG byte string.

    ``values`` may be smaller than the nominal tile size; it is padded with
    ``NaN`` (rendered transparent) so every served PNG has identical pixel
    dimensions and maps 1:1 onto its world-space tile bounds.
    """
    h, w = values.shape
    if values.dtype != np.float32:
        values = values.astype(np.float32, copy=False)

    rgba = values_to_rgba(values, vmin, vmax, lut=_LUT)
    img = Image.fromarray(rgba, mode="RGBA")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=False, compress_level=6)
    return buf.getvalue()
