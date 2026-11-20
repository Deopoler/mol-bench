# Copyright (c) 2020-2024, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# This module is a pure-NumPy/SciPy port of the published NVIDIA LDR-FLIP
# reference algorithm:
#   Pontus Andersson, Jim Nilsson, Tomas Akenine-Moller, Magnus Oskarsson,
#   Kalle Astrom, and Mark D. Fairchild,
#   "FLIP: A Difference Evaluator for Alternating Images",
#   Proc. ACM Comput. Graph. Interact. Tech., 3(2), 2020.
#
# NVIDIA's reference FLIP implementation is licensed under the BSD 3-Clause
# License (https://github.com/NVlabs/flip). This port credits that reference
# algorithm and license while providing a standalone NumPy implementation.

"""LDR-FLIP perceptual image difference evaluator."""

from __future__ import annotations

import cv2
import numpy as np

from .color import _SRGB_TO_LINEAR_LUT

# Default viewing geometry: 0.7 m distance, 0.7 m monitor width, 3840 px horizontal resolution.
DEFAULT_PIXELS_PER_DEGREE: float = 0.7 * (3840.0 / 0.7) * (np.pi / 180.0)

_LUT_F32 = _SRGB_TO_LINEAR_LUT.astype(np.float32)

# sRGB linear -> CIE XYZ (D65)
_M_RGB_TO_XYZ = np.array([
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
], dtype=np.float32)

_M_XYZ_TO_RGB = np.linalg.inv(_M_RGB_TO_XYZ).astype(np.float32)
_D65_WHITE = _M_RGB_TO_XYZ.sum(axis=1)

# Frequency-domain CSF coefficients (a1, b1, a2, b2) from Andersson et al. (2020)
_CSF_A = ((1.0, 0.0047),)
_CSF_RG = ((0.72, 0.0053), (0.28, 0.0273))
_CSF_BY = ((0.38, 0.0061), (0.62, 0.0470))

# FLIP parameters
_QC = np.float32(0.7)
_QF = np.float32(0.5)
_FEATURE_WIDTH_DEG = 0.082
_EPS = np.float32(1e-7)


def _to_linear_f32(img: np.ndarray) -> np.ndarray:
    arr = np.asarray(img)
    if arr.dtype == np.uint8:
        return _LUT_F32[arr]
    f = np.clip(arr.astype(np.float32, copy=False), 0.0, 1.0)
    return np.where(f <= 0.04045, f / np.float32(12.92), np.power((f + np.float32(0.055)) / np.float32(1.055), np.float32(2.4)))


def _linear_to_xyz(rgb_lin: np.ndarray) -> np.ndarray:
    return rgb_lin @ _M_RGB_TO_XYZ.T


def _xyz_to_linear(xyz: np.ndarray) -> np.ndarray:
    return xyz @ _M_XYZ_TO_RGB.T


def _xyz_to_ycxcz(xyz: np.ndarray) -> np.ndarray:
    xn, yn, zn = _D65_WHITE
    xr = xyz[..., 0] / xn
    yr = xyz[..., 1] / yn
    zr = xyz[..., 2] / zn
    yc = np.float32(116.0) * yr - np.float32(16.0)
    cx = np.float32(500.0) * (xr - yr)
    cz = np.float32(200.0) * (yr - zr)
    return np.stack([yc, cx, cz], axis=-1)


def _ycxcz_to_xyz(ycxcz: np.ndarray) -> np.ndarray:
    xn, yn, zn = _D65_WHITE
    yr = (ycxcz[..., 0] + np.float32(16.0)) / np.float32(116.0)
    xr = yr + ycxcz[..., 1] / np.float32(500.0)
    zr = yr - ycxcz[..., 2] / np.float32(200.0)
    return np.stack([xr * xn, yr * yn, zr * zn], axis=-1)


def _xyz_to_lab(xyz: np.ndarray) -> np.ndarray:
    xn, yn, zn = _D65_WHITE
    t = np.stack([xyz[..., 0] / xn, xyz[..., 1] / yn, xyz[..., 2] / zn], axis=-1)
    delta = np.float32(6.0 / 29.0)
    delta3 = delta ** 3
    f = np.where(t > delta3, np.cbrt(np.maximum(t, 0.0)), t / (np.float32(3.0) * delta * delta) + np.float32(4.0 / 29.0))
    L = np.float32(116.0) * f[..., 1] - np.float32(16.0)
    a = np.float32(500.0) * (f[..., 0] - f[..., 1])
    b = np.float32(200.0) * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], axis=-1)


def _apply_csf_channel(chan: np.ndarray, terms: tuple[tuple[float, float], ...], ppd: float) -> np.ndarray:
    out = np.zeros_like(chan, dtype=np.float32)
    for weight, b_coeff in terms:
        sigma_px = float(ppd * np.sqrt(b_coeff / 2.0) / np.pi)
        blurred = cv2.GaussianBlur(chan, (0, 0), sigmaX=sigma_px, sigmaY=sigma_px, borderType=cv2.BORDER_REPLICATE)
        out += np.float32(weight) * blurred
    return out


def _spatial_filter_ycxcz(ycxcz: np.ndarray, ppd: float) -> np.ndarray:
    yc = _apply_csf_channel(ycxcz[..., 0], _CSF_A, ppd)
    cx = _apply_csf_channel(ycxcz[..., 1], _CSF_RG, ppd)
    cz = _apply_csf_channel(ycxcz[..., 2], _CSF_BY, ppd)
    return np.stack([yc, cx, cz], axis=-1)


def _hunt_adjusted_lab(lab: np.ndarray) -> np.ndarray:
    L = lab[..., 0]
    scale = np.float32(0.01) * L
    return np.stack([L, lab[..., 1] * scale, lab[..., 2] * scale], axis=-1)


def _compute_hyab_max() -> float:
    primaries = np.array([[0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], dtype=np.float32)
    lab = _hunt_adjusted_lab(_xyz_to_lab(_linear_to_xyz(primaries)))
    return float(abs(lab[0, 0] - lab[1, 0]) + np.hypot(lab[0, 1] - lab[1, 1], lab[0, 2] - lab[1, 2]))


_HYAB_MAX = np.float32(_compute_hyab_max())


def _feature_kernels(ppd: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return normalized 1D Gaussian, 1st-derivative, and 2nd-derivative kernels."""
    std_px = 0.5 * _FEATURE_WIDTH_DEG * ppd
    half_width = int(np.ceil(3.0 * std_px))
    x = np.arange(-half_width, half_width + 1, dtype=np.float64)
    g = np.exp(-(x * x) / (2.0 * std_px * std_px))
    g /= np.sum(g)
    dg = -(x / (std_px * std_px)) * g
    dg_norm = np.sum(np.abs(dg))
    if dg_norm > 0:
        dg = dg / (0.5 * dg_norm)
    ddg = ((x * x) / (std_px ** 4) - 1.0 / (std_px * std_px)) * g
    ddg -= np.mean(ddg)
    ddg_pos = np.sum(np.maximum(ddg, 0.0))
    if ddg_pos > 0:
        ddg = ddg / ddg_pos
    return g.astype(np.float32), dg.astype(np.float32), ddg.astype(np.float32)


def _detect_features(y_norm: np.ndarray, g: np.ndarray, dg: np.ndarray, ddg: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Compute (dx, dy, dxx, dyy) on normalized luminance using separable OpenCV filters."""
    dx = cv2.sepFilter2D(y_norm, cv2.CV_32F, dg, g, borderType=cv2.BORDER_REPLICATE)
    dy = cv2.sepFilter2D(y_norm, cv2.CV_32F, g, dg, borderType=cv2.BORDER_REPLICATE)
    dxx = cv2.sepFilter2D(y_norm, cv2.CV_32F, ddg, g, borderType=cv2.BORDER_REPLICATE)
    dyy = cv2.sepFilter2D(y_norm, cv2.CV_32F, g, ddg, borderType=cv2.BORDER_REPLICATE)
    return dx, dy, dxx, dyy


def compute_ldrflip(
    reference: np.ndarray,
    test: np.ndarray,
    pixels_per_degree: float = DEFAULT_PIXELS_PER_DEGREE,
) -> np.ndarray:
    """Compute per-pixel LDR-FLIP error map in [0, 1] between two sRGB images (H, W, 3).

    Identical inputs produce exact 0.0 everywhere.
    """
    ref_arr = np.asarray(reference)
    test_arr = np.asarray(test)
    if ref_arr.shape != test_arr.shape:
        raise ValueError(f"Image shape mismatch: {ref_arr.shape} vs {test_arr.shape}")

    if np.array_equal(ref_arr, test_arr):
        return np.zeros(ref_arr.shape[:2], dtype=np.float64)

    ref_lin = _to_linear_f32(ref_arr)
    test_lin = _to_linear_f32(test_arr)

    ref_xyz = _linear_to_xyz(ref_lin)
    test_xyz = _linear_to_xyz(test_lin)

    # 1. Color difference in spatially CSF-filtered Hunt-adjusted CIELAB via HyAB.
    ref_ycxcz_f = _spatial_filter_ycxcz(_xyz_to_ycxcz(ref_xyz), pixels_per_degree)
    test_ycxcz_f = _spatial_filter_ycxcz(_xyz_to_ycxcz(test_xyz), pixels_per_degree)

    ref_rgb_f = np.clip(_xyz_to_linear(_ycxcz_to_xyz(ref_ycxcz_f)), 0.0, 1.0)
    test_rgb_f = np.clip(_xyz_to_linear(_ycxcz_to_xyz(test_ycxcz_f)), 0.0, 1.0)

    ref_lab = _hunt_adjusted_lab(_xyz_to_lab(_linear_to_xyz(ref_rgb_f)))
    test_lab = _hunt_adjusted_lab(_xyz_to_lab(_linear_to_xyz(test_rgb_f)))

    hyab = np.abs(ref_lab[..., 0] - test_lab[..., 0]) + np.hypot(
        ref_lab[..., 1] - test_lab[..., 1],
        ref_lab[..., 2] - test_lab[..., 2],
    )
    delta_e_c = np.power(np.clip(hyab / _HYAB_MAX, 0.0, 1.0), _QC)

    # 2. Edge and point feature difference on normalized luminance Y in [0, 1].
    g, dg, ddg = _feature_kernels(pixels_per_degree)
    rdx, rdy, rdxx, rdyy = _detect_features(ref_xyz[..., 1], g, dg, ddg)
    tdx, tdy, tdxx, tdyy = _detect_features(test_xyz[..., 1], g, dg, ddg)

    edge_diff = np.hypot(rdx - tdx, rdy - tdy)
    pts_diff = np.hypot(rdxx - tdxx, rdyy - tdyy)
    feat_diff = np.maximum(edge_diff, pts_diff) / np.float32(np.sqrt(2.0))
    delta_e_f = np.power(np.clip(feat_diff, 0.0, 1.0), _QF)

    # 3. Combine color and feature differences.
    flip_map = np.where(delta_e_c > _EPS, np.power(delta_e_c, np.float32(1.0) - delta_e_f), np.float32(0.0))
    return np.clip(flip_map, 0.0, 1.0).astype(np.float64)


def mean_flip(
    reference: np.ndarray,
    test: np.ndarray,
    pixels_per_degree: float = DEFAULT_PIXELS_PER_DEGREE,
) -> float:
    """Compute mean LDR-FLIP across all pixels."""
    return float(np.mean(compute_ldrflip(reference, test, pixels_per_degree=pixels_per_degree)))
