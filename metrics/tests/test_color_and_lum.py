"""Tests for OKLab conversion, color.* metrics, and lum.* metrics."""

from __future__ import annotations

import colour
import numpy as np
import pytest

from molmetrics import color, lum


def _oklch_to_srgb_u8(lch: list[float]) -> np.ndarray:
    """Helper converting one OKLCH [L, C, h_deg] color to 8-bit sRGB."""
    lab = color.oklch_to_oklab(np.array([lch]), degrees=True)[0]
    # Invert Ottosson 2020 M2 and M1
    lms_cbrt = np.linalg.inv(color._M2_LMS_TO_OKLAB) @ lab
    lms = lms_cbrt ** 3
    lin = np.linalg.inv(color._M1_LRGB_TO_LMS) @ lms
    srgb = color.linear_to_srgb(lin)
    return np.clip(np.round(srgb * 255.0), 0, 255).astype(np.uint8)


def test_oklab_matches_colour_science():
    rng = np.random.default_rng(42)
    srgb = rng.uniform(0.0, 1.0, size=(200, 3))
    # Include black, white, and primaries
    corners = np.array([
        [0.0, 0.0, 0.0],
        [1.0, 1.0, 1.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
    ])
    pts = np.vstack([corners, srgb])
    ours = color.srgb_to_oklab(pts)
    ref = colour.convert(pts, "sRGB", "Oklab")
    np.testing.assert_allclose(ours, ref, atol=2.5e-4)
    # White & black exactness
    np.testing.assert_allclose(ours[0], [0.0, 0.0, 0.0], atol=1e-7)
    np.testing.assert_allclose(ours[1], [1.0, 0.0, 0.0], atol=1e-5)


def test_palette_fidelity_and_coverage():
    palette = [[0.78, 0.17, 160], [0.62, 0.15, 300], [0.70, 0.14, 350]]
    rgb_cols = np.array([_oklch_to_srgb_u8(c) for c in palette], dtype=np.uint8)

    # Image painted equally with the 3 palette colors -> fidelity ~1.0, coverage 1.0
    img_pal = np.zeros((90, 90, 3), dtype=np.uint8)
    img_pal[:30, :] = rgb_cols[0]
    img_pal[30:60, :] = rgb_cols[1]
    img_pal[60:, :] = rgb_cols[2]
    assert color.palette_fidelity(img_pal, palette) == pytest.approx(1.0, abs=1e-6)
    assert color.palette_coverage(img_pal, palette) == pytest.approx(1.0, abs=1e-6)

    # Image painted with only 1 of 3 palette colors -> coverage == 1/3
    img_one = np.broadcast_to(rgb_cols[0], (60, 60, 3)).copy()
    assert color.palette_coverage(img_one, palette) == pytest.approx(1.0 / 3.0, abs=1e-6)

    # Random chromatic sRGB image -> low palette fidelity
    rng = np.random.default_rng(7)
    img_rand = rng.integers(0, 256, size=(80, 80, 3), dtype=np.uint8)
    assert color.palette_fidelity(img_rand, palette) < 0.20

    # Edge case: achromatic image (<1% chromatic pixels) -> fidelity 0.0, coverage 0.0
    img_gray = np.full((50, 50, 3), 128, dtype=np.uint8)
    assert color.palette_fidelity(img_gray, palette) == 0.0
    assert color.palette_coverage(img_gray, palette) == 0.0


def test_chroma_mean_and_hue_shift():
    c1 = _oklch_to_srgb_u8([0.70, 0.15, 60.0])
    c2 = _oklch_to_srgb_u8([0.70, 0.15, 120.0])
    img1 = np.broadcast_to(c1, (40, 40, 3)).copy()
    img2 = np.broadcast_to(c2, (40, 40, 3)).copy()

    assert color.chroma_mean(img1) == pytest.approx(0.15, abs=0.01)
    assert color.hue_shift(img1, img1) == pytest.approx(0.0, abs=1e-6)
    assert color.hue_shift(img1, img2) == pytest.approx(60.0, abs=2.0)

    # Wrap-around circular distance: 350 deg vs 10 deg -> ~20 deg
    c_wrap1 = _oklch_to_srgb_u8([0.70, 0.14, 350.0])
    c_wrap2 = _oklch_to_srgb_u8([0.70, 0.14, 10.0])
    img_w1 = np.broadcast_to(c_wrap1, (30, 30, 3)).copy()
    img_w2 = np.broadcast_to(c_wrap2, (30, 30, 3)).copy()
    assert color.hue_shift(img_w1, img_w2) == pytest.approx(20.0, abs=2.5)

    # Edge case: pure black (no chromatic pixels) -> 0.0
    black = np.zeros((20, 20, 3), dtype=np.uint8)
    assert color.chroma_mean(black) == 0.0
    assert color.hue_shift(black, img1) == 0.0


def test_patch_delta():
    img = np.zeros((100, 120, 3), dtype=np.uint8)
    centers = [{"x": 20 + 20 * (i % 4), "y": 20 + 25 * (i // 4)} for i in range(12)]
    refs_srgb = []
    for i, pt in enumerate(centers):
        rgb = np.array([(i * 21) % 256, (i * 53 + 40) % 256, (i * 89 + 80) % 256], dtype=np.uint8)
        img[pt["y"] - 5 : pt["y"] + 5, pt["x"] - 5 : pt["x"] + 5] = rgb
        refs_srgb.append({"srgb": rgb.tolist()})

    assert color.patch_delta(img, centers, refs_srgb) == pytest.approx(0.0, abs=1e-7)

    # Perturb image brightness -> positive delta
    img_dark = (img // 2).astype(np.uint8)
    assert color.patch_delta(img_dark, centers, refs_srgb) > 0.05


def test_lum_metrics():
    black = np.zeros((40, 40, 3), dtype=np.uint8)
    white = np.full((40, 40, 3), 255, dtype=np.uint8)
    assert lum.lum_mean(black) == pytest.approx(0.0, abs=1e-7)
    assert lum.lum_mean(white) == pytest.approx(1.0, abs=1e-5)
    assert lum.highlight_frac(black) == 0.0
    assert lum.highlight_frac(white) == 1.0
    assert lum.lum_floor(black) is False
    assert lum.lum_floor(white) is True

    # Half bright / half dark -> highlight_frac == 0.5
    split = np.vstack([white[:20], black[:20]])
    assert lum.highlight_frac(split) == pytest.approx(0.5, abs=1e-6)
