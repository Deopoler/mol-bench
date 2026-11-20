"""Renovation mask (mask.*) metrics: element_ssim and silhouette_delta."""

from __future__ import annotations

from typing import Sequence

import numpy as np
from PIL import Image
from skimage.metrics import structural_similarity

from .color import srgb_to_oklab, srgb_to_oklab_l
from .scene import silhouette_mask


def crop_bbox(img: np.ndarray, bbox: Sequence[float] | dict[str, float]) -> np.ndarray:
    """Crop [x, y, w, h] or {x, y, width, height} from an image, clamped to bounds."""
    if isinstance(bbox, dict):
        x = int(round(float(bbox["x"])))
        y = int(round(float(bbox["y"])))
        w = int(round(float(bbox.get("width", bbox.get("w", 0)))))
        h = int(round(float(bbox.get("height", bbox.get("h", 0)))))
    else:
        x, y, w, h = (int(round(float(v))) for v in bbox[:4])

    img_h, img_w = img.shape[:2]
    x0 = max(0, x)
    y0 = max(0, y)
    x1 = min(img_w, x + w)
    y1 = min(img_h, y + h)
    if x1 <= x0 or y1 <= y0:
        return np.empty((0, 0, img.shape[2]), dtype=img.dtype)
    return img[y0:y1, x0:x1]


def element_ssim_pair(crop_start: np.ndarray, crop_sub: np.ndarray) -> float:
    """mask.element_ssim for one protected element crop pair.

    Resizes submission crop to start crop size if both dimensions differ by <= 4 px;
    otherwise returns 0.0. SSIM uses OKLab L, data_range=1, gaussian_weights=True, sigma=1.5.
    """
    hs, ws = crop_start.shape[:2]
    hb, wb = crop_sub.shape[:2]
    if hs == 0 or ws == 0 or hb == 0 or wb == 0:
        return 0.0
    if abs(hs - hb) > 4 or abs(ws - wb) > 4:
        return 0.0

    sub_aligned = crop_sub
    if (hb, wb) != (hs, ws):
        pil = Image.fromarray(crop_sub).resize((ws, hs), Image.Resampling.BILINEAR)
        sub_aligned = np.asarray(pil, dtype=np.uint8)

    l_start = srgb_to_oklab_l(crop_start)
    l_sub = srgb_to_oklab_l(sub_aligned)

    min_dim = min(hs, ws)
    if min_dim < 3:
        # Pad tiny crops symmetrically to at least 3x3 so Gaussian windowing can run.
        pad_h = max(0, 3 - hs)
        pad_w = max(0, 3 - ws)
        l_start = np.pad(l_start, ((0, pad_h), (0, pad_w)), mode="edge")
        l_sub = np.pad(l_sub, ((0, pad_h), (0, pad_w)), mode="edge")
        min_dim = min(l_start.shape)

    if min_dim >= 11:
        val = structural_similarity(
            l_start, l_sub, data_range=1.0, gaussian_weights=True, sigma=1.5
        )
    else:
        win = min_dim if min_dim % 2 == 1 else min_dim - 1
        val = structural_similarity(
            l_start, l_sub, data_range=1.0, gaussian_weights=True, sigma=1.5, win_size=win
        )
    return float(val)


def element_ssim(crop_pairs: Sequence[tuple[np.ndarray, np.ndarray]]) -> float:
    """mask.element_ssim: minimum SSIM across protected element crop pairs."""
    if not crop_pairs:
        return 0.0
    return float(min(element_ssim_pair(c_start, c_sub) for c_start, c_sub in crop_pairs))


def silhouette_delta(
    img_start: np.ndarray,
    img_sub: np.ndarray,
    mask: np.ndarray | None = None,
) -> float:
    """mask.silhouette_delta: mean ΔE_OK over the start silhouette mask."""
    sil = silhouette_mask(img_start) if mask is None else np.asarray(mask, dtype=bool)
    if not np.any(sil):
        return 0.0
    lab_start = srgb_to_oklab(img_start)
    lab_sub = srgb_to_oklab(img_sub)
    diff = lab_sub[sil] - lab_start[sil]
    de = np.linalg.norm(diff, axis=1)
    return float(np.mean(de))
