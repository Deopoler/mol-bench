"""Tests for v0.2 black-box mutant-verified red-green evaluator (`redgreen.py`)."""

from __future__ import annotations

import json
from pathlib import Path

from molmetrics import cli, redgreen


def _planted() -> list[str]:
    return [
        "POSTFX_DOUBLE_TONEMAP",
        "NORMAL_MAP_GREEN_INVERTED",
        "SHADOW_BIAS_ACNE_VS_DETACH",
        "SHARED_RESOURCE_DISPOSE_TRAP",
        "ASYNC_SEED_RACE",
        "DPR_FBO_RESIZE_DESYNC",
    ]


def test_redgreen_verified_good_bad_attack_separation():
    planted = _planted()
    report_bugs = [
        {"report_id": b, "root_cause": b, "test": f"tests/regression/{b.lower()}.test.mjs"}
        for b in planted
    ]

    # Good: every bug passes submission & reference, fails own mutant, passes 5/5 other mutants
    good_runs = {
        b: {
            "submission": True,
            "reference": True,
            "self_mutant": False,
            "other_mutants": {o: True for o in planted if o != b},
        }
        for b in planted
    }
    res_good = redgreen.verify_redgreen_matrix(planted, report_bugs, good_runs)
    assert res_good["raw"] == 1.0  # 10.0 pts

    # Bad: 3/6 verified (1 missing, 1 fails specificity by failing 2/5 other mutants, 1 passes own mutant)
    bad_runs = dict(good_runs)
    bad_runs[planted[3]] = {
        "submission": True,
        "reference": True,
        "self_mutant": True,  # Failed to catch its own mutant!
        "other_mutants": {o: True for o in planted if o != planted[3]},
    }
    bad_runs[planted[4]] = {
        "submission": True,
        "reference": True,
        "self_mutant": False,
        "other_mutants": {o: (idx < 3) for idx, o in enumerate([x for x in planted if x != planted[4]])},  # 3/5 < 4/5
    }
    bad_runs[planted[5]] = {
        "submission": True,
        "reference": False,  # Fails clean reference
        "self_mutant": False,
        "other_mutants": {o: True for o in planted if o != planted[5]},
    }
    res_bad = redgreen.verify_redgreen_matrix(planted, report_bugs, bad_runs)
    assert res_bad["raw"] == 0.5  # 5.0 pts

    # Attack 1: tautological always-pass tests (pass own mutant too -> 0.0)
    atk_always_pass = {
        b: {
            "submission": True,
            "reference": True,
            "self_mutant": True,
            "other_mutants": {o: True for o in planted if o != b},
        }
        for b in planted
    }
    res_atk1 = redgreen.verify_redgreen_matrix(planted, report_bugs, atk_always_pass)
    assert res_atk1["raw"] == 0.0  # 0.0 pts

    # Attack 2: catch-all test that fails on every mutant (0/5 other mutants pass -> 0.0)
    atk_catchall = {
        b: {
            "submission": True,
            "reference": True,
            "self_mutant": False,
            "other_mutants": {o: False for o in planted if o != b},
        }
        for b in planted
    }
    res_atk2 = redgreen.verify_redgreen_matrix(planted, report_bugs, atk_catchall)
    assert res_atk2["raw"] == 0.0

    # >= 4 score point separation
    assert (res_good["raw"] - res_bad["raw"]) * 10.0 >= 4.0
    assert (res_bad["raw"] - res_atk1["raw"]) * 10.0 >= 4.0


def test_redgreen_live_runner_on_synthetic_node_targets(tmp_path: Path):
    """Run real non-browser node:test files against submission/reference/mutant directories."""
    sub = tmp_path / "submission"
    ref = tmp_path / "reference"
    muts = tmp_path / "mutants"
    for d in (sub, ref, muts / "B1", muts / "B2"):
        (d / "room").mkdir(parents=True, exist_ok=True)

    # Mock target state JSON inside each dir (read via MOL_TARGET_DIR in unsandboxed mock runner)
    (sub / "room" / "state.json").write_text(json.dumps({"b1Fixed": True, "b2Fixed": True}), encoding="utf-8")
    (ref / "room" / "state.json").write_text(json.dumps({"b1Fixed": True, "b2Fixed": True}), encoding="utf-8")
    (muts / "B1" / "room" / "state.json").write_text(json.dumps({"b1Fixed": False, "b2Fixed": True}), encoding="utf-8")
    (muts / "B2" / "room" / "state.json").write_text(json.dumps({"b1Fixed": True, "b2Fixed": False}), encoding="utf-8")

    test_dir = sub / "tests" / "regression"
    test_dir.mkdir(parents=True, exist_ok=True)
    test_file = test_dir / "reg.test.mjs"
    test_file.write_text(
        """import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function loadState() {
  return JSON.parse(fs.readFileSync(path.join(process.env.MOL_TARGET_DIR, 'room', 'state.json'), 'utf8'));
}
test('B1 checks b1Fixed', () => { assert.equal(loadState().b1Fixed, true); });
test('B2 checks b2Fixed', () => { assert.equal(loadState().b2Fixed, true); });
""",
        encoding="utf-8",
    )

    report = {
        "room": {
            "bugs": [
                {"report_id": "B1", "root_cause": "B1", "test": "tests/regression/reg.test.mjs"},
                {"report_id": "B2", "root_cause": "B2", "test": "tests/regression/reg.test.mjs"},
            ]
        }
    }
    (sub / "report.json").write_text(json.dumps(report), encoding="utf-8")

    r1 = redgreen.run_redgreen_verification(
        planted_bugs=["B1", "B2"],
        submission_dir=sub,
        reference_dir=ref,
        mutants_dir=muts,
        sandboxed=False,
    )
    r2 = redgreen.run_redgreen_verification(
        planted_bugs=["B1", "B2"],
        submission_dir=sub,
        reference_dir=ref,
        mutants_dir=muts,
        sandboxed=False,
    )
    assert r1 == r2
    assert r1["raw"] == 1.0
    assert r1["passed"] == 2 and r1["total"] == 2


def test_redgreen_cli_integration(tmp_path: Path):
    planted = _planted()
    manifest = {
        "room": "restoration",
        "redgreen": {
            "planted_bugs": planted,
            "report_bugs": [
                {"report_id": b, "root_cause": b, "test": f"tests/regression/{b}.test.mjs"}
                for b in planted
            ],
            "runs": {
                b: {
                    "submission": True,
                    "reference": True,
                    "self_mutant": False,
                    "other_mutants": {o: True for o in planted if o != b},
                }
                for b in planted
            },
        },
    }
    spec = {
        "room": "restoration",
        "spec_version": "0.2.0",
        "metrics": [{"id": "tests.redgreen_verified"}],
    }
    m_path = tmp_path / "manifest.json"
    s_path = tmp_path / "spec.json"
    m_path.write_text(json.dumps(manifest), encoding="utf-8")
    s_path.write_text(json.dumps(spec), encoding="utf-8")

    res1 = cli.compute_metrics(m_path, s_path)
    res2 = cli.compute_metrics(m_path, s_path)
    assert res1 == res2
    assert res1["tests.redgreen_verified"]["raw"] == 1.0
