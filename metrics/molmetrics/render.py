"""Rendering artifact (render.*) metrics: banding, aliasing, stripe_energy, flip_vs_start."""

from __future__ import annotations

import numpy as np
from scipy.ndimage import binary_dilation, gaussian_filter
from skimage.feature import canny

from .color import srgb_to_oklab_l, y8_luma
from .flip import compute_ldrflip, mean_flip


def _has_left_const_run(eq: np.ndarray, run_len: int) -> np.ndarray:
    """Given adjacent-equal bool array of length M-1, return bool mask of length M where
    the `run_len` pixels ending at index i (i >= run_len-1) are all equal."""
    # `run_len` equal pixels require `run_len - 1` consecutive True entries in `eq`.
    k = run_len - 1
    out = np.zeros(eq.shape[0] + 1, dtype=bool)
    if eq.shape[0] < k:
        return out
    cs = np.empty(eq.shape[0] + 1, dtype=np.int32)
    cs[0] = 0
    np.cumsum(eq.astype(np.int32), out=cs[1:])
    window_sum = cs[k:] - cs[:-k]
    out[k:] = window_sum == k
    return out


def _banding_1d_steps(y8: np.ndarray, run_len: int = 8) -> np.ndarray:
    """Detect horizontal band-step pixels along axis=1 (step==1 with 8 constant pixels on each side)."""
    h, w = y8.shape
    steps = np.zeros((h, w), dtype=bool)
    if w < 2 * run_len:
        return steps

    eq = y8[:, 1:] == y8[:, :-1]  # (H, W - 1)
    k = run_len - 1  # 7 consecutive equal transitions

    # Vectorized sliding sum over axis=1 using cumulative sum
    cs = np.zeros((h, w), dtype=np.int32)
    np.cumsum(eq.astype(np.int32), axis=1, out=cs[:, 1:])
    # run_ending_at[y, x] is True if y8[y, x-7 : x+1] are all equal (valid for x >= 7)
    left_const = np.zeros((h, w), dtype=bool)
    left_const[:, k:] = (cs[:, k:] - cs[:, :-k]) == k

    # right_const[y, x] is True if y8[y, x : x+8] are all equal (valid for x <= W - 8)
    right_const = np.zeros((h, w), dtype=bool)
    right_const[:, : w - k] = left_const[:, k:]

    step1 = np.abs(y8[:, :-1] - y8[:, 1:]) == 1
    hit = step1 & left_const[:, :-1] & right_const[:, 1:]
    steps[:, :-1] |= hit
    return steps


def banding(img: np.ndarray) -> float:
    """render.banding: fraction of smooth-mask pixels that are 8-bit quantization band steps.

    Smooth mask = Gaussian-blurred (sigma=2) gradient magnitude of Y8 < 1.5.
    Band step = |Y8(x) - Y8(x+1)| == 1 (horiz or vert) with 8 constant pixels on each side.
    Returns 0.0 if smooth mask covers < 2% of the frame.
    """
    y8 = y8_luma(img)
    gy, gx = np.gradient(y8.astype(np.float64))
    grad_mag = np.hypot(gx, gy)
    smooth_grad = gaussian_filter(grad_mag, sigma=2.0, mode="nearest")
    smooth_mask = smooth_grad < 1.5

    if float(np.mean(smooth_mask)) < 0.02:
        return 0.0

    horiz_steps = _banding_1d_steps(y8, run_len=8)
    vert_steps = _banding_1d_steps(y8.T, run_len=8).T
    band_steps = (horiz_steps | vert_steps) & smooth_mask

    n_smooth = int(np.sum(smooth_mask))
    if n_smooth == 0:
        return 0.0
    return float(np.sum(band_steps) / n_smooth)


def _box_downsample_2x(img: np.ndarray) -> np.ndarray:
    """Box-downsample a (2H, 2W, 3) image by 2x to float64 sRGB in [0, 1]."""
    arr = np.asarray(img)
    if arr.dtype == np.uint8:
        f = arr.astype(np.float64) / 255.0
    else:
        f = np.clip(arr.astype(np.float64, copy=False), 0.0, 1.0)
    h2, w2 = f.shape[:2]
    h = h2 // 2
    w = w2 // 2
    f = f[: 2 * h, : 2 * w]
    return f.reshape(h, 2, w, 2, 3).mean(axis=(1, 3))


def aliasing(img_dpr1: np.ndarray, img_dpr2: np.ndarray) -> float:
    """render.aliasing: mean FLIP(A, B) inside 1px-dilated Canny edge mask of B.

    A = DPR 1 frame, B = DPR 2 frame box-downsampled 2x (or already same shape as A).
    """
    if img_dpr2.shape[:2] == (2 * img_dpr1.shape[0], 2 * img_dpr1.shape[1]):
        b = _box_downsample_2x(img_dpr2)
    elif img_dpr2.shape[:2] == img_dpr1.shape[:2]:
        b = img_dpr2.astype(np.float64) / 255.0 if img_dpr2.dtype == np.uint8 else np.asarray(img_dpr2, dtype=np.float64)
    else:
        raise ValueError(
            f"Incompatible DPR1 {img_dpr1.shape[:2]} and DPR2 {img_dpr2.shape[:2]} shapes"
        )

    l_b = srgb_to_oklab_l(b)
    edges = canny(l_b, sigma=1.0, low_threshold=0.05, high_threshold=0.15)
    edge_mask = binary_dilation(edges, structure=np.ones((3, 3), dtype=bool))
    if not np.any(edge_mask):
        return 0.0

    flip_map = compute_ldrflip(b, img_dpr1)
    return float(np.mean(flip_map[edge_mask]))


def _high_band_fft_ratio(l_img: np.ndarray, mask: np.ndarray) -> float:
    """Ratio of 2D FFT energy in 0.25-0.5 cycles/px to total AC energy inside mask."""
    ys, xs = np.nonzero(mask)
    if ys.size == 0:
        return 0.0
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    x0, x1 = int(xs.min()), int(xs.max()) + 1

    m_crop = mask[y0:y1, x0:x1]
    l_crop = l_img[y0:y1, x0:x1]
    vals = l_crop[m_crop]
    mean_val = float(np.mean(vals))

    signal = np.zeros_like(l_crop, dtype=np.float64)
    signal[m_crop] = vals - mean_val

    hc, wc = signal.shape
    f2 = np.fft.fft2(signal)
    power = f2.real ** 2 + f2.imag ** 2

    fy = np.fft.fftfreq(hc)[:, None]
    fx = np.fft.fftfreq(wc)[None, :]
    freq = np.hypot(fx, fy)

    ac_mask = (fx != 0.0) | (fy != 0.0)
    band_mask = (freq >= 0.25) & (freq <= 0.5 + 1e-12) & ac_mask

    total_ac = float(np.sum(power[ac_mask]))
    if total_ac <= 1e-12:
        return 0.0
    band_energy = float(np.sum(power[band_mask]))
    return band_energy / total_ac


def stripe_energy(img: np.ndarray, ref_img: np.ndarray, mask: np.ndarray) -> float:
    """render.stripe_energy: masked 0.25-0.5 cycles/px energy ratio relative to reference."""
    m = np.asarray(mask, dtype=bool)
    if not np.any(m):
        return 1.0
    r_sub = _high_band_fft_ratio(srgb_to_oklab_l(img), m)
    r_ref = _high_band_fft_ratio(srgb_to_oklab_l(ref_img), m)
    if r_ref <= 1e-12:
        return 1.0 if r_sub <= 1e-12 else r_sub / 1e-12
    return float(r_sub / r_ref)


def flip_vs_start(img_sub: np.ndarray, img_start: np.ndarray) -> float:
    """render.flip_vs_start: mean FLIP between submission and start renders."""
    return mean_flip(img_start, img_sub)
