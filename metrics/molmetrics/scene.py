"""Scene structure (scene.*) metrics: star_count, star_roundness, silhouette, silhouette_iou."""

from __future__ import annotations

import numpy as np
from scipy.ndimage import uniform_filter
from skimage.measure import label, regionprops

from .color import srgb_to_oklab_l


def _star_components(img: np.ndarray) -> list:
    """Detect star seed components in top 60% of frame."""
    l_img = srgb_to_oklab_l(img)
    top_h = int(round(0.60 * l_img.shape[0]))
    if top_h < 1:
        return []
    l_top = l_img[:top_h, :]

    # 7x7 ring excluding center 3x3: (49 * mean_7x7 - 9 * mean_3x3) / 40
    mean7 = uniform_filter(l_top, size=7, mode="reflect")
    mean3 = uniform_filter(l_top, size=3, mode="reflect")
    ring_mean = (49.0 * mean7 - 9.0 * mean3) / 40.0

    seeds = (l_top > 0.6) & ((l_top - ring_mean) > 0.25)
    if not np.any(seeds):
        return []
    lbl = label(seeds, connectivity=2)
    return regionprops(lbl)


def star_count(img: np.ndarray) -> int:
    """scene.star_count: count of connected star components (1 <= area <= 25 px) in top 60%."""
    props = _star_components(img)
    return int(sum(1 for p in props if 1 <= p.area <= 25))


def star_roundness(img: np.ndarray) -> float:
    """scene.star_roundness: median sqrt(lambda_max / lambda_min) for star components with area >= 4.

    Returns 0.0 if no stars with area >= 4 are found.
    """
    props = _star_components(img)
    ratios = []
    for p in props:
        if 4 <= p.area <= 100:
            eig_max, eig_min = p.inertia_tensor_eigvals
            ratios.append(float(np.sqrt(max(eig_max, 0.0) / max(eig_min, 1e-12))))
    if not ratios:
        return 0.0
    return float(np.median(ratios))


def _horizon_rows(l_img: np.ndarray) -> np.ndarray:
    """Per-column horizon row index: first row in bottom 30% where L < 0.6 * column sky mean."""
    h, _w = l_img.shape
    y_start = int(round(0.70 * h))
    sky_mean = np.mean(l_img[:y_start, :], axis=0) if y_start > 0 else np.mean(l_img, axis=0)
    thresh = 0.6 * sky_mean
    below = l_img[y_start:, :] < thresh[None, :]
    has_drop = np.any(below, axis=0)
    first_idx = np.argmax(below, axis=0)
    return np.where(has_drop, y_start + first_idx, h).astype(np.float64)


def silhouette(img: np.ndarray) -> bool:
    """scene.silhouette: pass if bottom 6% is darker than 30-40% from bottom by >= 0.05
    AND per-column horizon height std >= 4 px.
    """
    l_img = srgb_to_oklab_l(img)
    h, _w = l_img.shape
    row_bot6 = int(round(0.94 * h))
    row_40_from_bot = int(round(0.60 * h))
    row_30_from_bot = int(round(0.70 * h))

    mean_bot6 = float(np.mean(l_img[row_bot6:, :]))
    mean_30_40 = float(np.mean(l_img[row_40_from_bot:row_30_from_bot, :]))
    cond1 = mean_bot6 <= (mean_30_40 - 0.05)

    horizon = _horizon_rows(l_img)
    cond2 = float(np.std(horizon)) >= 4.0
    return bool(cond1 and cond2)


def silhouette_mask(img: np.ndarray) -> np.ndarray:
    """Boolean mask of pixels at or below the per-column horizon height."""
    l_img = srgb_to_oklab_l(img)
    h, _w = l_img.shape
    horizon = _horizon_rows(l_img)
    rows = np.arange(h, dtype=np.float64)[:, None]
    return rows >= horizon[None, :]


def silhouette_iou(img_start: np.ndarray, img_sub: np.ndarray) -> float:
    """scene.silhouette_iou: IoU between start and submission silhouette masks."""
    m1 = silhouette_mask(img_start)
    m2 = silhouette_mask(img_sub)
    inter = int(np.sum(m1 & m2))
    union = int(np.sum(m1 | m2))
    if union == 0:
        return 1.0 if inter == 0 else 0.0
    return float(inter / union)
