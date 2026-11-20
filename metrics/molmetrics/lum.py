"""Luminance (lum.*) metrics based on OKLab lightness L."""

from __future__ import annotations

import numpy as np

from .color import srgb_to_oklab_l


def lum_mean(img: np.ndarray) -> float:
    """lum.mean: mean OKLab lightness L over the frame."""
    return float(np.mean(srgb_to_oklab_l(img)))


def highlight_frac(img: np.ndarray) -> float:
    """lum.highlight_frac: fraction of pixels with OKLab L > 0.80."""
    return float(np.mean(srgb_to_oklab_l(img) > 0.80))


def lum_floor(img: np.ndarray) -> bool:
    """lum.floor: pass if lum.mean >= 0.08."""
    return bool(lum_mean(img) >= 0.08)
