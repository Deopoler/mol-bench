"""Capture `at` grammar parser, closed variant list, sample selection, and aggregation."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Sequence

import numpy as np

# Closed variant list mirrored from docs/ARCHITECTURE.md.
VALID_VARIANTS: frozenset[str] = frozenset({
    "normal",
    "reduced_motion",
    "pointer_left",
    "pointer_right",
    "dpr2",
    "resize_seq",
    "lifecycle_30",
    "raf30",
    "raf144",
    "empty_rooms",
    "long_title",
    "lang_en",
    "lang_ko",
    "camera_drift",
})

_RE_VP = re.compile(r"^\d+x\d+$")
_RE_VP_AND = re.compile(r"^\d+x\d+(?:\s+and\s+\d+x\d+)+$")
_RE_VP_FIRST = re.compile(r"^(\d+x\d+)\s+first\s+viewport$")
_RE_T_EQ = re.compile(r"^t=(\d+(?:\.\d+)?)$")
_RE_T0_EQ = re.compile(r"^t0=(\d+(?:\.\d+)?)$")
_RE_T_IN = re.compile(r"^t\s+in\s+\[([^\]]+)\]$")
_RE_RESIZE_ARROW = re.compile(r"^after\s+resize\s+(.+)$")


@dataclass
class AtFilter:
    """Parsed representation of a metric's `at` specification."""

    viewports: list[str] | None = None  # None means all viewports
    timestamps: list[float] | None = None  # None means all timestamps
    t0: float | None = None
    schemes: list[str] | None = None  # None means default (light when `at` given, else unfiltered)
    variant: str | None = None
    step: str | None = None
    languages: list[str] | None = None
    metal_only: bool = False
    raw: str | None = None
    tokens: list[str] = field(default_factory=list)


def _split_at_tokens(at_str: str) -> list[str]:
    """Split `at` by commas outside `[...]` brackets."""
    tokens: list[str] = []
    cur: list[str] = []
    depth = 0
    for ch in at_str:
        if ch == "[":
            depth += 1
            cur.append(ch)
        elif ch == "]":
            depth = max(0, depth - 1)
            cur.append(ch)
        elif ch == "," and depth == 0:
            tok = "".join(cur).strip()
            if tok:
                tokens.append(tok)
            cur = []
        else:
            cur.append(ch)
    tail = "".join(cur).strip()
    if tail:
        tokens.append(tail)
    return tokens


def parse_at(at_str: str | None) -> AtFilter:
    """Parse an `at` grammar string per docs/ARCHITECTURE.md.

    Raises ValueError on any unknown token (never silently ignored).
    """
    if at_str is None or not at_str.strip():
        return AtFilter(raw=at_str)

    tokens = _split_at_tokens(at_str)
    parsed = AtFilter(raw=at_str, tokens=tokens, schemes=["light"])
    ortho_views: list[str] = []

    for tok in tokens:
        low = tok.lower()
        if low == "all viewports":
            parsed.viewports = None
        elif _RE_VP.match(tok):
            parsed.viewports = (parsed.viewports or []) + [tok]
        elif _RE_VP_AND.match(low):
            vps = [v.strip() for v in re.split(r"\s+and\s+", tok, flags=re.IGNORECASE)]
            parsed.viewports = (parsed.viewports or []) + vps
        elif (m := _RE_VP_FIRST.match(low)):
            parsed.viewports = (parsed.viewports or []) + [m.group(1)]
        elif low == "all timestamps":
            parsed.timestamps = None
        elif (m := _RE_T_EQ.match(low)):
            parsed.timestamps = (parsed.timestamps or []) + [float(m.group(1))]
        elif (m := _RE_T0_EQ.match(low)):
            parsed.t0 = float(m.group(1))
        elif (m := _RE_T_IN.match(low)):
            nums = [float(x.strip()) for x in m.group(1).split(",") if x.strip()]
            if not nums:
                raise ValueError(f"Empty timestamp list in 'at' token: {tok!r}")
            parsed.timestamps = (parsed.timestamps or []) + nums
        elif low == "both schemes":
            parsed.schemes = ["light", "dark"]
        elif low == "ko and en":
            parsed.languages = ["ko", "en"]
        elif low == "after resize sequence":
            parsed.step = "resize_seq"
            parsed.variant = "resize_seq"
        elif (m := _RE_RESIZE_ARROW.match(low)):
            parts = [p.strip() for p in m.group(1).split("->")]
            if not parts or not all(_RE_VP.match(p) for p in parts):
                raise ValueError(f"Invalid resize viewport sequence in 'at': {tok!r}")
            parsed.step = "resize_seq"
            parsed.variant = "resize_seq"
        elif low == "turntable":
            parsed.step = "turntable"
        elif low == "12 hidden views":
            parsed.step = "hidden_views"
        elif low in {"front", "side", "top"}:
            ortho_views.append(low)
            parsed.step = "ortho_views"
        elif low == "camerapath micro-drift":
            parsed.variant = "camera_drift"
        elif low == "static camera":
            parsed.variant = "normal"
        elif low.startswith("variants="):
            v_list = [v.strip() for v in low.split("=", 1)[1].split("|") if v.strip()]
            if not v_list or any(v not in VALID_VARIANTS for v in v_list):
                raise ValueError(f"Unknown variant in 'at' specification: {tok!r}")
            parsed.variant = v_list[0]
        elif low.startswith("mask="):
            mask_name = tok.split("=", 1)[1].strip()
            if mask_name.lower() == "metal":
                parsed.metal_only = True
        elif low == "metal pixels":
            parsed.metal_only = True
        elif low == "metal pixels of turntable renders":
            parsed.metal_only = True
            parsed.step = "turntable"
        elif low.startswith("mask="):
            mask_name = tok.split("=", 1)[1].strip().lower()
            if mask_name == "metal":
                parsed.metal_only = True
        else:
            raise ValueError(f"Unknown token in 'at' specification: {tok!r}")

    if ortho_views and set(ortho_views) != {"front", "side", "top"}:
        # Allow partial or full ortho views as step filter without error.
        parsed.step = "ortho_views"

    return parsed


def validate_manifest_variants(manifest: dict[str, Any]) -> None:
    """Ensure every sample/sequence variant in manifest belongs to VALID_VARIANTS."""
    for kind in ("samples", "sequences"):
        for item in manifest.get(kind, []):
            v = item.get("variant")
            if v is not None and v not in VALID_VARIANTS:
                raise ValueError(
                    f"Unknown variant {v!r} in {kind} entry {item.get('key', '<unknown>')}. "
                    f"Allowed variants: {sorted(VALID_VARIANTS)}"
                )


def _match_float(val: Any, targets: list[float], tol: float = 1e-3) -> bool:
    if val is None:
        return False
    fval = float(val)
    return any(abs(fval - tgt) <= tol for tgt in targets)


def select_samples(
    samples: Sequence[dict[str, Any]],
    at_filter: AtFilter,
    *,
    default_variant: str = "normal",
    viewport_default: str | None = None,
    ignore_variant: bool = False,
) -> list[dict[str, Any]]:
    """Select manifest samples matching `at_filter` and variant rules."""
    target_variant = None if ignore_variant else (at_filter.variant or default_variant)
    out: list[dict[str, Any]] = []

    for s in samples:
        s_var = s.get("variant", "normal")
        if target_variant is not None and s_var != target_variant:
            continue

        if at_filter.viewports is not None:
            if s.get("viewport") not in at_filter.viewports:
                continue
        elif at_filter.raw is not None and viewport_default is not None and at_filter.step is None:
            # When `at` gave no viewport (e.g. "after resize sequence" or "both schemes"),
            # keep all matching step samples; if `at` explicitly omitted viewport, don't drop.
            pass

        if at_filter.timestamps is not None:
            if not _match_float(s.get("t"), at_filter.timestamps):
                continue

        if at_filter.schemes is not None:
            s_scheme = s.get("scheme", "light")
            if s_scheme not in at_filter.schemes:
                continue

        if at_filter.step is not None:
            s_step = s.get("step") or s.get("kind")
            if at_filter.step == "turntable":
                if s_step is not None and s_step != "turntable":
                    continue
                if s_step is None and "turntable" not in str(s.get("key", "")) and "view" not in s:
                    # Accept if manifest only contains turntable samples or tagged samples.
                    pass
            elif at_filter.step == "resize_seq" and s_var != "resize_seq" and s_step != "resize_seq":
                continue

        out.append(s)

    return out


def select_sequences(
    sequences: Sequence[dict[str, Any]],
    at_filter: AtFilter,
    *,
    default_variant: str = "normal",
) -> list[dict[str, Any]]:
    """Select manifest sequences matching `at_filter` and variant rules."""
    target_variant = at_filter.variant or default_variant
    out: list[dict[str, Any]] = []
    for seq in sequences:
        s_var = seq.get("variant", "normal")
        if s_var != target_variant:
            continue
        if at_filter.viewports is not None and seq.get("viewport") is not None:
            if seq.get("viewport") not in at_filter.viewports:
                continue
        if at_filter.t0 is not None and seq.get("t0") is not None:
            if abs(float(seq["t0"]) - at_filter.t0) > 1e-3:
                continue
        if at_filter.schemes is not None and seq.get("scheme") is not None:
            if seq.get("scheme") not in at_filter.schemes:
                continue
        out.append(seq)
    return out


def aggregate_values(
    values: Sequence[float | int | bool],
    agg: str = "median",
    score_spec: dict[str, Any] | None = None,
) -> float | bool:
    """Aggregate per-sample values according to `agg` (`median`, `mean`, `worst`)."""
    if not values:
        raise ValueError("Cannot aggregate empty value list")

    score_type = (score_spec or {}).get("type")
    if score_type == "pass" or isinstance(values[0], bool):
        return bool(all(bool(v) for v in values))

    nums = np.asarray(values, dtype=np.float64)
    if agg == "median":
        return float(np.median(nums))
    if agg == "mean":
        return float(np.mean(nums))
    if agg == "worst":
        if score_type == "lower":
            return float(np.max(nums))
        if score_type == "range":
            ideal = (score_spec or {}).get("ideal") or []
            if len(ideal) == 2 and ideal[0] is not None and ideal[1] is not None:
                lo, hi = float(ideal[0]), float(ideal[1])
                mid = 0.5 * (lo + hi)
                # Distance outside [lo, hi], tie-broken by distance from ideal midpoint.
                out_dist = np.maximum(0.0, np.maximum(lo - nums, nums - hi))
                if np.any(out_dist > 0.0):
                    idx = int(np.argmax(out_dist))
                    return float(nums[idx])
                idx = int(np.argmax(np.abs(nums - mid)))
                return float(nums[idx])
        return float(np.min(nums))
    raise ValueError(f"Unknown aggregation mode: {agg!r}")
