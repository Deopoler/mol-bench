"""MoL-Bench image and time-series metric package (`molmetrics`)."""

from __future__ import annotations

IMPLEMENTED_METRICS: frozenset[str] = frozenset({
    "color.palette_fidelity",
    "color.palette_coverage",
    "color.chroma_mean",
    "color.hue_shift",
    "color.patch_delta",
    "lum.mean",
    "lum.highlight_frac",
    "lum.floor",
    "time.motion",
    "time.flicker",
    "time.flicker_region",
    "render.banding",
    "render.aliasing",
    "render.stripe_energy",
    "render.flip_vs_start",
    "scene.star_count",
    "scene.star_roundness",
    "scene.silhouette",
    "scene.silhouette_iou",
    "interact.pointer_response",
    "shape.circularity",
    "ref.flip",
    "ref.lum_delta",
    "mask.element_ssim",
    "mask.silhouette_delta",
    "visual.congestion",
    "visual.edge_density",
    "a11y.reduced_motion",
    "reduced_motion.not_blank",
})

__all__ = ["IMPLEMENTED_METRICS"]
