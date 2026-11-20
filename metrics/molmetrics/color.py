"""Color conversions (sRGB -> linear -> OKLab / OKLCH) and color.* metrics."""

from __future__ import annotations

from typing import Sequence

import numpy as np

# Precomputed 8-bit sRGB -> linear LUT (IEC 61966-2-1) for fast exact frame conversion.
_U8_GRID = np.arange(256, dtype=np.float64) / 255.0
_SRGB_TO_LINEAR_LUT = np.where(
    _U8_GRID <= 0.04045,
    _U8_GRID / 12.92,
    ((_U8_GRID + 0.055) / 1.055) ** 2.4,
)

# Ottosson (2020) direct linear-sRGB -> LMS and LMS^(1/3) -> OKLab matrices.
_M1_LRGB_TO_LMS = np.array([
    [0.4122214708, 0.5363325363, 0.0514459929],
    [0.2119034982, 0.6806995451, 0.1073969566],
    [0.0883024619, 0.2817188376, 0.6299787005],
], dtype=np.float64)

_M2_LMS_TO_OKLAB = np.array([
    [0.2104542553, 0.7936177850, -0.0040720468],
    [1.9779984951, -2.4285922050, 0.4505937099],
    [0.0259040371, 0.7827717662, -0.8086757660],
], dtype=np.float64)


def srgb_to_linear(srgb: np.ndarray) -> np.ndarray:
    """Convert sRGB (uint8 0..255 or float 0..1) to linear RGB using IEC 61966-2-1."""
    arr = np.asarray(srgb)
    if arr.dtype == np.uint8:
        return _SRGB_TO_LINEAR_LUT[arr]
    f = arr.astype(np.float64, copy=False)
    return np.where(f <= 0.04045, f / 12.92, ((np.maximum(f, 0.0) + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(linear: np.ndarray) -> np.ndarray:
    """Convert linear RGB in [0, 1] to sRGB in [0, 1] using IEC 61966-2-1."""
    lin = np.clip(np.asarray(linear, dtype=np.float64), 0.0, 1.0)
    return np.where(lin <= 0.0031308, 12.92 * lin, 1.055 * np.power(lin, 1.0 / 2.4) - 0.055)


def linear_to_oklab(linear: np.ndarray) -> np.ndarray:
    """Convert linear sRGB (..., 3) to OKLab (..., 3) per Ottosson (2020)."""
    lin = np.asarray(linear, dtype=np.float64)
    lms = lin @ _M1_LRGB_TO_LMS.T
    lms_cbrt = np.cbrt(lms)
    return lms_cbrt @ _M2_LMS_TO_OKLAB.T


def srgb_to_oklab(img: np.ndarray) -> np.ndarray:
    """Convert an sRGB image/array (uint8 or float in [0, 1]) to OKLab (..., 3)."""
    return linear_to_oklab(srgb_to_linear(img))


def srgb_to_oklab_l(img: np.ndarray) -> np.ndarray:
    """Fast path returning only OKLab lightness L in [0, 1] as float64."""
    return srgb_to_oklab(img)[..., 0]


def oklab_to_oklch(lab: np.ndarray) -> np.ndarray:
    """Convert OKLab (L, a, b) to OKLCH (L, C, h_rad) with h in [-pi, pi]."""
    arr = np.asarray(lab, dtype=np.float64)
    L = arr[..., 0]
    a = arr[..., 1]
    b = arr[..., 2]
    C = np.hypot(a, b)
    h = np.arctan2(b, a)
    return np.stack([L, C, h], axis=-1)


def oklch_to_oklab(lch: np.ndarray | Sequence[Sequence[float]], degrees: bool = True) -> np.ndarray:
    """Convert OKLCH (L, C, h) to OKLab (L, a, b). Hue defaults to degrees."""
    arr = np.asarray(lch, dtype=np.float64)
    L = arr[..., 0]
    C = arr[..., 1]
    h = np.deg2rad(arr[..., 2]) if degrees else arr[..., 2]
    a = C * np.cos(h)
    b = C * np.sin(h)
    return np.stack([L, a, b], axis=-1)


def y8_luma(img_u8: np.ndarray) -> np.ndarray:
    """8-bit gamma-encoded luma Y8 = round(255 * (0.2126 R' + 0.7152 G' + 0.0722 B'))."""
    arr = np.asarray(img_u8)
    if arr.dtype == np.uint8:
        rgb = arr.astype(np.float64) / 255.0
    else:
        rgb = np.clip(arr.astype(np.float64), 0.0, 1.0)
    y = 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]
    return np.round(255.0 * y).astype(np.int32)


def chromatic_mask(lab: np.ndarray) -> np.ndarray:
    """Chromatic pixels per METRICS.md: C > 0.04 and L > 0.25."""
    C = np.hypot(lab[..., 1], lab[..., 2])
    return (C > 0.04) & (lab[..., 0] > 0.25)


def _nearest_palette_sqdist(chrom_lab: np.ndarray, palette_lab: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return (min_sq_dist, nearest_idx) for N chromatic OKLab pixels against K palette OKLab colors."""
    n = chrom_lab.shape[0]
    min_sq = np.full(n, np.inf, dtype=np.float64)
    nearest = np.zeros(n, dtype=np.int64)
    for k in range(palette_lab.shape[0]):
        diff = chrom_lab - palette_lab[k]
        sq = np.einsum("ij,ij->i", diff, diff)
        better = sq < min_sq
        min_sq[better] = sq[better]
        nearest[better] = k
    return min_sq, nearest


def palette_fidelity(img: np.ndarray, palette_oklch: Sequence[Sequence[float]]) -> float:
    """color.palette_fidelity: fraction of chromatic pixels within ΔE_OK < 0.10 of nearest palette color.

    Returns 0.0 if < 1% of pixels are chromatic or palette is empty.
    """
    pal = np.asarray(palette_oklch, dtype=np.float64)
    if pal.size == 0:
        return 0.0
    lab = srgb_to_oklab(img)
    chrom = chromatic_mask(lab)
    if float(np.mean(chrom)) < 0.01:
        return 0.0
    chrom_lab = lab[chrom]
    pal_lab = oklch_to_oklab(pal, degrees=True)
    min_sq, _ = _nearest_palette_sqdist(chrom_lab, pal_lab)
    return float(np.mean(min_sq < (0.10 * 0.10)))


def palette_coverage(img: np.ndarray, palette_oklch: Sequence[Sequence[float]]) -> float:
    """color.palette_coverage: fraction of palette colors nearest for >= 5% of chromatic pixels."""
    pal = np.asarray(palette_oklch, dtype=np.float64)
    if pal.size == 0:
        return 0.0
    k = pal.shape[0]
    lab = srgb_to_oklab(img)
    chrom = chromatic_mask(lab)
    n_chrom = int(np.sum(chrom))
    if n_chrom == 0:
        return 0.0
    chrom_lab = lab[chrom]
    pal_lab = oklch_to_oklab(pal, degrees=True)
    _, nearest = _nearest_palette_sqdist(chrom_lab, pal_lab)
    counts = np.bincount(nearest, minlength=k)
    return float(np.mean((counts / n_chrom) >= 0.05))


def chroma_mean(img: np.ndarray, mask: np.ndarray | None = None) -> float:
    """color.chroma_mean: mean OKLCH chroma C over chromatic pixels (optionally restricted by mask)."""
    lab = srgb_to_oklab(img)
    C = np.hypot(lab[..., 1], lab[..., 2])
    sel = (C > 0.04) & (lab[..., 0] > 0.25)
    if mask is not None:
        sel = sel & np.asarray(mask, dtype=bool)
    if not np.any(sel):
        return 0.0
    return float(np.mean(C[sel]))


def _chroma_weighted_mean_hue_deg(lab: np.ndarray, mask: np.ndarray | None = None) -> float | None:
    """Return chroma-weighted circular mean hue in degrees, or None if no chromatic pixels."""
    a = lab[..., 1]
    b = lab[..., 2]
    C = np.hypot(a, b)
    sel = (C > 0.04) & (lab[..., 0] > 0.25)
    if mask is not None:
        sel = sel & np.asarray(mask, dtype=bool)
    if not np.any(sel):
        return None
    # Because a = C*cos(h) and b = C*sin(h), summing (a, b) is exact C-weighted circular mean.
    sum_a = float(np.sum(a[sel]))
    sum_b = float(np.sum(b[sel]))
    if sum_a == 0.0 and sum_b == 0.0:
        return None
    return float(np.rad2deg(np.arctan2(sum_b, sum_a)))


def hue_shift(img_start: np.ndarray, img_sub: np.ndarray, mask: np.ndarray | None = None) -> float:
    """color.hue_shift: circular distance (deg) of C-weighted mean hue between start and submission."""
    h1 = _chroma_weighted_mean_hue_deg(srgb_to_oklab(img_start), mask=mask)
    h2 = _chroma_weighted_mean_hue_deg(srgb_to_oklab(img_sub), mask=mask)
    if h1 is None or h2 is None:
        return 0.0
    diff = abs(h1 - h2) % 360.0
    return float(min(diff, 360.0 - diff))


def _normalize_ref_patches_oklab(ref_patches: Sequence) -> np.ndarray:
    """Convert reference patch values (OKLab [L,a,b], dict {L,a,b}, or sRGB [0..255]) to OKLab (N, 3)."""
    out = []
    for item in ref_patches:
        if isinstance(item, dict):
            if "oklab" in item:
                out.append(np.asarray(item["oklab"], dtype=np.float64))
            elif "oklch" in item:
                out.append(oklch_to_oklab(np.asarray(item["oklch"], dtype=np.float64), degrees=True))
            elif "srgb" in item:
                rgb = np.asarray(item["srgb"], dtype=np.float64)
                if np.max(rgb) > 1.0:
                    rgb = rgb / 255.0
                out.append(srgb_to_oklab(rgb))
            else:
                out.append(np.array([item["L"], item["a"], item["b"]], dtype=np.float64))
        else:
            out.append(np.asarray(item, dtype=np.float64))
    return np.asarray(out, dtype=np.float64)


def patch_delta(
    img: np.ndarray,
    chart_patches: Sequence[dict[str, float] | Sequence[float]],
    ref_patches: Sequence,
) -> float:
    """color.patch_delta: mean ΔE_OK over 8x8 crops centered at chart_patches vs reference OKLab values."""
    if len(chart_patches) == 0 or len(ref_patches) == 0:
        raise ValueError("chart_patches and ref_patches must be non-empty")
    if len(chart_patches) != len(ref_patches):
        raise ValueError(f"Mismatched patch count: {len(chart_patches)} vs {len(ref_patches)}")

    lab = srgb_to_oklab(img)
    h, w = lab.shape[:2]
    refs_lab = _normalize_ref_patches_oklab(ref_patches)

    deltas = []
    for idx, pt in enumerate(chart_patches):
        if isinstance(pt, dict):
            cx = int(round(float(pt["x"])))
            cy = int(round(float(pt["y"])))
        else:
            cx = int(round(float(pt[0])))
            cy = int(round(float(pt[1])))
        y0 = max(0, cy - 4)
        y1 = min(h, cy + 4)
        x0 = max(0, cx - 4)
        x1 = min(w, cx + 4)
        if y1 <= y0 or x1 <= x0:
            raise ValueError(f"Patch center ({cx}, {cy}) outside image bounds ({w}x{h})")
        mean_lab = np.mean(lab[y0:y1, x0:x1], axis=(0, 1))
        deltas.append(float(np.linalg.norm(mean_lab - refs_lab[idx])))
    return float(np.mean(deltas))
