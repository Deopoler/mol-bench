"""Performance tests on 1440x900 frames (< 2s per sample; 120-frame flicker < 20s)."""

from __future__ import annotations

import time

import numpy as np
import pytest

from molmetrics import color, flip, lum, mask, render, scene, shape, time_, visual


def test_1440x900_single_frame_metrics_under_2s():
    rng = np.random.default_rng(77)
    img_a = rng.integers(20, 230, size=(900, 1440, 3), dtype=np.uint8)
    img_b = np.clip(img_a.astype(np.int16) + 5, 0, 255).astype(np.uint8)
    palette = [[0.78, 0.17, 160], [0.62, 0.15, 300], [0.70, 0.14, 350]]
    mask_arr = np.zeros((900, 1440), dtype=bool)
    mask_arr[200:700, 300:1100] = True

    checks = [
        ("color.palette_fidelity", lambda: color.palette_fidelity(img_a, palette)),
        ("lum.mean", lambda: lum.lum_mean(img_a)),
        ("render.banding", lambda: render.banding(img_a)),
        ("render.stripe_energy", lambda: render.stripe_energy(img_a, img_b, mask_arr)),
        ("scene.star_count", lambda: scene.star_count(img_a)),
        ("scene.silhouette", lambda: scene.silhouette(img_a)),
        ("shape.circularity", lambda: shape.circularity(mask=mask_arr)),
        ("ref.flip", lambda: flip.mean_flip(img_a, img_b)),
        ("visual.congestion", lambda: visual.congestion(img_a)),
        ("visual.edge_density", lambda: visual.edge_density(img_a)),
        ("mask.silhouette_delta", lambda: mask.silhouette_delta(img_a, img_b, mask=mask_arr)),
    ]

    for name, fn in checks:
        t0 = time.perf_counter()
        fn()
        dt = time.perf_counter() - t0
        assert dt < 2.0, f"{name} took {dt:.3f}s (>= 2.0s budget)"


def test_1440x900_120_frame_flicker_under_20s():
    rng = np.random.default_rng(11)
    base = rng.integers(40, 180, size=(900, 1440, 3), dtype=np.uint8)
    # Create 120 frames with a 20 Hz oscillating strip
    frames = []
    for i in range(120):
        f = base.copy()
        delta = int(round(30.0 * np.sin(2.0 * np.pi * 20.0 * i * 0.016667)))
        f[100:200, 100:200] = np.clip(f[100:200, 100:200].astype(np.int16) + delta, 0, 255).astype(np.uint8)
        frames.append(f)

    t0 = time.perf_counter()
    val = time_.flicker(frames, dt_ms=16.667)
    dt = time.perf_counter() - t0
    assert val > 0.8
    assert dt < 20.0, f"120-frame 1440x900 flicker took {dt:.3f}s (>= 20.0s budget)"
