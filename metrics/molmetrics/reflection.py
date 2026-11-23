"""Physical reflection, ripple anisotropy, and terrain rim-lighting metrics (v0.2)."""

from __future__ import annotations

from typing import Any

import numpy as np
from scipy.ndimage import gaussian_filter

from .color import srgb_to_linear, srgb_to_oklab
from .flip import compute_ldrflip


def _detect_ridge_and_shore(
    l_img: np.ndarray,
    horizon_y: float | None = None,
) -> tuple[np.ndarray, np.ndarray, int, np.ndarray]:
    """Locate per-column ridge crest `h_ridge`, dark interior `y_int`, shoreline `y_shore`,
    and boolean column validity mask for a borealfjord-style scene.
    """
    h, w = l_img.shape
    if horizon_y is not None:
        hy = float(horizon_y)
        hy_px = int(round(hy * h)) if 0.0 < hy <= 1.0 else int(round(hy))
        y_min = max(12, hy_px - int(round(0.18 * h)))
        y_max = min(h - 16, hy_px + int(round(0.18 * h)))
    else:
        y_min = max(12, int(round(0.42 * h)))
        y_max = min(h - 16, int(round(0.84 * h)))

    if y_max <= y_min + 4:
        y_min = max(4, int(round(0.35 * h)))
        y_max = min(h - 4, int(round(0.85 * h)))

    # Locate contiguous dark ridge interior (L < 0.07) per column.
    y_int = np.full(w, -1, dtype=np.int32)
    h_ridge = np.full(w, -1, dtype=np.int32)
    valid = np.zeros(w, dtype=bool)
    shore_candidates: list[int] = []

    band = l_img[y_min:y_max, :]
    dark_mask = band < 0.07
    # Require a dark block of at least 4 pixels (or remaining rows) so thin dark lines don't false-trigger.
    win = min(6, max(2, band.shape[0] // 4))
    for x in range(w):
        col_dark = dark_mask[:, x]
        if not np.any(col_dark):
            continue
        col_l = band[:, x]
        found_int = -1
        limit = band.shape[0] - win + 1
        for r in range(max(1, limit)):
            if col_l[r] < 0.07 and float(np.mean(col_l[r : r + win])) < 0.07:
                found_int = y_min + r
                break
        if found_int < 0:
            continue

        valid[x] = True
        y_int[x] = found_int

        # Locate the ridge crest h_ridge[x] immediately at or above y_int[x].
        above_lo = max(0, found_int - 20)
        above_hi = max(above_lo + 1, found_int - 10)
        l_above = float(np.mean(l_img[above_lo:above_hi, x]))
        crest_lo = max(0, found_int - 8)
        crest_seg = l_img[crest_lo:found_int, x]

        crest_y = found_int
        if crest_seg.size > 0:
            if float(np.max(crest_seg)) > l_above + 0.025:
                # Bright rim peak above a darker lower sky.
                rel_hits = np.nonzero(crest_seg > (l_above + 0.015))[0]
                if rel_hits.size > 0:
                    crest_y = crest_lo + int(rel_hits[0])
            elif l_above > 0.09:
                # Stepped drop from brighter sky through an intermediate rim band into dark interior:
                # scan top-down across [crest_lo .. found_int - 2] for the sky->rim boundary step.
                best_step = -1
                best_drop = 0.035
                for r in range(max(1, crest_lo), found_int - 1):
                    prev_l = float(l_img[r - 1, x])
                    cur_l = float(l_img[r, x])
                    step_drop = prev_l - cur_l
                    if step_drop > best_drop and cur_l < (0.85 * prev_l):
                        best_drop = step_drop
                        best_step = r
                if best_step >= 0:
                    crest_y = best_step

        h_ridge[x] = crest_y

        # Scan downward past the dark ridge interior to find where the lake starts.
        int_end = min(h - 1, found_int + 4)
        int_l = float(np.mean(l_img[found_int : min(h, found_int + 8), x]))
        shore_lim = min(h - 8, max(int_end + 1, int(round(0.86 * h))))
        for r in range(int_end, shore_lim):
            if l_img[r, x] > max(0.04, int_l + 0.015):
                shore_candidates.append(r)
                break

    if shore_candidates:
        y_shore = int(round(float(np.median(shore_candidates))))
    elif np.any(valid):
        # Fallback: ridge exists, place shoreline just below median dark interior
        med_int = int(round(float(np.median(y_int[valid]))))
        y_shore = min(h - 8, med_int + max(6, int(round(0.03 * h))))
    elif horizon_y is not None:
        hy = float(horizon_y)
        y_shore = max(4, min(h - 8, int(round(hy * h)) if 0.0 < hy <= 1.0 else int(round(hy))))
    else:
        # Sky-meets-lake directly at vertical midpoint or brightness minimum
        y_shore = int(round(0.5 * h))

    return h_ridge, y_int, y_shore, valid


def _strip_pair_for_reflection(
    img: np.ndarray,
    horizon_y: float | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray] | None:
    """Extract matched vertically-mirrored sky and lake strips (both OKLab and RGB)."""
    arr = np.asarray(img)
    if arr.ndim != 3 or arr.shape[0] < 32 or arr.shape[1] < 16:
        return None
    h, _w = arr.shape[:2]
    lab = srgb_to_oklab(arr)
    l_img = lab[..., 0]

    h_ridge, _y_int, y_shore, valid = _detect_ridge_and_shore(l_img, horizon_y=horizon_y)
    if y_shore < 12 or y_shore >= h - 12:
        return None

    y_ridge_med = int(round(float(np.median(h_ridge[valid])))) if np.any(valid) else y_shore
    y_ridge_med = max(12, min(y_shore, y_ridge_med))

    max_strip = min(180, h - y_shore, y_ridge_med)
    if max_strip < 12:
        return None

    lake_lab = lab[y_shore : y_shore + max_strip, :]
    lake_rgb = arr[y_shore : y_shore + max_strip, :]

    # Candidate A: mirrored directly across the shoreline y_shore
    sky_a_lab = lab[y_shore - max_strip : y_shore, :][::-1, :, :]
    sky_a_rgb = arr[y_shore - max_strip : y_shore, :][::-1, :, :]

    # Candidate B: sky above the mountain ridge crest mirrored into the lake
    sky_b_lab = lab[y_ridge_med - max_strip : y_ridge_med, :][::-1, :, :]
    sky_b_rgb = arr[y_ridge_med - max_strip : y_ridge_med, :][::-1, :, :]

    return lake_lab, lake_rgb, sky_a_lab, sky_a_rgb, sky_b_lab, sky_b_rgb


def _blurred_oklab_ncc(sky_lab: np.ndarray, lake_lab: np.ndarray, sigma: float = 6.0) -> float:
    """Normalized cross-correlation of Gaussian-blurred OKLab (L, a, b) strips."""
    nccs: list[float] = []
    for c in range(3):
        s_b = gaussian_filter(sky_lab[..., c], sigma=sigma, mode="reflect")
        l_b = gaussian_filter(lake_lab[..., c], sigma=sigma, mode="reflect")
        s_std = float(np.std(s_b))
        l_std = float(np.std(l_b))
        if c == 0 and (s_std <= 1e-4 or l_std <= 1e-4):
            return 0.0
        if s_std <= 1e-4:
            # Sky has no variation on this chroma axis (e.g., grayscale fixture)
            continue
        if l_std <= 1e-5:
            # Sky has chromatic variation but lake lost it -> penalize
            nccs.append(0.0)
            continue
        s_z = s_b - float(np.mean(s_b))
        l_z = l_b - float(np.mean(l_b))
        denom = float(np.sqrt(np.sum(s_z * s_z) * np.sum(l_z * l_z)))
        if denom <= 1e-12:
            nccs.append(0.0)
        else:
            r = float(np.sum(s_z * l_z) / denom)
            nccs.append(max(0.0, min(1.0, r)))
    if not nccs:
        return 0.0
    return float(np.mean(nccs))


def reflection_coherence(img: np.ndarray, *, horizon_y: float | None = None) -> float:
    """`scene.reflection_coherence`: NCC of blurred (sigma=6) OKLab (L,a,b) between
    vertically mirrored sky strip above h(x) and lake strip below h(x), multiplied by
    Fresnel attenuation check (`mean L_lake < 0.85 * mean L_sky`).
    """
    strips = _strip_pair_for_reflection(img, horizon_y=horizon_y)
    if strips is None:
        return 0.0
    lake_lab, _lake_rgb, sky_a_lab, _sky_a_rgb, sky_b_lab, _sky_b_rgb = strips

    mean_l_lake = float(np.mean(lake_lab[..., 0]))
    if mean_l_lake <= 0.01:
        return 0.0

    # Evaluate both shoreline-mirrored and ridge-top-mirrored alignments
    ncc_a = _blurred_oklab_ncc(sky_a_lab, lake_lab, sigma=6.0)
    mean_l_a = float(np.mean(sky_a_lab[..., 0]))
    fresnel_a = 1.0 if (mean_l_a > 1e-4 and mean_l_lake < 0.85 * mean_l_a) else 0.0

    ncc_b = _blurred_oklab_ncc(sky_b_lab, lake_lab, sigma=6.0)
    mean_l_b = float(np.mean(sky_b_lab[..., 0]))
    fresnel_b = 1.0 if (mean_l_b > 1e-4 and mean_l_lake < 0.85 * mean_l_b) else 0.0

    return float(max(ncc_a * fresnel_a, ncc_b * fresnel_b))


def _match_luminance_srgb(sky_rgb: np.ndarray, sky_lab: np.ndarray, lake_lab: np.ndarray) -> np.ndarray:
    """Scale sky linear RGB to match lake mean lightness (removes pure Fresnel darkening
    so unrippled attenuated mirrors yield ~0 FLIP difference)."""
    mean_l_sky = float(np.mean(sky_lab[..., 0]))
    mean_l_lake = float(np.mean(lake_lab[..., 0]))
    if mean_l_sky <= 1e-4:
        return sky_rgb.astype(np.float64) / 255.0 if sky_rgb.dtype == np.uint8 else np.asarray(sky_rgb, dtype=np.float64)
    # Approximate linear luminance ratio via L^3
    ratio = float(np.clip((mean_l_lake / mean_l_sky) ** 3, 0.05, 1.5))
    lin = srgb_to_linear(sky_rgb) * ratio
    lin = np.clip(lin, 0.0, 1.0)
    return np.where(lin <= 0.0031308, 12.92 * lin, 1.055 * np.power(lin, 1.0 / 2.4) - 0.055)


def water_ripple(img: np.ndarray, *, horizon_y: float | None = None) -> float:
    """`scene.water_ripple`: Lake vertical-vs-horizontal gradient anisotropy scaled by
    brightness-matched lake-vs-mirrored-sky FLIP.

    Rejects unrippled mirror copies (FLIP ~ 0), isotropic static noise (anisotropy ~ 0),
    and flat dark lakes (both ~ 0). Ideal band [0.015, 0.12], zero [0.0, 0.30].
    """
    strips = _strip_pair_for_reflection(img, horizon_y=horizon_y)
    if strips is None:
        return 0.0
    lake_lab, lake_rgb, sky_a_lab, sky_a_rgb, sky_b_lab, sky_b_rgb = strips

    lake_l = lake_lab[..., 0]
    if float(np.mean(lake_l)) <= 0.01:
        return 0.0

    # Horizontal ripples produce dominant vertical luminance variation (|dL/dy| > |dL/dx|)
    gy = np.abs(np.diff(lake_l, axis=0))
    gx = np.abs(np.diff(lake_l, axis=1))
    mean_gy = float(np.mean(gy)) if gy.size > 0 else 0.0
    mean_gx = float(np.mean(gx)) if gx.size > 0 else 0.0
    denom = mean_gy + mean_gx
    if denom <= 1e-6:
        return 0.0
    anisotropy = float(np.clip((mean_gy - mean_gx) / denom, 0.0, 1.0))
    if anisotropy <= 0.0:
        return 0.0

    # Choose the sky strip alignment that best reflects the lake (highest blurred NCC)
    ncc_a = _blurred_oklab_ncc(sky_a_lab, lake_lab, sigma=6.0)
    ncc_b = _blurred_oklab_ncc(sky_b_lab, lake_lab, sigma=6.0)
    if ncc_b > ncc_a:
        best_sky_rgb, best_sky_lab = sky_b_rgb, sky_b_lab
    else:
        best_sky_rgb, best_sky_lab = sky_a_rgb, sky_a_lab

    sky_matched = _match_luminance_srgb(best_sky_rgb, best_sky_lab, lake_lab)
    lake_srgb = lake_rgb.astype(np.float64) / 255.0 if lake_rgb.dtype == np.uint8 else np.asarray(lake_rgb, dtype=np.float64)
    flip_val = float(np.mean(compute_ldrflip(sky_matched, lake_srgb)))

    return float(anisotropy * flip_val)


def terrain_lighting(
    img: np.ndarray,
    *,
    horizon_y: float | None = None,
    n_bins: int = 32,
) -> float:
    """`scene.terrain_lighting`: Pearson correlation r across 32 column bins between
    overhead aurora luminance (~40 px above h(x)) and ridge-crest rim luminance
    (6 px below h(x)), requiring a dark ridge interior (L < 0.07) and measurable
    rim highlight above the interior.
    """
    arr = np.asarray(img)
    if arr.ndim != 3 or arr.shape[0] < 64 or arr.shape[1] < n_bins:
        return 0.0

    lab = srgb_to_oklab(arr)
    l_img = lab[..., 0]
    h, w = l_img.shape

    h_ridge, y_int, _y_shore, valid = _detect_ridge_and_shore(l_img, horizon_y=horizon_y)
    if float(np.mean(valid)) < 0.75:
        return 0.0

    valid_cols = np.nonzero(valid)[0]
    overhead_col = np.zeros(w, dtype=np.float64)
    rim_col = np.zeros(w, dtype=np.float64)
    interior_col = np.zeros(w, dtype=np.float64)

    for x in valid_cols:
        hr = int(h_ridge[x])
        yi = int(y_int[x])
        ov_lo = max(0, hr - 50)
        ov_hi = max(ov_lo + 1, hr - 25)
        rim_lo = max(0, hr)
        rim_hi = min(h, hr + 6)
        int_lo = min(h - 1, yi + 2)
        int_hi = min(h, yi + 12)
        overhead_col[x] = float(np.mean(l_img[ov_lo:ov_hi, x]))
        rim_col[x] = float(np.mean(l_img[rim_lo:rim_hi, x]))
        interior_col[x] = float(np.mean(l_img[int_lo:int_hi, x])) if int_hi > int_lo else float(l_img[yi, x])

    edges = np.linspace(0, w, n_bins + 1, dtype=int)
    ov_bins: list[float] = []
    rim_bins: list[float] = []
    int_bins: list[float] = []
    for i in range(n_bins):
        c0, c1 = int(edges[i]), int(edges[i + 1])
        m = valid[c0:c1]
        if not np.any(m):
            continue
        ov_bins.append(float(np.mean(overhead_col[c0:c1][m])))
        rim_bins.append(float(np.mean(rim_col[c0:c1][m])))
        int_bins.append(float(np.mean(interior_col[c0:c1][m])))

    if len(ov_bins) < 8:
        return 0.0

    ov_arr = np.asarray(ov_bins, dtype=np.float64)
    rim_arr = np.asarray(rim_bins, dtype=np.float64)
    int_arr = np.asarray(int_bins, dtype=np.float64)

    # Dark ridge interior required (< 0.07)
    if float(np.mean(int_arr)) >= 0.07:
        return 0.0

    # Rim must actually brighten a meaningful fraction (>= 25%) of ridge crest columns
    rim_delta = rim_col[valid] - interior_col[valid]
    if float(np.mean(rim_delta > 0.01)) < 0.25:
        return 0.0
    if float(np.mean(rim_arr) - np.mean(int_arr)) <= 0.005:
        return 0.0

    ov_std = float(np.std(ov_arr))
    rim_std = float(np.std(rim_arr))
    if ov_std <= 1e-4 or rim_std <= 1e-4:
        return 0.0

    r = float(np.corrcoef(ov_arr, rim_arr)[0, 1])
    if not np.isfinite(r):
        return 0.0
    return float(max(0.0, min(1.0, r)))


def _compute_reflection_metric(ctx: dict[str, Any]) -> list[dict[str, Any]] | None:
    manifest = ctx["manifest"]
    samples = ctx["select_samples"](
        manifest.get("samples", []),
        ctx["at_filter"],
        default_variant="normal",
        viewport_default=manifest.get("viewport_default"),
    )
    if not samples:
        return None

    mid = ctx["metric_id"]
    fn = {
        "scene.reflection_coherence": reflection_coherence,
        "scene.water_ripple": water_ripple,
        "scene.terrain_lighting": terrain_lighting,
    }[mid]

    out: list[dict[str, Any]] = []
    for s in samples:
        seed_params = ctx["get_params"](s.get("seed"))
        horizon_y = s.get("horizonY")
        if horizon_y is None:
            horizon_y = seed_params.get("horizonY", seed_params.get("horizon_y"))
        img = ctx["load_image"](s)
        out.append({"key": s["key"], "value": fn(img, horizon_y=horizon_y)})

    return out or None


def register(METRICS: dict[str, Any]) -> None:
    """Register reflection, ripple, and terrain lighting metrics with molmetrics CLI."""
    METRICS["scene.reflection_coherence"] = _compute_reflection_metric
    METRICS["scene.water_ripple"] = _compute_reflection_metric
    METRICS["scene.terrain_lighting"] = _compute_reflection_metric
