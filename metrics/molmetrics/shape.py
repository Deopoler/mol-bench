"""Shape (shape.*) metrics: shape.circularity."""

from __future__ import annotations

from typing import Sequence

import cv2
import numpy as np
from scipy.ndimage import gaussian_filter
from skimage.measure import find_contours


def _mask_from_color(img: np.ndarray, mask_color: Sequence[float]) -> np.ndarray:
    """Extract boolean mask matching `focusedMaskColor` (0..255 or 0..1 RGB)."""
    col = np.asarray(mask_color, dtype=np.float64)
    if np.max(col) <= 1.0 and img.dtype == np.uint8:
        # Handle normalized [0..1] RGB color against uint8 image.
        col = col * 255.0
    arr = img.astype(np.float64)
    diff = np.linalg.norm(arr - col[None, None, :], axis=2)
    return diff <= 8.0


def _mask_from_flood_fill(img: np.ndarray, center: Sequence[float]) -> np.ndarray:
    """Extract connected object mask by floating-range flood fill from projected center (x, y)."""
    h, w = img.shape[:2]
    cx = int(round(float(center[0])))
    cy = int(round(float(center[1])))
    if not (0 <= cx < w and 0 <= cy < h):
        raise ValueError(f"Projected center ({cx}, {cy}) outside image bounds ({w}x{h})")

    bgr = img.copy() if img.dtype == np.uint8 else np.clip(img * 255.0, 0, 255).astype(np.uint8)
    ff_mask = np.zeros((h + 2, w + 2), dtype=np.uint8)
    flags = 8 | (255 << 8) | cv2.FLOODFILL_MASK_ONLY
    cv2.floodFill(bgr, ff_mask, (cx, cy), (255, 255, 255), (10, 10, 10), (10, 10, 10), flags)
    return ff_mask[1:-1, 1:-1] > 0


def circularity_from_mask(mask: np.ndarray) -> float:
    """Compute 4*pi*area / perimeter^2 on a boolean mask via marching squares perimeter."""
    m = np.asarray(mask, dtype=bool)
    area = float(np.sum(m))
    if area <= 0.0:
        return 0.0

    padded = np.pad(m.astype(np.float64), pad_width=2, mode="constant", constant_values=0.0)
    # Mild sub-pixel smoothing removes 4-connected staircase bias on discrete binary masks.
    smoothed = gaussian_filter(padded, sigma=0.9)
    contours = find_contours(smoothed, level=0.5)
    if not contours:
        return 0.0

    perimeter = 0.0
    for c in contours:
        diffs = np.diff(c, axis=0)
        perimeter += float(np.sum(np.hypot(diffs[:, 0], diffs[:, 1])))

    if perimeter <= 0.0:
        return 0.0
    return float((4.0 * np.pi * area) / (perimeter * perimeter))


def circularity(
    img: np.ndarray | None = None,
    *,
    mask: np.ndarray | None = None,
    mask_color: Sequence[float] | None = None,
    center: Sequence[float] | dict[str, float] | None = None,
) -> float:
    """shape.circularity: 4*pi*area / perimeter^2 of the focused planet silhouette."""
    if mask is not None:
        return circularity_from_mask(mask)
    if img is None:
        raise ValueError("Either `mask` or `img` must be provided to `circularity`")
    if mask_color is not None:
        return circularity_from_mask(_mask_from_color(img, mask_color))
    if center is not None:
        pt = [center["x"], center["y"]] if isinstance(center, dict) else center
        return circularity_from_mask(_mask_from_flood_fill(img, pt))
    # Fallback: threshold non-background pixels (L > 0.05)
    return circularity_from_mask(np.max(img, axis=2) > 12)
