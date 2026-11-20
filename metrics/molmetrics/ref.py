"""Reference comparison (ref.*) and interaction (interact.pointer_response) metrics."""

from __future__ import annotations

import numpy as np

from .color import srgb_to_oklab_l
from .flip import mean_flip


def ref_flip(img_sub: np.ndarray, img_ref: np.ndarray) -> float:
    """ref.flip: mean LDR-FLIP between submission frame and reference render."""
    return mean_flip(img_ref, img_sub)


def ref_lum_delta(img_sub: np.ndarray, img_ref: np.ndarray) -> float:
    """ref.lum_delta: |mean L(submission) - mean L(reference)|."""
    l_sub = float(np.mean(srgb_to_oklab_l(img_sub)))
    l_ref = float(np.mean(srgb_to_oklab_l(img_ref)))
    return float(abs(l_sub - l_ref))


def pointer_response(img_left: np.ndarray, img_right: np.ndarray) -> float:
    """interact.pointer_response: mean FLIP between pointer_left and pointer_right frames."""
    return mean_flip(img_left, img_right)
