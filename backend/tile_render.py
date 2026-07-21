"""Render a 2D tile of expression values to an 8-bit grayscale PNG byte string.

Per the architecture specification (Rule #2: Color Palette Mapping MUST Be On
GPU), the backend NEVER outputs colored tiles. Tiles remain 8-bit single-channel
grayscale raw values; the frontend WebGL fragment shader performs the colour
LUT lookup.

Pixel convention
----------------
- Pixel value ``0``   = minimum expression / padding (null).
- Pixel value ``255`` = maximum expression.

NaN padding (edge tiles) is encoded as ``0`` so the GPU shader can discard it
with a single ``<= 0.001`` threshold, exactly as specified in the fragment
shader guardrails.
"""

from __future__ import annotations

import io

import numpy as np
from PIL import Image


def render_tile_png(values: np.ndarray, vmin: float, vmax: float) -> bytes:
    """Render ``values`` (2D float) to an 8-bit grayscale PNG byte string.

    ``values`` may be smaller than the nominal tile size; it is padded with
    ``0`` (rendered as null/discard by the GPU shader) so every served PNG has
    identical pixel dimensions and maps 1:1 onto its world-space tile bounds.
    """
    if values.dtype != np.float32:
        values = values.astype(np.float32, copy=False)

    nan_mask = np.isnan(values)
    span = (vmax - vmin) or 1.0
    # Replace NaN with 0 before normalising so the int cast never sees NaN
    # (which would otherwise become int32 min and blow up the LUT lookup).
    safe = np.where(nan_mask, 0.0, values)
    norm = np.clip((safe - vmin) / span, 0.0, 1.0)
    # Map to 1..255. 0 is reserved for padding/null so the GPU shader can
    # discard it cleanly; real data always maps to >= 1.
    gray = (norm * 254.0 + 1.0).astype(np.uint8)
    # Padding / NaN -> 0 (transparent/null value, discarded by the shader).
    gray = np.where(nan_mask, 0, gray).astype(np.uint8)

    img = Image.fromarray(gray, mode="L")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=False, compress_level=6)
    return buf.getvalue()
