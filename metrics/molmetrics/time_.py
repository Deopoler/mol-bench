"""Time-series (time.*) metrics: motion, flicker, and flicker_region."""

from __future__ import annotations

from typing import Sequence

import numpy as np

from .color import _M1_LRGB_TO_LMS, _M2_LMS_TO_OKLAB, _SRGB_TO_LINEAR_LUT, srgb_to_oklab_l

_LUT_F32 = _SRGB_TO_LINEAR_LUT.astype(np.float32)
_M1_F32 = _M1_LRGB_TO_LMS.astype(np.float32)
_M2_L_F32 = _M2_LMS_TO_OKLAB[0].astype(np.float32)


def _frame_to_l_f32(img: np.ndarray) -> np.ndarray:
    """Fast float32 OKLab L conversion for large frame sequences."""
    arr = np.asarray(img)
    if arr.dtype == np.uint8:
        lin = _LUT_F32[arr]
    else:
        f = arr.astype(np.float32, copy=False)
        lin = np.where(f <= 0.04045, f / 12.92, np.power((np.maximum(f, 0.0) + 0.055) / 1.055, 2.4)).astype(np.float32)
    lms = lin @ _M1_F32.T
    lms_cbrt = np.cbrt(lms)
    return lms_cbrt @ _M2_L_F32


def motion_from_pairs(pairs: Sequence[tuple[np.ndarray, np.ndarray]]) -> float:
    """time.motion from explicit (frame_t, frame_t_plus_dt) pairs."""
    if not pairs:
        return 0.0
    diffs = []
    for f0, f1 in pairs:
        if np.array_equal(f0, f1):
            diffs.append(0.0)
        else:
            l0 = _frame_to_l_f32(f0)
            l1 = _frame_to_l_f32(f1)
            diffs.append(float(np.mean(np.abs(l1 - l0))))
    return float(np.mean(diffs))


def motion(frames: Sequence[np.ndarray], n_samples: int = 10) -> float:
    """time.motion: mean over 10 evenly spaced t of mean |L(t + 16.667) - L(t)|.

    Accepts either a contiguous frame sequence (length >= 2) or 2*k alternating pair frames
    if explicitly called via `motion_from_pairs`.
    """
    n = len(frames)
    if n < 2:
        return 0.0
    max_idx = n - 2
    if max_idx == 0:
        indices = [0]
    elif n - 1 <= n_samples:
        indices = list(range(n - 1))
    else:
        indices = [int(round(k * max_idx / (n_samples - 1))) for k in range(n_samples)]
    pairs = [(frames[i], frames[i + 1]) for i in indices]
    return motion_from_pairs(pairs)


def flicker(
    frames: Sequence[np.ndarray],
    dt_ms: float = 16.667,
    mask: np.ndarray | None = None,
    freq_cutoff_hz: float = 10.0,
    ac_energy_threshold: float = 1e-6,
) -> float:
    """time.flicker / time.flicker_region.

    For each pixel (optionally restricted to `mask`), compute the FFT of its mean-removed
    OKLab L time series across T frames (dt = 16.667 ms).
    Value = sum(energy > 10 Hz) / sum(AC energy), averaged over pixels with AC energy > 1e-6.
    Static frames give 0.0.
    """
    t_count = len(frames)
    if t_count < 2:
        return 0.0

    h, w = frames[0].shape[:2]
    l_cube = np.empty((t_count, h, w), dtype=np.float32)
    for i, frame in enumerate(frames):
        l_cube[i] = _frame_to_l_f32(frame)

    dt_s = float(dt_ms) / 1000.0
    freqs = np.fft.rfftfreq(t_count, d=dt_s)
    hi_mask = freqs > freq_cutoff_hz

    # Two-sided Parseval weighting for rfft bins: DC (0) and Nyquist (if even) have weight 1, others 2.
    weights = np.full(freqs.shape, 2.0, dtype=np.float64)
    weights[0] = 0.0  # AC only (mean removed)
    if t_count % 2 == 0:
        weights[-1] = 1.0

    if mask is not None:
        m = np.asarray(mask, dtype=bool)
        if m.shape != (h, w):
            raise ValueError(f"Mask shape {m.shape} does not match frame shape {(h, w)}")
        if not np.any(m):
            return 0.0
        # Flatten masked pixels only: shape (T, N_masked)
        series = l_cube[:, m]
        return _flicker_on_matrix(series, hi_mask, weights, t_count, ac_energy_threshold)

    # Full-frame: process in row strips to keep memory small and cache-friendly.
    strip_rows = 150
    ratio_sum = 0.0
    active_count = 0
    for y0 in range(0, h, strip_rows):
        y1 = min(h, y0 + strip_rows)
        strip = l_cube[:, y0:y1, :].reshape(t_count, -1)
        r_sum, act = _flicker_strip_stats(strip, hi_mask, weights, t_count, ac_energy_threshold)
        ratio_sum += r_sum
        active_count += act

    if active_count == 0:
        return 0.0
    return float(ratio_sum / active_count)


def _flicker_strip_stats(
    series: np.ndarray,
    hi_mask: np.ndarray,
    weights: np.ndarray,
    t_count: int,
    ac_energy_threshold: float,
) -> tuple[float, int]:
    """Compute (sum_of_ratios, active_pixel_count) for a (T, N) float32 matrix."""
    centered = series - np.mean(series, axis=0, keepdims=True)
    # Time-domain AC energy sum((L - mean)^2) == (1/T) * sum(weights * |rfft|^2)
    ac_energy = np.sum(centered.astype(np.float64) ** 2, axis=0)
    active = ac_energy > ac_energy_threshold
    if not np.any(active):
        return 0.0, 0
    centered_act = centered[:, active]
    spec = np.fft.rfft(centered_act, axis=0)
    power = (spec.real ** 2 + spec.imag ** 2).astype(np.float64)
    # Normalize by T per Parseval's theorem
    weighted_power = (power * weights[:, None]) / float(t_count)
    total_ac = np.sum(weighted_power[1:], axis=0)
    hi_ac = np.sum(weighted_power[hi_mask], axis=0)
    valid = total_ac > ac_energy_threshold
    if not np.any(valid):
        return 0.0, 0
    ratios = hi_ac[valid] / total_ac[valid]
    return float(np.sum(ratios)), int(np.sum(valid))


def _flicker_on_matrix(
    series: np.ndarray,
    hi_mask: np.ndarray,
    weights: np.ndarray,
    t_count: int,
    ac_energy_threshold: float,
) -> float:
    r_sum, act = _flicker_strip_stats(series, hi_mask, weights, t_count, ac_energy_threshold)
    if act == 0:
        return 0.0
    return float(r_sum / act)


def flicker_region(
    frames: Sequence[np.ndarray],
    mask: np.ndarray,
    dt_ms: float = 16.667,
) -> float:
    """time.flicker_region: time.flicker restricted to a boolean region mask."""
    return flicker(frames, dt_ms=dt_ms, mask=mask)


def reduced_motion_not_blank(
    normal_img: np.ndarray,
    rm_img: np.ndarray,
    star_counter,
) -> bool:
    """reduced_motion.not_blank: lum.mean within +-20% and star_count within +-30% of normal."""
    l_norm = float(np.mean(srgb_to_oklab_l(normal_img)))
    l_rm = float(np.mean(srgb_to_oklab_l(rm_img)))
    if l_norm <= 0.0:
        lum_ok = abs(l_rm - l_norm) <= 1e-6
    else:
        lum_ok = abs(l_rm - l_norm) <= 0.20 * l_norm

    s_norm = star_counter(normal_img)
    s_rm = star_counter(rm_img)
    if s_norm <= 0:
        stars_ok = s_rm == 0
    else:
        stars_ok = abs(s_rm - s_norm) <= 0.30 * s_norm

    return bool(lum_ok and stars_ok)
