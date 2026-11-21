"""Tests for `at` grammar parser, closed variant validation, determinism, and CLI."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from molmetrics import IMPLEMENTED_METRICS, cli
from molmetrics.select import VALID_VARIANTS, parse_at, validate_manifest_variants

DATA_DIR = Path(__file__).resolve().parent / "data"


def test_parse_at_grammar_valid_tokens():
    f1 = parse_at("all viewports, all timestamps")
    assert f1.viewports is None
    assert f1.timestamps is None
    assert f1.schemes == ["light"]

    f2 = parse_at("1440x900, t in [1000, 4000, 9000]")
    assert f2.viewports == ["1440x900"]
    assert f2.timestamps == [1000.0, 4000.0, 9000.0]

    f3 = parse_at("all viewports, both schemes")
    assert f3.schemes == ["light", "dark"]

    f4 = parse_at("after resize 1440x900 -> 768x1024 -> 1200x700")
    assert f4.variant == "resize_seq"
    assert f4.step == "resize_seq"

    f5 = parse_at("front, side, top")
    assert f5.step == "ortho_views"

    f6 = parse_at("1440x900, t0=2500")
    assert f6.t0 == 2500.0


def test_parse_at_rejects_unknown_tokens():
    with pytest.raises(ValueError, match="Unknown token"):
        parse_at("1440x900, whenever_feels_nice")
    with pytest.raises(ValueError, match="Unknown token"):
        parse_at("bogus token")


def test_validate_manifest_variants():
    assert "reduced_motion" in VALID_VARIANTS
    assert "camera_drift" in VALID_VARIANTS
    validate_manifest_variants({"samples": [{"key": "a", "variant": "normal"}]})
    with pytest.raises(ValueError, match="Unknown variant"):
        validate_manifest_variants({"samples": [{"key": "a", "variant": "unknown_var"}]})


def test_cli_compute_on_sample_data_and_determinism(tmp_path):
    manifest_path = DATA_DIR / "manifest.json"
    spec_path = DATA_DIR / "spec.json"
    start_path = DATA_DIR / "start_manifest.json"
    out1 = tmp_path / "metrics1.json"
    out2 = tmp_path / "metrics2.json"

    rc1 = cli.main([
        "compute",
        "--manifest", str(manifest_path),
        "--spec", str(spec_path),
        "--renovation-start", str(start_path),
        "--out", str(out1),
    ])
    rc2 = cli.main([
        "compute",
        "--manifest", str(manifest_path),
        "--spec", str(spec_path),
        "--renovation-start", str(start_path),
        "--out", str(out2),
    ])
    assert rc1 == 0 and rc2 == 0

    raw1 = out1.read_text(encoding="utf-8")
    raw2 = out2.read_text(encoding="utf-8")
    assert raw1 == raw2  # Strict byte-for-byte determinism

    data = json.loads(raw1)
    assert "perf.frame_p95_norm_ms" in data["_skipped"]
    assert "lum.mean" in data
    assert "color.palette_fidelity" in data
    assert "render.banding" in data
    assert "time.flicker" in data
    assert "color.hue_shift" in data
    assert data["lum.mean"]["samples"][0]["key"] == "s1_t0_1440x900_light"
    assert len(IMPLEMENTED_METRICS) == 29


def test_motion_pairs_from_samples_and_element_ssim_full_file(tmp_path):
    import numpy as np
    from PIL import Image

    frames = tmp_path / "frames"
    start_frames = tmp_path / "start_frames"
    frames.mkdir()
    start_frames.mkdir()

    def write_img(path: Path, rgb: tuple[int, int, int], w: int = 32, h: int = 48):
        arr = np.zeros((h, w, 3), dtype=np.uint8)
        arr[:, :] = rgb
        Image.fromarray(arr).save(path)

    write_img(frames / "f0.png", (40, 40, 40))
    write_img(frames / "f1.png", (80, 80, 80))
    write_img(frames / "rm0.png", (50, 50, 50))
    write_img(frames / "rm1.png", (50, 50, 50))
    write_img(frames / "sub_vp.png", (10, 10, 10), 32, 24)
    write_img(start_frames / "start_vp.png", (10, 10, 10), 32, 24)

    # Full-page screenshots contain an identical protected element below the viewport fold (y=28)
    full0 = np.full((60, 32, 3), 20, dtype=np.uint8)
    full0[28:44, 4:28] = (50, 120, 180)
    full1 = np.full((60, 32, 3), 220, dtype=np.uint8)
    full1[34:50, 4:28] = (50, 120, 180)
    Image.fromarray(full0).save(start_frames / "start_full.png")
    Image.fromarray(full1).save(frames / "sub_full.png")

    start_manifest = {
        "room": "test",
        "viewport_default": "32x24",
        "samples": [
            {
                "key": "s1_t0_32x24_light_normal",
                "seed": 1,
                "t": 0,
                "viewport": "32x24",
                "scheme": "light",
                "variant": "normal",
                "file": "start_frames/start_vp.png",
                "full_file": "start_frames/start_full.png",
                "element_bboxes": [{"selector": "footer#0", "bbox": {"x": 4, "y": 28, "width": 24, "height": 16}}],
            }
        ],
    }
    manifest = {
        "room": "test",
        "viewport_default": "32x24",
        "samples": [
            {
                "key": "s1_t0_32x24_light_normal",
                "seed": 1,
                "t": 0,
                "viewport": "32x24",
                "scheme": "light",
                "variant": "normal",
                "file": "frames/sub_vp.png",
                "full_file": "frames/sub_full.png",
                "element_bboxes": [{"selector": "footer#0", "bbox": {"x": 4, "y": 34, "width": 24, "height": 16}}],
            },
            {"key": "m0", "seed": 1, "t": 1000, "viewport": "32x24", "scheme": "light", "variant": "normal", "file": "frames/f0.png"},
            {"key": "m1", "seed": 1, "t": 1016.667, "viewport": "32x24", "scheme": "light", "variant": "normal", "file": "frames/f1.png"},
            {"key": "rm0", "seed": 1, "t": 0, "viewport": "32x24", "scheme": "light", "variant": "reduced_motion", "file": "frames/rm0.png"},
            {"key": "rm1", "seed": 1, "t": 16.667, "viewport": "32x24", "scheme": "light", "variant": "reduced_motion", "file": "frames/rm1.png"},
        ],
    }
    start_path = tmp_path / "start_manifest.json"
    manifest_path = tmp_path / "manifest.json"
    spec_path = tmp_path / "spec.json"
    start_path.write_text(json.dumps(start_manifest), encoding="utf-8")
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    spec_path.write_text(
        json.dumps({
            "room": "test",
            "metrics": [
                {"id": "time.motion", "at": "32x24"},
                {"id": "a11y.reduced_motion", "at": "32x24"},
                {"id": "mask.element_ssim"},
            ],
        }),
        encoding="utf-8",
    )

    out = cli.compute_metrics(manifest_path, spec_path, start_path)
    assert out["time.motion"]["raw"] > 0.05
    assert out["a11y.reduced_motion"]["raw"] == 0.0
    assert out["mask.element_ssim"]["raw"] == pytest.approx(1.0, abs=1e-5)
