"""Visual quality (visual.*) metrics: congestion and edge_density."""

from __future__ import annotations

import numpy as np
from skimage.feature import canny

from .color import srgb_to_oklab_l
from .congestion import feature_congestion


def congestion(img: np.ndarray) -> float:
    """visual.congestion: Rosenholtz et al. (2007) Feature Congestion."""
    return feature_congestion(img)


def edge_density(img: np.ndarray) -> float:
    """visual.edge_density: fraction of pixels on Canny edges of OKLab L (thresholds 0.05 / 0.15)."""
    l_img = srgb_to_oklab_l(img)
    edges = canny(l_img, sigma=1.0, low_threshold=0.05, high_threshold=0.15)
    return float(np.mean(edges))
