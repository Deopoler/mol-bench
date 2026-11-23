"""Tests for v0.2 spatial & reflection Python metrics (`spatial.py`, `reflection.py`)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from molmetrics import cli, color, reflection, spatial


def _oklch_to_srgb_u8(lch: list[float]) -> np.ndarray:
    lab = color.oklch_to_oklab(np.array([lch]), degrees=True)[0]
    lms_cbrt = np.linalg.inv(color._M2_LMS_TO_OKLAB) @ lab
    lms = lms_cbrt ** 3
    lin = np.linalg.inv(color._M1_LRGB_TO_LMS) @ lms
    srgb = color.linear_to_srgb(lin)
    return np.clip(np.round(srgb * 255.0), 0, 255).astype(np.uint8)


def _score_higher(val: float, full: float, zero: float) -> float:
    if val >= full:
        return 10.0
    if val <= zero:
        return 0.0
    return 10.0 * (val - zero) / (full - zero)


def _score_range(val: float, ideal: tuple[float, float], zero: tuple[float, float]) -> float:
    a, b = ideal
    c, d = zero
    if a <= val <= b:
        return 10.0
    if val <= c or val >= d:
        return 0.0
    if val < a:
        return 10.0 * (val - c) / (a - c)
    return 10.0 * (d - val) / (d - b)


def _make_fjord_scene(
    *,
    width: int = 320,
    height: int = 240,
    horizon_frac: float = 0.56,
    ridge_height: int = 22,
    fresnel_scale: float = 0.45,
    ripple_amp_px: float = 4.5,
    wave_phase: float = 0.0,
    rim_gain: float = 0.35,
    noise_lake: bool = False,
    flat_black_lake: bool = False,
    seed: int = 7,
) -> tuple[np.ndarray, list[list[float]]]:
    """Synthesize a Boreal Fjord scene with stratified aurora, mountain ridge, rim light, and lake."""
    palette = [
        [0.78, 0.17, 160.0],
        [0.64, 0.15, 290.0],
        [0.72, 0.14, 210.0],
    ]
    c_rgb = [
        _oklch_to_srgb_u8(palette[0]).astype(np.float64) / 255.0,
        _oklch_to_srgb_u8(palette[1]).astype(np.float64) / 255.0,
        _oklch_to_srgb_u8(palette[2]).astype(np.float64) / 255.0,
    ]
    sky_bg = np.array([0.03, 0.04, 0.08], dtype=np.float64)

    yy, xx = np.mgrid[0:height, 0:width].astype(np.float64)
    u = xx / float(width)
    v = yy / float(height)

    # Horizontally modulated aurora curtains (strong column variation for terrain_lighting)
    curtain = 0.35 + 0.65 * (0.5 + 0.5 * np.sin(2.0 * np.pi * (u * 2.3 + 0.15)))
    # Vertical altitude bands in sky [0.05 .. horizon_frac]
    b0 = np.exp(-((v - 0.14) / 0.08) ** 2)
    b1 = np.exp(-((v - 0.28) / 0.08) ** 2)
    b2 = np.exp(-((v - 0.42) / 0.08) ** 2)

    sky_lin = (
        sky_bg[None, None, :]
        + (curtain * b0)[..., None] * (c_rgb[0] ** 2.2) * 0.9
        + (curtain * b1)[..., None] * (c_rgb[1] ** 2.2) * 0.85
        + (curtain * b2)[..., None] * (c_rgb[2] ** 2.2) * 0.85
    )

    # Ridge profile & shoreline
    y_shore = int(round(horizon_frac * height))
    ridge_crest = y_shore - ridge_height + 6.0 * np.sin(2.0 * np.pi * u[0, :] * 2.0)

    img_lin = sky_lin.copy()

    # Mountain ridge interior (dark L < 0.07) + crest rim lighting (top 5 px)
    crest_row = ridge_crest[None, :]
    in_ridge = (yy >= crest_row) & (yy < y_shore)
    ridge_col = np.full_like(img_lin, 0.0001)
    if rim_gain > 0.0:
        # Overhead aurora brightness ~35 px above crest
        ov_y = np.clip(np.round(ridge_crest).astype(int) - 35, 0, height - 1)
        ov_lin = sky_lin[ov_y, np.arange(width), :]
        rim_dist = np.clip(1.0 - (yy - crest_row) / 5.0, 0.0, 1.0)
        rim_mask = (yy >= crest_row) & (yy < crest_row + 5.0)
        ov_grid = np.broadcast_to(ov_lin[None, :, :], (height, width, 3))
        ridge_col = np.where(
            rim_mask[..., None],
            0.0001 + rim_gain * ov_grid * rim_dist[..., None],
            0.0001,
        )
    img_lin = np.where(in_ridge[..., None], ridge_col, img_lin)

    # Lake reflection below shoreline
    in_lake = yy >= y_shore
    if flat_black_lake:
        img_lin[in_lake] = 0.0001
    elif noise_lake:
        rng = np.random.default_rng(seed)
        img_lin[in_lake] = rng.uniform(0.02, 0.14, size=(int(np.sum(in_lake)), 3))
    else:
        dy = np.maximum(0, yy[y_shore:, :] - y_shore)
        src_y = np.clip(np.round(y_shore - 1 - dy).astype(int), 0, y_shore - 1)
        ripple_dx = np.round(ripple_amp_px * np.sin(dy * 0.45 + xx[y_shore:, :] * 0.05 + wave_phase)).astype(int)
        src_x = np.clip(xx[y_shore:, :].astype(int) + ripple_dx, 0, width - 1)
        reflected = img_lin[src_y, src_x, :]
        # Subtle horizontal wave shading when ripples are active
        if ripple_amp_px > 0:
            wave_mod = (1.0 - 0.18 * (0.5 + 0.5 * np.sin(dy * 0.7 + wave_phase)))[..., None]
        else:
            wave_mod = 1.0
        img_lin[y_shore:, :] = reflected * fresnel_scale * wave_mod

    srgb = color.linear_to_srgb(np.clip(img_lin, 0.0, 1.0))
    return np.clip(np.round(srgb * 255.0), 0, 255).astype(np.uint8), palette


def test_palette_band_sep_good_bad_attack_separation():
    palette = [[0.78, 0.17, 160.0], [0.64, 0.15, 290.0], [0.72, 0.14, 210.0]]
    c0, c1, c2 = [_oklch_to_srgb_u8(p) for p in palette]

    # Good: 3 stratified horizontal bands in sky
    good = np.zeros((180, 240, 3), dtype=np.uint8)
    good[0:40, :] = c0
    good[40:80, :] = c1
    good[80:120, :] = c2
    val_good = spatial.palette_band_sep(good, palette, horizon_y=120 / 180)
    sc_good = _score_higher(val_good, 0.75, 0.25)
    assert val_good >= 0.75
    assert sc_good == 10.0

    # Bad: minority 3rd color only ~3% share and narrow vertical separation
    bad = np.zeros((180, 240, 3), dtype=np.uint8)
    bad[40:78, :] = c0
    bad[78:116, :] = c1
    bad[116:120, :] = c2  # ~5% share, tightly clustered
    val_bad = spatial.palette_band_sep(bad, palette, horizon_y=120 / 180)
    sc_bad = _score_higher(val_bad, 0.75, 0.25)
    assert 0.30 < val_bad < 0.70

    # Attack 1: vertical stripes (all 3 colors present, zero vertical altitude separation)
    attack_stripes = np.zeros((180, 240, 3), dtype=np.uint8)
    attack_stripes[:, 0:80] = c0
    attack_stripes[:, 80:160] = c1
    attack_stripes[:, 160:240] = c2
    val_atk1 = spatial.palette_band_sep(attack_stripes, palette, horizon_y=120 / 180)
    sc_atk1 = _score_higher(val_atk1, 0.75, 0.25)
    assert val_atk1 < 0.10
    assert sc_atk1 == 0.0

    # Attack 2: flat black sky (missing chromatic pixels)
    attack_black = np.zeros((180, 240, 3), dtype=np.uint8)
    val_atk2 = spatial.palette_band_sep(attack_black, palette, horizon_y=120 / 180)
    assert val_atk2 == 0.0

    assert sc_good - sc_bad >= 4.0 or sc_bad - sc_atk1 >= 4.0
    assert sc_good - sc_atk1 >= 9.0


def test_reflection_coherence_water_ripple_and_terrain_lighting_separation():
    # Good: Fresnel-attenuated rippled reflection + correlated rim lighting + dark interior
    good_img, _pal = _make_fjord_scene(fresnel_scale=0.45, ripple_amp_px=5.0, rim_gain=0.40)

    # Bad: weak correlation / unrippled or noisy or over-bright Fresnel
    bad_unattenuated, _ = _make_fjord_scene(fresnel_scale=0.95, ripple_amp_px=5.0, rim_gain=0.0)
    bad_unrippled, _ = _make_fjord_scene(fresnel_scale=0.45, ripple_amp_px=0.0, rim_gain=0.0)

    # Attacks
    atk_flat_black, _ = _make_fjord_scene(flat_black_lake=True, rim_gain=0.0)
    atk_noise_lake, _ = _make_fjord_scene(noise_lake=True, rim_gain=0.0)

    # 1. scene.reflection_coherence (higher: full 0.62, zero 0.20)
    rc_good = reflection.reflection_coherence(good_img, horizon_y=0.56)
    rc_bad_fresnel = reflection.reflection_coherence(bad_unattenuated, horizon_y=0.56)
    rc_atk_black = reflection.reflection_coherence(atk_flat_black, horizon_y=0.56)
    rc_atk_noise = reflection.reflection_coherence(atk_noise_lake, horizon_y=0.56)

    assert rc_good >= 0.62, f"Expected good reflection_coherence >= 0.62, got {rc_good}"
    assert rc_bad_fresnel == 0.0  # Violates mean L_lake < 0.85 * mean L_sky
    assert rc_atk_black == 0.0
    assert rc_atk_noise < 0.20
    assert _score_higher(rc_good, 0.62, 0.20) - _score_higher(rc_atk_noise, 0.62, 0.20) >= 8.0

    # 2. scene.water_ripple (range: ideal [0.015, 0.12], zero [0.0, 0.30])
    wr_good = reflection.water_ripple(good_img, horizon_y=0.56)
    wr_unrippled = reflection.water_ripple(bad_unrippled, horizon_y=0.56)
    wr_noise = reflection.water_ripple(atk_noise_lake, horizon_y=0.56)
    wr_black = reflection.water_ripple(atk_flat_black, horizon_y=0.56)

    sc_wr_good = _score_range(wr_good, (0.015, 0.12), (0.0, 0.30))
    sc_wr_unrippled = _score_range(wr_unrippled, (0.015, 0.12), (0.0, 0.30))
    sc_wr_noise = _score_range(wr_noise, (0.015, 0.12), (0.0, 0.30))
    assert sc_wr_good == 10.0, f"Expected wr_good in [0.015, 0.12], got {wr_good}"
    assert sc_wr_unrippled <= 2.0, f"Unrippled mirror should score low, got {wr_unrippled}"
    assert sc_wr_noise <= 2.0, f"Isotropic noise lake should score low, got {wr_noise}"
    assert wr_black == 0.0
    assert sc_wr_good - sc_wr_unrippled >= 8.0
    assert sc_wr_good - sc_wr_noise >= 8.0

    # 3. scene.terrain_lighting (higher: full 0.55, zero 0.10)
    tl_good = reflection.terrain_lighting(good_img, horizon_y=0.56)
    tl_no_rim = reflection.terrain_lighting(bad_unrippled, horizon_y=0.56)
    sc_tl_good = _score_higher(tl_good, 0.55, 0.10)
    sc_tl_no_rim = _score_higher(tl_no_rim, 0.55, 0.10)
    assert tl_good >= 0.70, f"Expected good terrain_lighting >= 0.70, got {tl_good}"
    assert tl_no_rim == 0.0
    assert sc_tl_good - sc_tl_no_rim == 10.0


def test_v2_cli_autodiscovery_and_consecutive_repeatability(tmp_path: Path):
    from PIL import Image

    good_t1, pal = _make_fjord_scene(fresnel_scale=0.45, ripple_amp_px=5.0, wave_phase=0.0, rim_gain=0.40)
    good_t2, _ = _make_fjord_scene(fresnel_scale=0.45, ripple_amp_px=5.0, wave_phase=2.2, rim_gain=0.40)
    frames_dir = tmp_path / "frames"
    frames_dir.mkdir()
    Image.fromarray(good_t1).save(frames_dir / "s1_t1.png")
    Image.fromarray(good_t2).save(frames_dir / "s1_t2.png")

    manifest = {
        "room": "aurora",
        "viewport_default": "320x240",
        "params": {"1": {"palette": pal, "horizonY": 0.56}},
        "webgl": {
            "draw_calls_per_frame": 1,
            "programs": [
                {
                    "vertex": "in vec2 a_pos; out vec2 v_uv; void main(){v_uv=a_pos*0.5+0.5; gl_Position=vec4(a_pos,0.0,1.0);}",
                    "fragment": "precision highp float; in vec2 v_uv; uniform float u_t; out vec4 o; void main(){float w=sin(v_uv.x*6.0+u_t)*0.5+0.5; o=vec4(0.1,w*0.8,0.5,1.0);}",
                    "draw_calls": 1,
                }
            ],
        },
        "samples": [
            {
                "key": "s1_t1000_320x240_light_normal",
                "seed": 1,
                "t": 1000,
                "viewport": "320x240",
                "scheme": "light",
                "variant": "normal",
                "file": "frames/s1_t1.png",
            },
            {
                "key": "s1_t4720_320x240_light_normal",
                "seed": 1,
                "t": 4720,
                "viewport": "320x240",
                "scheme": "light",
                "variant": "normal",
                "file": "frames/s1_t2.png",
            },
        ],
    }
    spec = {
        "room": "aurora",
        "spec_version": "0.2.0",
        "metrics": [
            {"id": "color.palette_band_sep", "at": "320x240, all timestamps"},
            {"id": "scene.reflection_coherence", "at": "320x240, t=4720"},
            {"id": "scene.water_ripple", "at": "320x240, t=4720"},
            {"id": "scene.terrain_lighting", "at": "320x240, all timestamps"},
        ],
    }
    m_path = tmp_path / "manifest.json"
    s_path = tmp_path / "spec.json"
    m_path.write_text(json.dumps(manifest), encoding="utf-8")
    s_path.write_text(json.dumps(spec), encoding="utf-8")

    out1 = tmp_path / "out1.json"
    out2 = tmp_path / "out2.json"
    assert cli.main(["compute", "--manifest", str(m_path), "--spec", str(s_path), "--out", str(out1)]) == 0
    assert cli.main(["compute", "--manifest", str(m_path), "--spec", str(s_path), "--out", str(out2)]) == 0

    raw1 = out1.read_text(encoding="utf-8")
    raw2 = out2.read_text(encoding="utf-8")
    assert raw1 == raw2

    parsed = json.loads(raw1)
    assert parsed["color.palette_band_sep"]["raw"] >= 0.75
    assert parsed["scene.reflection_coherence"]["raw"] >= 0.62
    assert 0.015 <= parsed["scene.water_ripple"]["raw"] <= 0.12
    assert parsed["scene.terrain_lighting"]["raw"] >= 0.55


def test_reflection_rejects_static_image_and_missing_webgl(tmp_path: Path):
    from PIL import Image

    good_t1, pal = _make_fjord_scene(fresnel_scale=0.45, ripple_amp_px=5.0, wave_phase=0.0, rim_gain=0.40)
    good_t2, _ = _make_fjord_scene(fresnel_scale=0.45, ripple_amp_px=5.0, wave_phase=2.2, rim_gain=0.40)
    frames_dir = tmp_path / "frames"
    frames_dir.mkdir()
    Image.fromarray(good_t1).save(frames_dir / "t1.png")
    Image.fromarray(good_t2).save(frames_dir / "t2.png")

    spec = {
        "room": "aurora",
        "spec_version": "0.2.0",
        "metrics": [
            {"id": "scene.reflection_coherence", "at": "320x240, t=4720"},
            {"id": "scene.water_ripple", "at": "320x240, t=4720"},
            {"id": "scene.terrain_lighting", "at": "320x240, all timestamps"},
        ],
    }
    s_path = tmp_path / "spec.json"
    s_path.write_text(json.dumps(spec), encoding="utf-8")

    # 1. Identical static frame across both timestamps -> fails with 0.0 (even with WebGL present)
    static_manifest = {
        "room": "aurora",
        "viewport_default": "320x240",
        "params": {"1": {"palette": pal, "horizonY": 0.56}},
        "webgl": {
            "draw_calls_per_frame": 1,
            "programs": [
                {
                    "vertex": "in vec2 a_pos; out vec2 v_uv; void main(){v_uv=a_pos*0.5+0.5; gl_Position=vec4(a_pos,0.0,1.0);}",
                    "fragment": "precision highp float; in vec2 v_uv; uniform float u_t; out vec4 o; void main(){float w=sin(v_uv.x*6.0+u_t)*0.5+0.5; o=vec4(0.1,w*0.8,0.5,1.0);}",
                    "draw_calls": 1,
                }
            ],
        },
        "samples": [
            {"key": "s1_t1", "seed": 1, "t": 1000, "viewport": "320x240", "scheme": "light", "variant": "normal", "file": "frames/t1.png"},
            {"key": "s1_t4720", "seed": 1, "t": 4720, "viewport": "320x240", "scheme": "light", "variant": "normal", "file": "frames/t1.png"},
        ],
    }
    m_static = tmp_path / "m_static.json"
    m_static.write_text(json.dumps(static_manifest), encoding="utf-8")
    res_static = cli.compute_metrics(m_static, s_path)
    assert res_static["scene.reflection_coherence"]["raw"] == 0.0
    assert res_static["scene.water_ripple"]["raw"] == 0.0
    assert res_static["scene.terrain_lighting"]["raw"] == 0.0

    # 2. Moving frames but missing live-WebGL evidence (e.g. 2D canvas / fake) -> fail 0.0 (not skipped)
    no_webgl_manifest = {
        "room": "aurora",
        "viewport_default": "320x240",
        "params": {"1": {"palette": pal, "horizonY": 0.56}},
        "samples": [
            {"key": "s1_t1", "seed": 1, "t": 1000, "viewport": "320x240", "scheme": "light", "variant": "normal", "file": "frames/t1.png"},
            {"key": "s1_t4720", "seed": 1, "t": 4720, "viewport": "320x240", "scheme": "light", "variant": "normal", "file": "frames/t2.png"},
        ],
    }
    m_nowgl = tmp_path / "m_nowgl.json"
    m_nowgl.write_text(json.dumps(no_webgl_manifest), encoding="utf-8")
    res_nowgl = cli.compute_metrics(m_nowgl, s_path)
    assert res_nowgl["scene.reflection_coherence"]["raw"] == 0.0
    assert res_nowgl["scene.water_ripple"]["raw"] == 0.0
    assert res_nowgl["scene.terrain_lighting"]["raw"] == 0.0

