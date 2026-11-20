"""Tests for visual.* (congestion, edge_density) and mask.* (element_ssim, silhouette_delta)."""

from __future__ import annotations

import numpy as np
import pytest

from molmetrics import mask, visual


def test_congestion_flat_poster_vs_cluttered_collage():
    # Flat poster: two large solid color blocks with one clean straight boundary
    poster = np.zeros((240, 320, 3), dtype=np.uint8)
    poster[:, :160] = [240, 235, 225]
    poster[:, 160:] = [30, 50, 80]

    # Cluttered collage: many small random-colored patches, edges, and textures at multiple scales
    rng = np.random.default_rng(2026)
    collage = poster.copy()
    for _ in range(180):
        x = int(rng.integers(0, 300))
        y = int(rng.integers(0, 220))
        w = int(rng.integers(4, 28))
        h = int(rng.integers(4, 28))
        col = rng.integers(0, 256, size=3, dtype=np.uint8)
        collage[y : y + h, x : x + w] = col
    # Add fine diagonal/text-like hash marks
    collage[::3, ::4] = rng.integers(0, 256, size=(80, 80, 3), dtype=np.uint8)

    c_poster = visual.congestion(poster)
    c_collage = visual.congestion(collage)
    assert c_poster >= 0.0
    assert c_collage > c_poster * 3.0

    # Completely uniform image -> 0.0 congestion and 0.0 edge_density
    flat = np.full((120, 120, 3), 120, dtype=np.uint8)
    assert visual.congestion(flat) == pytest.approx(0.0, abs=1e-6)
    assert visual.edge_density(flat) == 0.0

    # Edge density is higher on collage than poster
    assert visual.edge_density(collage) > visual.edge_density(poster)


def test_mask_element_ssim():
    yy, xx = np.mgrid[0:60, 0:80]
    c_start = np.zeros((60, 80, 3), dtype=np.uint8)
    c_start[..., 0] = np.clip(40 + 2 * xx, 0, 255)
    c_start[..., 1] = np.clip(50 + 3 * yy, 0, 255)
    c_start[..., 2] = 160
    c_start[15:45, 20:60] = [230, 230, 240]
    # Identical crop -> SSIM == 1.0
    assert mask.element_ssim([(c_start, c_start.copy())]) == pytest.approx(1.0, abs=1e-6)

    # Size differs by <= 4 px -> resized and high SSIM
    c_slight = c_start[:58, :78].copy()
    assert mask.element_ssim_pair(c_start, c_slight) > 0.85

    # Size differs by > 4 px -> must score 0.0
    c_diff = c_start[:50, :80].copy()
    assert mask.element_ssim_pair(c_start, c_diff) == 0.0

    # Minimum across multiple elements
    assert mask.element_ssim([(c_start, c_start.copy()), (c_start, c_diff)]) == 0.0


def test_mask_silhouette_delta():
    h, w = 160, 160
    yy, xx = np.mgrid[0:h, 0:w]
    horizon = 130.0 + 10.0 * np.sin(2.0 * np.pi * xx[0] / 50.0)
    img_start = np.full((h, w, 3), 140, dtype=np.uint8)
    img_start[yy >= horizon[None, :]] = [10, 10, 15]

    assert mask.silhouette_delta(img_start, img_start.copy()) == pytest.approx(0.0, abs=1e-7)

    # Brighten silhouette region -> positive delta
    img_sub = img_start.copy()
    img_sub[yy >= horizon[None, :]] = [100, 100, 100]
    assert mask.silhouette_delta(img_start, img_sub) > 0.25
