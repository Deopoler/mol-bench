"""Tests for scene.* and shape.* metrics."""

from __future__ import annotations

import numpy as np
import pytest

from molmetrics import scene, shape


def _draw_stars(aspect: float, n_stars: int = 8) -> np.ndarray:
    img = np.full((240, 320, 3), 15, dtype=np.uint8)
    yy, xx = np.mgrid[0:240, 0:320]
    ry = 2.6
    rx = 2.6 * aspect
    for i in range(n_stars):
        cy = 25 + (i // 4) * 45
        cx = 40 + (i % 4) * 65
        inside = (((yy - cy) / ry) ** 2 + ((xx - cx) / rx) ** 2) <= 1.0
        img[inside] = [250, 250, 250]
    return img


def test_star_count_and_roundness():
    # Single-pixel stars in top 60% vs bottom 40% (bottom 40% must be ignored)
    img = np.full((100, 100, 3), 10, dtype=np.uint8)
    for k in range(5):
        img[10 + 8 * k, 15 + 15 * k] = [255, 255, 255]
    # Bright pixels in bottom 40% (y >= 60) must NOT count
    img[75, 50] = [255, 255, 255]
    img[85, 70] = [255, 255, 255]
    assert scene.star_count(img) == 5

    # Circles drawn with aspect 1.0 vs 1.4 give star_roundness ~1.0 vs ~1.4
    img_round = _draw_stars(aspect=1.0)
    img_oval = _draw_stars(aspect=1.4)
    r_round = scene.star_roundness(img_round)
    r_oval = scene.star_roundness(img_oval)
    assert r_round == pytest.approx(1.0, abs=0.05)
    assert r_oval == pytest.approx(1.4, abs=0.12)

    # Edge case: completely dark image -> 0 stars, roundness 0.0
    dark = np.zeros((100, 100, 3), dtype=np.uint8)
    assert scene.star_count(dark) == 0
    assert scene.star_roundness(dark) == 0.0


def test_silhouette_and_silhouette_iou():
    h, w = 200, 200
    yy, xx = np.mgrid[0:h, 0:w]
    # Sky brightness L ~ 0.50, mountain silhouette in bottom 30% with height variation >= 4 px
    horizon1 = 175.0 + 12.0 * np.sin(2.0 * np.pi * xx[0] / 80.0)
    sky = np.full((h, w, 3), 115, dtype=np.uint8)
    mask1 = yy >= horizon1[None, :]
    img1 = sky.copy()
    img1[mask1] = [5, 5, 10]

    assert scene.silhouette(img1) is True
    assert scene.silhouette_iou(img1, img1) == pytest.approx(1.0, abs=1e-6)

    # Flat horizon (std == 0) fails scene.silhouette
    img_flat_horiz = sky.copy()
    img_flat_horiz[180:, :] = [5, 5, 10]
    assert scene.silhouette(img_flat_horiz) is False

    # Shifted horizon reduces IoU
    horizon2 = 160.0 + 12.0 * np.sin(2.0 * np.pi * xx[0] / 80.0)
    img2 = sky.copy()
    img2[yy >= horizon2[None, :]] = [5, 5, 10]
    iou = scene.silhouette_iou(img1, img2)
    assert 0.3 < iou < 0.8


def test_shape_circularity():
    h, w = 240, 240
    yy, xx = np.mgrid[0:h, 0:w]
    circle = ((yy - 120) ** 2 + (xx - 120) ** 2) <= 50 ** 2
    img = np.zeros((h, w, 3), dtype=np.uint8)
    img[circle] = [200, 100, 50]

    c_mask = shape.circularity(mask=circle)
    c_color = shape.circularity(img, mask_color=[200, 100, 50])
    c_flood = shape.circularity(img, center={"x": 120, "y": 120})
    assert c_mask == pytest.approx(1.0, abs=0.03)
    assert c_color == pytest.approx(1.0, abs=0.03)
    assert c_flood == pytest.approx(1.0, abs=0.03)

    # Stretched ellipse (2:1) has lower circularity
    ellipse = (((yy - 120) / 30.0) ** 2 + ((xx - 120) / 60.0) ** 2) <= 1.0
    assert shape.circularity(mask=ellipse) < 0.88

    # Edge case: empty mask -> 0.0
    assert shape.circularity(mask=np.zeros((20, 20), dtype=bool)) == 0.0
