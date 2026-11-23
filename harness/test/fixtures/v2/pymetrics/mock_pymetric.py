"""Mock v0.2 Python metric plugin for M1 end-to-end smoke test."""

from __future__ import annotations

from typing import Any

import numpy as np


def _compute_mean_blue(ctx: dict[str, Any]):
    samples = ctx["select_samples"](
        ctx["manifest"].get("samples", []),
        ctx["at_filter"],
        default_variant="normal",
        viewport_default=ctx["manifest"].get("viewport_default"),
    )
    if not samples:
        return None
    out = []
    for s in samples:
        img = ctx["load_image"](s)
        blue_mean = float(np.mean(img[:, :, 2])) / 255.0
        out.append({"key": s["key"], "value": blue_mean})
    return out


def register(METRICS: dict[str, Any]) -> None:
    METRICS["mock.py_mean_blue"] = _compute_mean_blue
