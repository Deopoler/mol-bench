"""Tests for LDR-FLIP, ref.*, and interact.pointer_response."""

from __future__ import annotations

import numpy as np
import pytest

from molmetrics import flip, ref


def test_flip_identical_and_monotonic_noise():
    rng = np.random.default_rng(123)
    base = np.zeros((128, 128, 3), dtype=np.uint8)
    base[:, :64] = [40, 120, 200]
    base[:, 64:] = [210, 180, 60]

    # Identical images -> exact 0
    fmap = flip.compute_ldrflip(base, base.copy())
    assert fmap.shape == (128, 128)
    assert float(np.max(fmap)) == 0.0
    assert flip.mean_flip(base, base.copy()) == 0.0

    # Monotonic behavior with increasing noise amplitude
    prev = 0.0
    for sigma in (2.0, 8.0, 20.0, 50.0):
        noise = rng.normal(0.0, sigma, size=base.shape)
        noisy = np.clip(np.round(base.astype(np.float64) + noise), 0, 255).astype(np.uint8)
        score = flip.mean_flip(base, noisy)
        assert score > prev
        prev = score
    assert prev <= 1.0


def test_ref_and_pointer_response():
    a = np.full((64, 64, 3), 50, dtype=np.uint8)
    b = np.full((64, 64, 3), 150, dtype=np.uint8)

    assert ref.ref_flip(a, a) == 0.0
    assert ref.ref_flip(a, b) > 0.2
    assert ref.ref_lum_delta(a, a) == 0.0
    assert ref.ref_lum_delta(a, b) > 0.2

    assert ref.pointer_response(a, a) == 0.0
    assert ref.pointer_response(a, b) > 0.2
