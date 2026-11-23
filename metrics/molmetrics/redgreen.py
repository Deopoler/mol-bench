"""Black-box mutant-verified red-green test evaluator (`tests.redgreen_verified`, v0.2)."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable


def _find_report_entry(
    bug_id: str,
    idx: int,
    report_bugs: list[dict[str, Any]],
) -> dict[str, Any] | None:
    alt_id = f"R{idx + 1}"
    for entry in report_bugs:
        if entry.get("report_id") == bug_id or entry.get("bug_id") == bug_id:
            return entry
    for entry in report_bugs:
        if entry.get("report_id") == alt_id:
            return entry
    return None


def _is_safe_regression_test_path(rel_test: str, submission_dir: Path) -> Path | None:
    norm = rel_test.replace("\\", "/").lstrip("./")
    if not norm.startswith("tests/regression/"):
        return None
    sub_root = submission_dir.resolve()
    candidate = (sub_root / norm).resolve()
    try:
        candidate.relative_to(sub_root / "tests" / "regression")
    except ValueError:
        return None
    if not candidate.is_file():
        return None
    return candidate


def _required_other_passes(n_others: int) -> int:
    if n_others <= 0:
        return 0
    if n_others >= 4:
        return n_others - 1  # e.g. >= 4/5 for 6 planted bugs
    return n_others


def verify_redgreen_matrix(
    planted_bugs: list[str],
    report_bugs: list[dict[str, Any]],
    runs_by_bug: dict[str, dict[str, Any]],
    *,
    submission_dir: Path | None = None,
) -> dict[str, Any]:
    """Evaluate `tests.redgreen_verified` from pre-executed test outcomes.

    Per docs/V02-DESIGN.md §4.4, each planted bug `b_i` earns credit iff:
      1. Passes on agent submission (`submission == True`)
      2. Passes on clean reference (`reference == True`)
      3. Fails on mutant `b_i` (`self_mutant == False`)
      4. Passes on >= 4/5 (or >= N_other - 1) of the other active mutants `b_j (j != i)`.
    """
    if not planted_bugs:
        return {"raw": 0.0, "passed": 0, "total": 0, "detail": {"per_bug": {}}}

    passed = 0
    per_bug: dict[str, Any] = {}

    for idx, bug_id in enumerate(planted_bugs):
        entry = _find_report_entry(bug_id, idx, report_bugs)
        if not entry:
            per_bug[bug_id] = {"verified": False, "reason": "missing_report_entry"}
            continue

        rel_test = str(entry.get("test") or "").strip()
        if not rel_test.replace("\\", "/").lstrip("./").startswith("tests/regression/"):
            per_bug[bug_id] = {"verified": False, "reason": "invalid_test_path"}
            continue
        if submission_dir is not None and _is_safe_regression_test_path(rel_test, submission_dir) is None:
            per_bug[bug_id] = {"verified": False, "reason": "missing_test_file"}
            continue

        run = runs_by_bug.get(bug_id) or runs_by_bug.get(str(entry.get("report_id", "")))
        if not isinstance(run, dict):
            per_bug[bug_id] = {"verified": False, "reason": "missing_run_results"}
            continue

        sub_ok = run.get("submission") is True
        ref_ok = run.get("reference") is True
        self_mut_fail = run.get("self_mutant") is False

        other_ids = [b for b in planted_bugs if b != bug_id]
        other_map = run.get("other_mutants") or {}
        others_passed = sum(1 for b in other_ids if other_map.get(b) is True)
        req_others = _required_other_passes(len(other_ids))
        specificity_ok = others_passed >= req_others

        verified = bool(sub_ok and ref_ok and self_mut_fail and specificity_ok)
        if verified:
            passed += 1

        per_bug[bug_id] = {
            "verified": verified,
            "submission": sub_ok,
            "reference": ref_ok,
            "self_mutant_failed": self_mut_fail,
            "others_passed": others_passed,
            "others_required": req_others,
            "others_total": len(other_ids),
            "test": rel_test,
        }

    total = len(planted_bugs)
    return {
        "raw": float(passed / total) if total > 0 else 0.0,
        "passed": passed,
        "total": total,
        "detail": {"per_bug": per_bug},
    }


def _find_repo_root(start: Path) -> Path | None:
    for p in [start, *start.parents]:
        if (p / "harness" / "src" / "testing" / "room-harness.mjs").is_file():
            return p
    return None


_HARNESS_IMPORT_RE = re.compile(
    r"""((?:from|import)\s*\(?\s*)(['"])(?:\.\.?[/\\])+(?:bench|harness[/\\]src)[/\\]testing[/\\]room-harness\.mjs\2"""
)
_SANDBOX_STAGE_EXTS = {".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"}


def _stage_test_dir_for_sandbox(
    test_file: Path,
    test_dir: Path,
    harness_url: str,
    stage_root: Path,
) -> tuple[Path, Path] | None:
    """Copy `test_dir` into `stage_root` (rejecting symlinks) and rewrite relative room-harness imports."""
    abs_test_dir = test_dir.resolve()
    abs_test_file = test_file.resolve()
    try:
        rel_test_file = abs_test_file.relative_to(abs_test_dir)
    except ValueError:
        return None

    staged_dir = stage_root / "regression"
    staged_dir.mkdir(parents=True, exist_ok=True)

    for root_s, dirnames, filenames in os.walk(abs_test_dir, followlinks=False):
        root_p = Path(root_s)
        rel_dir = root_p.relative_to(abs_test_dir)
        dst_dir = staged_dir / rel_dir
        dst_dir.mkdir(parents=True, exist_ok=True)
        for dname in dirnames:
            if (root_p / dname).is_symlink():
                return None
        for fname in filenames:
            src_p = root_p / fname
            if src_p.is_symlink():
                return None
            dst_p = dst_dir / fname
            if src_p.suffix.lower() in _SANDBOX_STAGE_EXTS:
                txt = src_p.read_text(encoding="utf-8")
                rewritten = _HARNESS_IMPORT_RE.sub(lambda m: m.group(1) + json.dumps(harness_url), txt)
                dst_p.write_text(rewritten, encoding="utf-8")
            else:
                shutil.copy2(src_p, dst_p)

    staged_test_file = staged_dir / rel_test_file
    if not staged_test_file.is_file():
        return None
    return staged_test_file, staged_dir


def _run_node_test_via_harness(
    test_file: Path,
    target_dir: Path,
    test_dir: Path,
    report_id: str,
    *,
    sandboxed: bool = True,
    timeout_ms: int = 30_000,
    repo_root: Path | None = None,
) -> bool:
    """Execute one regression test file against `target_dir` using Node/room-harness."""
    if sandboxed:
        root = repo_root or _find_repo_root(Path(__file__).resolve())
        if root is None:
            return False
        harness_url = (root / "harness" / "src" / "testing" / "room-harness.mjs").as_uri()
        with tempfile.TemporaryDirectory(prefix="mol-redgreen-") as tmp_dir:
            staged = _stage_test_dir_for_sandbox(test_file, test_dir, harness_url, Path(tmp_dir))
            if staged is None:
                return False
            staged_test_file, staged_test_dir = staged
            script = (
                f"import {{ runSandboxedTest }} from {json.dumps(harness_url)};"
                f"const res = await runSandboxedTest({{"
                f"testFile: {json.dumps(str(staged_test_file))},"
                f"targetDir: {json.dumps(str(target_dir))},"
                f"testDir: {json.dumps(str(staged_test_dir))},"
                f"testNamePattern: {json.dumps(report_id)},"
                f"timeoutMs: {int(timeout_ms)}"
                f"}});"
                f"process.stdout.write(JSON.stringify({{ pass: res.pass }}));"
                f"process.exit(res.pass ? 0 : 1);"
            )
            proc = subprocess.run(
                ["node", "--input-type=module", "-e", script],
                cwd=str(root),
                capture_output=True,
                text=True,
                timeout=max(10.0, timeout_ms / 1000.0 + 10.0),
            )
            return proc.returncode == 0

    proc = subprocess.run(
        ["node", "--test", f"--test-name-pattern={report_id}", str(test_file)],
        cwd=str(test_dir),
        env={**os.environ, "MOL_TARGET_DIR": str(target_dir)},
        capture_output=True,
        text=True,
        timeout=max(10.0, timeout_ms / 1000.0 + 5.0),
    )
    return proc.returncode == 0


def run_redgreen_verification(
    *,
    planted_bugs: list[str],
    submission_dir: Path,
    reference_dir: Path,
    mutants_dir: Path,
    report_bugs: list[dict[str, Any]] | None = None,
    runner: Callable[[Path, Path, Path, str], bool] | None = None,
    sandboxed: bool = True,
    timeout_ms: int = 30_000,
    repo_root: Path | None = None,
) -> dict[str, Any]:
    """Execute the 4-way black-box mutant-specificity protocol for `tests.redgreen_verified`."""
    if report_bugs is None:
        report_path = submission_dir / "report.json"
        if report_path.is_file():
            report_data = json.loads(report_path.read_text(encoding="utf-8"))
            report_bugs = ((report_data.get("room") or {}).get("bugs")) or []
        else:
            report_bugs = []

    test_dir = submission_dir / "tests" / "regression"
    exec_fn = runner or (
        lambda tf, td, tdir, rid: _run_node_test_via_harness(
            tf, td, tdir, rid, sandboxed=sandboxed, timeout_ms=timeout_ms, repo_root=repo_root
        )
    )

    runs_by_bug: dict[str, dict[str, Any]] = {}
    for idx, bug_id in enumerate(planted_bugs):
        entry = _find_report_entry(bug_id, idx, report_bugs)
        if not entry:
            continue
        rel_test = str(entry.get("test") or "").strip()
        test_file = _is_safe_regression_test_path(rel_test, submission_dir)
        if test_file is None:
            continue

        match_id = str(entry.get("report_id") or bug_id)
        try:
            content = test_file.read_text(encoding="utf-8")
        except OSError:
            continue
        if match_id not in content and bug_id not in content:
            runs_by_bug[bug_id] = {
                "submission": False,
                "reference": False,
                "self_mutant": True,
                "other_mutants": {},
            }
            continue
        pattern = match_id if match_id in content else bug_id

        sub_ok = bool(exec_fn(test_file, submission_dir, test_dir, pattern))
        ref_ok = bool(exec_fn(test_file, reference_dir, test_dir, pattern)) if sub_ok else False

        self_mutant_dir = mutants_dir / bug_id
        self_ok = (
            bool(exec_fn(test_file, self_mutant_dir, test_dir, pattern))
            if (sub_ok and ref_ok and self_mutant_dir.is_dir())
            else True
        )

        other_results: dict[str, bool] = {}
        if sub_ok and ref_ok and (not self_ok):
            for other_id in planted_bugs:
                if other_id == bug_id:
                    continue
                other_dir = mutants_dir / other_id
                if other_dir.is_dir():
                    other_results[other_id] = bool(exec_fn(test_file, other_dir, test_dir, pattern))
                else:
                    other_results[other_id] = False

        runs_by_bug[bug_id] = {
            "submission": sub_ok,
            "reference": ref_ok,
            "self_mutant": self_ok,
            "other_mutants": other_results,
        }

    return verify_redgreen_matrix(
        planted_bugs,
        report_bugs,
        runs_by_bug,
        submission_dir=submission_dir,
    )


def _compute_redgreen_verified(ctx: dict[str, Any]) -> dict[str, Any] | None:
    manifest = ctx["manifest"]
    rg = manifest.get("redgreen") or manifest.get("redgreen_results")
    if not isinstance(rg, dict):
        return None

    planted_bugs = list(rg.get("planted_bugs") or [])
    if not planted_bugs:
        return None

    report_bugs = rg.get("report_bugs")
    if report_bugs is None and isinstance(rg.get("report"), dict):
        report_bugs = ((rg["report"].get("room") or {}).get("bugs")) or []
    report_bugs = list(report_bugs or [])

    if isinstance(rg.get("runs"), dict):
        sub_dir = Path(rg["submission_dir"]) if rg.get("submission_dir") else None
        return verify_redgreen_matrix(
            planted_bugs,
            report_bugs,
            rg["runs"],
            submission_dir=sub_dir,
        )

    sub_s = rg.get("submission_dir")
    ref_s = rg.get("reference_dir")
    mut_s = rg.get("mutants_dir")
    if sub_s and ref_s and mut_s:
        return run_redgreen_verification(
            planted_bugs=planted_bugs,
            submission_dir=Path(sub_s),
            reference_dir=Path(ref_s),
            mutants_dir=Path(mut_s),
            report_bugs=report_bugs if report_bugs else None,
            sandboxed=bool(rg.get("sandboxed", True)),
            timeout_ms=int(rg.get("timeout_ms", 30_000)),
        )

    return None


def register(METRICS: dict[str, Any]) -> None:
    """Register `tests.redgreen_verified` with molmetrics CLI."""
    METRICS["tests.redgreen_verified"] = _compute_redgreen_verified
