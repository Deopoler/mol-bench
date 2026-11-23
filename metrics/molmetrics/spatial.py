"""Spatial color distribution metrics (v0.2) — `color.palette_band_sep`."""

from __future__ import annotations

from typing import Any, Sequence

import numpy as np

from .color import (
    _nearest_palette_sqdist,
    chromatic_mask,
    oklch_to_oklab,
    srgb_to_oklab,
)


def palette_band_sep(
    img: np.ndarray,
    palette_oklch: Sequence[Sequence[float]],
    *,
    horizon_y: float | None = None,
    min_share_target: float = 0.06,
    min_y_std_target: float = 0.045,
) -> float:
    """Compute `color.palette_band_sep` in [0, 1].

    Measures whether all palette colors are genuinely represented across chromatic
    sky pixels AND stratified vertically by altitude rather than uniformly mixed:
    - Each palette color must reach >= 6% share of chromatic pixels.
    - Vertical centroid std `std(y_0, y_1, ..., y_{K-1})` (normalized by region
      height) must be >= 0.045.

    Scaled so that hitting both exact thresholds (`share >= 0.06` and
    `y_std >= 0.045`) yields >= 0.75 (full score band `0.75`, zero band `0.25`).
    """
    pal = np.asarray(palette_oklch, dtype=np.float64)
    if pal.ndim != 2 or pal.shape[0] < 2:
        return 0.0

    arr = np.asarray(img)
    if arr.ndim != 3 or arr.shape[0] < 2 or arr.shape[1] < 2:
        return 0.0

    if horizon_y is not None:
        hy = float(horizon_y)
        if 0.0 < hy <= 1.0:
            sky_h = max(1, min(arr.shape[0], int(round(hy * arr.shape[0]))))
        else:
            sky_h = max(1, min(arr.shape[0], int(round(hy))))
        region = arr[:sky_h, :]
    else:
        region = arr

    hs = region.shape[0]
    lab = srgb_to_oklab(region)
    chrom = chromatic_mask(lab)
    chrom_frac = float(np.mean(chrom))
    if chrom_frac < 0.005:
        return 0.0

    ys, _xs = np.nonzero(chrom)
    n_chrom = int(ys.size)
    if n_chrom == 0:
        return 0.0

    chrom_lab = lab[chrom]
    pal_lab = oklch_to_oklab(pal, degrees=True)
    _min_sq, nearest = _nearest_palette_sqdist(chrom_lab, pal_lab)

    k_count = pal.shape[0]
    counts = np.bincount(nearest, minlength=k_count)
    shares = counts.astype(np.float64) / float(n_chrom)
    min_share = float(np.min(shares))
    if min_share <= 0.0:
        return 0.0

    y_norm = ys.astype(np.float64) / float(max(1, hs))
    centroids = [float(np.mean(y_norm[nearest == k])) for k in range(k_count)]
    y_std = float(np.std(centroids))

    # Map both thresholds linearly so the exact acceptance bar sits at 0.75
    # (matching spec `full: 0.75, zero: 0.25`).
    share_denom = (min_share_target / 0.75) if min_share_target > 0 else 1.0
    std_denom = (min_y_std_target / 0.75) if min_y_std_target > 0 else 1.0
    share_score = float(np.clip(min_share / share_denom, 0.0, 1.0))
    strat_score = float(np.clip(y_std / std_denom, 0.0, 1.0))

    return float(min(share_score, strat_score))


def _compute_palette_band_sep(ctx: dict[str, Any]) -> list[dict[str, Any]] | None:
    """Plugin handler for `color.palette_band_sep`."""
    manifest = ctx["manifest"]
    samples = ctx["select_samples"](
        manifest.get("samples", []),
        ctx["at_filter"],
        default_variant="normal",
        viewport_default=manifest.get("viewport_default"),
    )
    if not samples:
        return None

    out: list[dict[str, Any]] = []
    for s in samples:
        seed_params = ctx["get_params"](s.get("seed"))
        pal = s.get("palette") or seed_params.get("palette")
        if not pal:
            continue
        horizon_y = s.get("horizonY")
        if horizon_y is None:
            horizon_y = seed_params.get("horizonY", seed_params.get("horizon_y"))
        img = ctx["load_image"](s)
        val = palette_band_sep(img, pal, horizon_y=horizon_y)
        out.append({"key": s["key"], "value": val})

    return out or None


def register(METRICS: dict[str, Any]) -> None:
    """Register spatial v0.2 metrics with molmetrics CLI."""
    METRICS["color.palette_band_sep"] = _compute_palette_band_sep
