"""Tests for render.* metrics: banding, aliasing, stripe_energy, flip_vs_start."""

from __future__ import annotations

import numpy as np
import pytest

from molmetrics import render


def test_banding_undithered_vs_ordered_dither_and_blue_noise():
    h, w = 256, 720
    # Smooth 8-bit dark gradient (0..24 across 720 px -> ~30 px wide flat bands)
    ramp = np.linspace(0.0, 24.0, w, dtype=np.float64)[None, :]
    ramp_2d = np.broadcast_to(ramp, (h, w))

    undithered_y = np.clip(np.round(ramp_2d), 0, 255).astype(np.uint8)
    img_undithered = np.repeat(undithered_y[..., None], 3, axis=2)
    b_undith = render.banding(img_undithered)
    assert b_undith > 0.02

    # Same gradient WITH 4x4 Bayer ordered dithering -> near-zero banding
    bayer4 = (
        np.array([
            [0, 8, 2, 10],
            [12, 4, 14, 6],
            [3, 11, 1, 9],
            [15, 7, 13, 5],
        ], dtype=np.float64)
        / 16.0
        - 0.5
    )
    tiled = np.tile(bayer4, (h // 4 + 1, w // 4 + 1))[:h, :w]
    dithered_y = np.clip(np.round(ramp_2d + tiled), 0, 255).astype(np.uint8)
    img_dithered = np.repeat(dithered_y[..., None], 3, axis=2)
    b_dith = render.banding(img_dithered)
    assert b_dith < 0.002
    assert b_dith < b_undith * 0.1

    # Same gradient WITH high-frequency pseudo-blue-noise (void-and-cluster / TPDF noise)
    rng = np.random.default_rng(99)
    white = rng.uniform(-0.5, 0.5, size=(h, w))
    # High-pass filter white noise to approximate blue noise spectrum
    from scipy.ndimage import gaussian_filter

    hp = white - gaussian_filter(white, sigma=1.2)
    hp = hp / (np.max(np.abs(hp)) + 1e-12) * 0.75
    bn_y = np.clip(np.round(ramp_2d + hp), 0, 255).astype(np.uint8)
    img_bn = np.repeat(bn_y[..., None], 3, axis=2)
    assert render.banding(img_bn) < 0.002


def test_banding_edge_case_noisy_frame_below_smooth_threshold():
    rng = np.random.default_rng(1)
    noisy = rng.integers(0, 256, size=(100, 100, 3), dtype=np.uint8)
    # Smooth mask covers < 2% of the noisy frame -> returns 0.0
    assert render.banding(noisy) == 0.0


def test_render_aliasing_clean_vs_jagged():
    h, w = 128, 128
    yy, xx = np.mgrid[0 : 2 * h, 0 : 2 * w]
    # Diagonal half-plane rendered at DPR 2
    edge_hi = ((yy - xx) > 0).astype(np.uint8) * 255
    img_dpr2 = np.repeat(edge_hi[..., None], 3, axis=2)

    # Box-downsampled exact reference at DPR 1 -> aliasing ~0
    b_down = render._box_downsample_2x(img_dpr2)
    img_aa = np.clip(np.round(b_down * 255.0), 0, 255).astype(np.uint8)
    val_aa = render.aliasing(img_aa, img_dpr2)

    # Hard aliased stairstep at DPR 1 with phase shift -> higher aliasing
    yy1, xx1 = np.mgrid[0:h, 0:w]
    edge_lo = ((yy1 - xx1) > 1).astype(np.uint8) * 255
    img_aliased = np.repeat(edge_lo[..., None], 3, axis=2)
    val_aliased = render.aliasing(img_aliased, img_dpr2)

    assert val_aa < 0.02
    assert val_aliased > val_aa * 2.0


def test_render_stripe_energy():
    h, w = 128, 128
    yy, xx = np.mgrid[0:h, 0:w]
    mask = np.zeros((h, w), dtype=bool)
    mask[20:108, 20:108] = True

    # Reference: smooth low-frequency shading inside mask + slight texture
    ref_lum = 120.0 + 30.0 * np.sin(2.0 * np.pi * xx / 40.0) + 2.0 * ((xx + yy) % 2)
    ref_img = np.repeat(np.clip(np.round(ref_lum), 0, 255).astype(np.uint8)[..., None], 3, axis=2)
    assert render.stripe_energy(ref_img, ref_img, mask) == pytest.approx(1.0, abs=1e-6)

    # Submission with 0.35 cycles/px stripes (period ~2.86 px) inside mask -> ratio >> 1
    sub_lum = ref_lum + 45.0 * np.sin(2.0 * np.pi * 0.35 * (xx + yy))
    sub_img = np.repeat(np.clip(np.round(sub_lum), 0, 255).astype(np.uint8)[..., None], 3, axis=2)
    assert render.stripe_energy(sub_img, ref_img, mask) > 5.0
