"""Tests for time.* metrics and reduced_motion checks."""

from __future__ import annotations

import numpy as np
import pytest

from molmetrics import scene, time_


def test_static_sequence_has_zero_motion_and_flicker():
    frame = np.full((64, 64, 3), 80, dtype=np.uint8)
    frame[:20, :20] = [20, 140, 200]
    seq = [frame.copy() for _ in range(120)]

    assert time_.motion(seq) == 0.0
    assert time_.flicker(seq, dt_ms=16.667) == 0.0


def test_20hz_flashing_patch_has_high_flicker():
    h, w = 64, 64
    dt_ms = 16.667
    t_s = np.arange(120) * (dt_ms / 1000.0)
    # 20 Hz sinusoidal luminance patch on a static background
    vals = np.round(128.0 + 100.0 * np.sin(2.0 * np.pi * 20.0 * t_s)).astype(np.uint8)

    frames = []
    for v in vals:
        img = np.full((h, w, 3), 40, dtype=np.uint8)
        img[16:48, 16:48] = int(v)
        frames.append(img)

    score = time_.flicker(frames, dt_ms=dt_ms)
    assert score > 0.90

    # Compare with slow 1 Hz oscillation (< 10 Hz cutoff) -> near-zero flicker
    vals_slow = np.round(128.0 + 100.0 * np.sin(2.0 * np.pi * 1.0 * t_s)).astype(np.uint8)
    frames_slow = []
    for v in vals_slow:
        img = np.full((h, w, 3), 40, dtype=np.uint8)
        img[16:48, 16:48] = int(v)
        frames_slow.append(img)

    assert time_.flicker(frames_slow, dt_ms=dt_ms) < 0.05


def test_flicker_region_mask_isolation():
    h, w = 64, 64
    dt_ms = 16.667
    t_s = np.arange(120) * (dt_ms / 1000.0)
    vals_hi = np.round(128.0 + 90.0 * np.sin(2.0 * np.pi * 20.0 * t_s)).astype(np.uint8)

    frames = []
    for v in vals_hi:
        img = np.full((h, w, 3), 50, dtype=np.uint8)
        img[0:20, 0:20] = int(v)  # flashing outside floor mask
        frames.append(img)

    mask_floor = np.zeros((h, w), dtype=bool)
    mask_floor[40:60, 20:50] = True
    assert time_.flicker_region(frames, mask_floor, dt_ms=dt_ms) == 0.0

    mask_patch = np.zeros((h, w), dtype=bool)
    mask_patch[0:20, 0:20] = True
    assert time_.flicker_region(frames, mask_patch, dt_ms=dt_ms) > 0.90


def test_motion_positive_and_reduced_motion_not_blank():
    f0 = np.zeros((80, 80, 3), dtype=np.uint8)
    f1 = np.full((80, 80, 3), 255, dtype=np.uint8)
    assert time_.motion([f0, f1]) == pytest.approx(1.0, abs=1e-4)

    # Build a night sky with 10 stars
    sky = np.full((100, 100, 3), 25, dtype=np.uint8)
    for k in range(10):
        sky[10 + 4 * k, 10 + 7 * k] = [250, 250, 250]

    assert time_.reduced_motion_not_blank(sky, sky.copy(), scene.star_count) is True

    blank = np.zeros_like(sky)
    assert time_.reduced_motion_not_blank(sky, blank, scene.star_count) is False
