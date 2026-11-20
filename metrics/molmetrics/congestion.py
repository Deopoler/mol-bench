"""Feature Congestion visual clutter metric (Rosenholtz, Li & Nakano 2007).

Computes local covariance volume of OKLab color, DoG luminance contrast, and
structure-tensor orientation across 3 spatial scales, combined per Rosenholtz et al.
(2007), "Measuring visual clutter", Journal of Vision 7(2):17.
"""

from __future__ import annotations

import cv2
import numpy as np

from .color import srgb_to_oklab

# Regularization / feature normalization weights calibrated to Rosenholtz 2007 scales.
_COLOR_REG = 1e-6
_CONTRAST_WEIGHT = 1.0
_COLOR_WEIGHT = 1.0
_ORIENT_WEIGHT = 1.0
_NUM_SCALES = 3


def _det3x3_sym(
    c00: np.ndarray,
    c11: np.ndarray,
    c22: np.ndarray,
    c01: np.ndarray,
    c02: np.ndarray,
    c12: np.ndarray,
) -> np.ndarray:
    """Closed-form determinant of a symmetric 3x3 covariance matrix field."""
    return (
        c00 * (c11 * c22 - c12 * c12)
        - c01 * (c01 * c22 - c12 * c02)
        + c02 * (c01 * c12 - c11 * c02)
    )


def _blur(arr: np.ndarray, sigma: float) -> np.ndarray:
    return cv2.GaussianBlur(arr, (0, 0), sigmaX=sigma, sigmaY=sigma, borderType=cv2.BORDER_REFLECT101)


def _color_congestion_scale(lab: np.ndarray) -> np.ndarray:
    """Local 3x3 OKLab covariance volume sqrt(det(Sigma))^(1/3) at a single pyramid scale."""
    l_ch = lab[..., 0]
    a_ch = lab[..., 1]
    b_ch = lab[..., 2]

    sigma_w = 3.0
    ml = _blur(l_ch, sigma_w)
    ma = _blur(a_ch, sigma_w)
    mb = _blur(b_ch, sigma_w)

    # Subtract local mean before squaring to avoid float32 catastrophic cancellation on flat regions.
    dl = l_ch - ml
    da = a_ch - ma
    db = b_ch - mb

    c00 = _blur(dl * dl, sigma_w) + _COLOR_REG
    c11 = _blur(da * da, sigma_w) + _COLOR_REG
    c22 = _blur(db * db, sigma_w) + _COLOR_REG
    c01 = _blur(dl * da, sigma_w)
    c02 = _blur(dl * db, sigma_w)
    c12 = _blur(da * db, sigma_w)

    det = _det3x3_sym(c00, c11, c22, c01, c02, c12)
    base_floor = _COLOR_REG ** 0.5
    vol = np.power(np.maximum(det, 0.0), 1.0 / 6.0) - base_floor
    return np.maximum(vol, 0.0)


def _contrast_congestion_scale(lum: np.ndarray) -> np.ndarray:
    """Local std of Difference-of-Gaussians luminance contrast at a single scale."""
    dog = _blur(lum, 1.0) - _blur(lum, 2.0)
    sigma_w = 3.0
    mu = _blur(dog, sigma_w)
    diff = dog - mu
    var = np.maximum(_blur(diff * diff, sigma_w), 0.0)
    return np.sqrt(var)


def _orientation_congestion_scale(lum: np.ndarray) -> np.ndarray:
    """Local structure-tensor orientation clutter sqrt(lambda1 * lambda2)^(1/2) at a single scale."""
    # Smooth slightly before derivative to suppress 1-px numerical noise.
    lum_s = _blur(lum, 0.8)
    gx = cv2.Sobel(lum_s, cv2.CV_32F, 1, 0, ksize=3, scale=0.25)
    gy = cv2.Sobel(lum_s, cv2.CV_32F, 0, 1, ksize=3, scale=0.25)

    sigma_w = 3.0
    jxx = _blur(gx * gx, sigma_w)
    jyy = _blur(gy * gy, sigma_w)
    jxy = _blur(gx * gy, sigma_w)

    det_j = np.maximum(jxx * jyy - jxy * jxy, 0.0)
    # det(J)^(1/4) is linear in contrast and vanishes for 1D straight edges (lambda_min == 0).
    return np.power(det_j, 0.25)


def congestion_map(img: np.ndarray) -> np.ndarray:
    """Compute per-pixel Feature Congestion map across 3 Gaussian pyramid scales."""
    lab = srgb_to_oklab(img).astype(np.float32)
    h0, w0 = lab.shape[:2]

    max_color = np.zeros((h0, w0), dtype=np.float32)
    max_contrast = np.zeros((h0, w0), dtype=np.float32)
    max_orient = np.zeros((h0, w0), dtype=np.float32)

    cur_lab = lab
    for scale in range(_NUM_SCALES):
        if cur_lab.shape[0] < 4 or cur_lab.shape[1] < 4:
            break
        cur_lum = cur_lab[..., 0]
        c_col = _color_congestion_scale(cur_lab)
        c_con = _contrast_congestion_scale(cur_lum)
        c_ori = _orientation_congestion_scale(cur_lum)

        if scale > 0:
            c_col = cv2.resize(c_col, (w0, h0), interpolation=cv2.INTER_LINEAR)
            c_con = cv2.resize(c_con, (w0, h0), interpolation=cv2.INTER_LINEAR)
            c_ori = cv2.resize(c_ori, (w0, h0), interpolation=cv2.INTER_LINEAR)

        np.maximum(max_color, c_col, out=max_color)
        np.maximum(max_contrast, c_con, out=max_contrast)
        np.maximum(max_orient, c_ori, out=max_orient)

        if scale + 1 < _NUM_SCALES:
            cur_lab = cv2.pyrDown(cur_lab)

    # Empirical scale normalization commensurate with Rosenholtz et al. (2007).
    return (
        _COLOR_WEIGHT * (max_color / 0.05)
        + _CONTRAST_WEIGHT * (max_contrast / 0.05)
        + _ORIENT_WEIGHT * (max_orient / 0.05)
    ) / 3.0


def feature_congestion(img: np.ndarray) -> float:
    """visual.congestion: mean Feature Congestion across the viewport."""
    return float(np.mean(congestion_map(img)))
