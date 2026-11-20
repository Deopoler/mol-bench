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
