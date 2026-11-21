"""CLI and orchestration for `python -m molmetrics compute`."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

from . import IMPLEMENTED_METRICS, color, lum, mask, ref, render, scene, shape, time_, visual
from .io import load_image, load_json, load_mask, load_sequence_frames, resolve_path, save_json
from .select import (
    AtFilter,
    aggregate_values,
    parse_at,
    select_samples,
    select_sequences,
    validate_manifest_variants,
)


def extract_spec_metrics(spec: dict[str, Any]) -> list[dict[str, Any]]:
    """Collect metric entries from top-level `metrics`, `requests[].metrics`, and `bug_pool`."""
    entries: dict[str, dict[str, Any]] = {}

    def _add(m: dict[str, Any]) -> None:
        mid = m["id"]
        if mid not in entries:
            entries[mid] = dict(m)

    for m in spec.get("metrics", []):
        _add(m)
    for req in spec.get("requests", []):
        for m in req.get("metrics", []):
            _add(m)
    for bugs in spec.get("bug_pool", {}).values():
        for bug in bugs:
            for m in bug.get("metrics", []):
                _add(m)

    return list(entries.values())


def _sample_identity(s: dict[str, Any]) -> tuple[Any, ...]:
    """Key tuple used to pair samples across variants or manifests."""
    return (
        s.get("seed"),
        s.get("t"),
        s.get("viewport"),
        s.get("scheme", "light"),
        s.get("view"),
    )


def _get_params_for_seed(manifest: dict[str, Any], seed: Any) -> dict[str, Any]:
    params = manifest.get("params", {})
    if str(seed) in params:
        return params[str(seed)]
    if seed in params:
        return params[seed]
    return {}


def _resolve_mask(
    mask_ref: str | Path,
    target_shape: tuple[int, int],
    base_dirs: tuple[Path | None, ...],
):
    p = resolve_path(mask_ref, *base_dirs)
    return load_mask(p, target_shape=target_shape)


def _motion_pairs_from_samples(
    samples_all: list[dict[str, Any]],
    at_filter: AtFilter,
    variant: str,
    vp_default: str | None,
) -> list[tuple[str, list[tuple[dict[str, Any], dict[str, Any]]]]]:
    """Group (t, t + 16.667ms) sample pairs per (seed, viewport, scheme) when emitted by motionFrames."""
    selected = select_samples(
        samples_all, at_filter, default_variant=variant, viewport_default=vp_default
    )
    groups: dict[tuple[Any, Any, Any], list[dict[str, Any]]] = {}
    for s in selected:
        if s.get("t") is None:
            continue
        gk = (s.get("seed"), s.get("viewport"), s.get("scheme", "light"))
        groups.setdefault(gk, []).append(s)

    grouped_pairs: list[tuple[str, list[tuple[dict[str, Any], dict[str, Any]]]]] = []
    for (seed, viewport, scheme), items in groups.items():
        items_sorted = sorted(items, key=lambda x: float(x["t"]))
        pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []
        used: set[int] = set()
        for i, s0 in enumerate(items_sorted):
            if i in used:
                continue
            t0 = float(s0["t"])
            for j in range(i + 1, len(items_sorted)):
                if j in used:
                    continue
                t1 = float(items_sorted[j]["t"])
                if abs((t1 - t0) - 16.667) <= 0.05:
                    pairs.append((s0, items_sorted[j]))
                    used.add(i)
                    used.add(j)
                    break
        if pairs:
            key = f"motion_s{seed}_{viewport}_{scheme}_{variant}"
            grouped_pairs.append((key, pairs[:10]))
    return grouped_pairs


def _compute_single_metric(
    metric_id: str,
    metric_cfg: dict[str, Any],
    manifest: dict[str, Any],
    spec: dict[str, Any],
    start_manifest: dict[str, Any] | None,
    base_dirs: tuple[Path | None, ...],
    start_dirs: tuple[Path | None, ...],
    img_cache: dict[Path, Any] | None = None,
) -> dict[str, Any] | None:
    """Compute one implemented metric. Returns result dict or None if required inputs are absent."""
    at_filter: AtFilter = parse_at(metric_cfg.get("at"))
    agg = metric_cfg.get("agg", "median")
    score_spec = metric_cfg.get("score")
    samples_all = manifest.get("samples", [])
    seqs_all = manifest.get("sequences", [])
    vp_default = manifest.get("viewport_default")

    def _load_cached(rel_or_abs: str | Path, dirs: tuple[Path | None, ...]):
        resolved = resolve_path(rel_or_abs, *dirs)
        if img_cache is not None and resolved in img_cache:
            return img_cache[resolved]
        arr = load_image(resolved)
        if img_cache is not None and len(img_cache) < 200:
            arr.setflags(write=False)
            img_cache[resolved] = arr
        return arr

    def _load(sample: dict[str, Any]):
        return _load_cached(sample["file"], base_dirs)

    def _load_start(sample: dict[str, Any]):
        return _load_cached(sample["file"], start_dirs)

    results: list[dict[str, Any]] = []
    detail: dict[str, Any] = {}

    # 1. Sequence-based time metrics
    if metric_id in {"time.motion", "a11y.reduced_motion"}:
        variant = "reduced_motion" if metric_id == "a11y.reduced_motion" else "normal"
        sample_groups = _motion_pairs_from_samples(samples_all, at_filter, variant, vp_default)
        if sample_groups:
            for gkey, spairs in sample_groups:
                img_pairs = [(_load(a), _load(b)) for a, b in spairs]
                val = time_.motion_from_pairs(img_pairs)
                results.append({"key": gkey, "value": val})
        else:
            seqs = select_sequences(seqs_all, at_filter, default_variant=variant)
            if not seqs and metric_id == "time.motion":
                # Fallback: look for sequence entries tagged with metric or kind
                seqs = [s for s in seqs_all if s.get("variant", "normal") == "normal"]
            if not seqs:
                return None
            for seq in seqs:
                if "pairs" in seq:
                    pairs = [
                        (
                            load_image(resolve_path(a, *base_dirs)),
                            load_image(resolve_path(b, *base_dirs)),
                        )
                        for a, b in seq["pairs"]
                    ]
                    val = time_.motion_from_pairs(pairs)
                else:
                    frames = load_sequence_frames(seq, base_dirs)
                    val = time_.motion(frames)
                results.append({"key": seq["key"], "value": val})

    elif metric_id in {"time.flicker", "time.flicker_region"}:
        default_var = "camera_drift" if metric_id == "time.flicker_region" else "normal"
        seqs = select_sequences(seqs_all, at_filter, default_variant=default_var)
        if not seqs and metric_id == "time.flicker_region":
            seqs = select_sequences(seqs_all, at_filter, default_variant="normal")
        if not seqs:
            return None
        for seq in seqs:
            frames = load_sequence_frames(seq, base_dirs)
            dt_ms = float(seq.get("dt", 16.667))
            if metric_id == "time.flicker_region":
                mask_ref = seq.get("mask") or metric_cfg.get("mask")
                if mask_ref is None:
                    return None
                m = _resolve_mask(mask_ref, frames[0].shape[:2], base_dirs)
                val = time_.flicker_region(frames, m, dt_ms=dt_ms)
            else:
                val = time_.flicker(frames, dt_ms=dt_ms)
            results.append({"key": seq["key"], "value": val})

    # 2. Paired-variant metrics
    elif metric_id == "render.aliasing":
        normal_samples = select_samples(
            samples_all, at_filter, default_variant="normal", viewport_default=vp_default
        )
        dpr2_samples = select_samples(
            samples_all, at_filter, default_variant="dpr2", viewport_default=vp_default
        )
        dpr2_by_id = {_sample_identity(s): s for s in dpr2_samples}
        for s in normal_samples:
            if "dpr2_file" in s:
                img_b = load_image(resolve_path(s["dpr2_file"], *base_dirs))
            else:
                match = dpr2_by_id.get(_sample_identity(s))
                if match is None:
                    continue
                img_b = _load(match)
            img_a = _load(s)
            results.append({"key": s["key"], "value": render.aliasing(img_a, img_b)})
        if not results:
            return None

    elif metric_id == "interact.pointer_response":
        left_samples = select_samples(
            samples_all, at_filter, default_variant="pointer_left", viewport_default=vp_default
        )
        right_samples = select_samples(
            samples_all, at_filter, default_variant="pointer_right", viewport_default=vp_default
        )
        right_by_id = {_sample_identity(s): s for s in right_samples}
        for s_l in left_samples:
            s_r = right_by_id.get(_sample_identity(s_l))
            if s_r is None:
                continue
            val = ref.pointer_response(_load(s_l), _load(s_r))
            results.append({"key": s_l["key"], "value": val})
        if not results:
            return None

    elif metric_id == "reduced_motion.not_blank":
        norm_samples = select_samples(
            samples_all, at_filter, default_variant="normal", viewport_default=vp_default
        )
        rm_samples = select_samples(
            samples_all, at_filter, default_variant="reduced_motion", viewport_default=vp_default
        )
        norm_by_id = {_sample_identity(s): s for s in norm_samples}
        for s_rm in rm_samples:
            s_norm = norm_by_id.get(_sample_identity(s_rm))
            if s_norm is None:
                continue
            ok = time_.reduced_motion_not_blank(_load(s_norm), _load(s_rm), scene.star_count)
            results.append({"key": s_rm["key"], "value": ok})
        if not results:
            return None

    # 3. Reference-comparison metrics
    elif metric_id in {"ref.flip", "ref.lum_delta", "render.stripe_energy"}:
        selected = select_samples(
            samples_all, at_filter, default_variant="normal", viewport_default=vp_default
        )
        refs_map = manifest.get("refs", {})
        for s in selected:
            ref_file = s.get("ref_file") or refs_map.get(s["key"])
            if not ref_file:
                continue
            img_sub = _load(s)
            img_ref = load_image(resolve_path(ref_file, *base_dirs))
            if metric_id == "ref.flip":
                val = ref.ref_flip(img_sub, img_ref)
            elif metric_id == "ref.lum_delta":
                val = ref.ref_lum_delta(img_sub, img_ref)
            else:
                mask_ref = s.get("mask") or metric_cfg.get("mask")
                if mask_ref is None:
                    continue
                m = _resolve_mask(mask_ref, img_sub.shape[:2], base_dirs)
                val = render.stripe_energy(img_sub, img_ref, m)
            results.append({"key": s["key"], "value": val})
        if not results:
            return None

    # 4. Renovation-start comparison metrics
    elif metric_id in {"color.hue_shift", "scene.silhouette_iou", "mask.silhouette_delta", "render.flip_vs_start"}:
        if start_manifest is None:
            return None
        sub_samples = select_samples(
            samples_all, at_filter, default_variant="normal", viewport_default=vp_default
        )
        start_samples = select_samples(
            start_manifest.get("samples", []),
            at_filter,
            default_variant="normal",
            viewport_default=vp_default,
        )
        start_by_id = {_sample_identity(s): s for s in start_samples}
        start_by_key = {s["key"]: s for s in start_samples}
        for s in sub_samples:
            s0 = start_by_id.get(_sample_identity(s)) or start_by_key.get(s["key"])
            if s0 is None:
                continue
            img_sub = _load(s)
            img_start = _load_start(s0)
            if metric_id == "color.hue_shift":
                m = None
                if at_filter.metal_only:
                    m_ref = s.get("metal_mask") or metric_cfg.get("mask")
                    if m_ref is not None:
                        m = _resolve_mask(m_ref, img_sub.shape[:2], base_dirs)
                val = color.hue_shift(img_start, img_sub, mask=m)
            elif metric_id == "scene.silhouette_iou":
                val = scene.silhouette_iou(img_start, img_sub)
            elif metric_id == "mask.silhouette_delta":
                m = None
                m_ref = s.get("mask") or metric_cfg.get("mask")
                if m_ref is not None:
                    m = _resolve_mask(m_ref, img_start.shape[:2], start_dirs)
                val = mask.silhouette_delta(img_start, img_sub, mask=m)
            else:
                val = render.flip_vs_start(img_sub, img_start)
            results.append({"key": s["key"], "value": val})
        if not results:
            return None

    elif metric_id == "mask.element_ssim":
        sub_samples = select_samples(
            samples_all, at_filter, default_variant="normal", viewport_default=vp_default
        )
        start_by_id: dict[tuple[Any, ...], dict[str, Any]] = {}
        if start_manifest is not None:
            start_by_id = {
                _sample_identity(s): s for s in start_manifest.get("samples", [])
            }
        elem_scores: dict[str, float] = {}
        for s in sub_samples:
            elems = s.get("elements") or (s.get("detail") or {}).get("elements")
            if elems:
                pairs = []
                for el in elems:
                    if "start_crop" in el and "sub_crop" in el:
                        c0 = load_image(resolve_path(el["start_crop"], *start_dirs, *base_dirs))
                        c1 = load_image(resolve_path(el["sub_crop"], *base_dirs))
                    elif "start_bbox" in el and "sub_bbox" in el:
                        s0 = start_by_id.get(_sample_identity(s))
                        if s0 is None:
                            continue
                        c0 = mask.crop_bbox(_load_start(s0), el["start_bbox"])
                        c1 = mask.crop_bbox(_load(s), el["sub_bbox"])
                    else:
                        continue
                    el_val = mask.element_ssim_pair(c0, c1)
                    sel_name = el.get("selector", str(len(elem_scores)))
                    elem_scores[f"{s['key']}:{sel_name}"] = el_val
                    pairs.append((c0, c1))
                if pairs:
                    results.append({"key": s["key"], "value": mask.element_ssim(pairs)})
            elif start_manifest is not None:
                s0 = start_by_id.get(_sample_identity(s))
                if s0 is None:
                    continue
                bboxes0 = {e["selector"]: e["bbox"] for e in s0.get("element_bboxes", [])}
                bboxes1 = {e["selector"]: e["bbox"] for e in s.get("element_bboxes", [])}
                common = sorted(set(bboxes0) & set(bboxes1))
                if not common:
                    continue
                img0 = load_image(resolve_path(s0.get("full_file") or s0["file"], *start_dirs))
                img1 = load_image(resolve_path(s.get("full_file") or s["file"], *base_dirs))
                pairs = []
                for sel_name in common:
                    c0 = mask.crop_bbox(img0, bboxes0[sel_name])
                    c1 = mask.crop_bbox(img1, bboxes1[sel_name])
                    elem_scores[f"{s['key']}:{sel_name}"] = mask.element_ssim_pair(c0, c1)
                    pairs.append((c0, c1))
                results.append({"key": s["key"], "value": mask.element_ssim(pairs)})
        if not results:
            return None
        if elem_scores:
            detail["elements"] = elem_scores

    # 5. Single-frame metrics
    else:
        default_var = "resize_seq" if metric_id == "scene.star_roundness" else "normal"
        selected = select_samples(
            samples_all, at_filter, default_variant=default_var, viewport_default=vp_default
        )
        if not selected and metric_id == "shape.circularity":
            selected = select_samples(
                samples_all, at_filter, default_variant="normal", viewport_default=vp_default
            )
        if not selected:
            return None

        for s in selected:
            img = _load(s)
            seed_params = _get_params_for_seed(manifest, s.get("seed"))

            if metric_id == "color.palette_fidelity":
                pal = s.get("palette") or seed_params.get("palette")
                if not pal:
                    continue
                val: float | int | bool = color.palette_fidelity(img, pal)
            elif metric_id == "color.palette_coverage":
                pal = s.get("palette") or seed_params.get("palette")
                if not pal:
                    continue
                val = color.palette_coverage(img, pal)
            elif metric_id == "color.chroma_mean":
                m = None
                if at_filter.metal_only:
                    m_ref = s.get("metal_mask") or metric_cfg.get("mask")
                    if m_ref is not None:
                        m = _resolve_mask(m_ref, img.shape[:2], base_dirs)
                val = color.chroma_mean(img, mask=m)
            elif metric_id == "color.patch_delta":
                state = s.get("state") or {}
                patches = s.get("chart_patches") or state.get("chartPatches") or seed_params.get("chartPatches")
                ref_patches = (
                    s.get("chart_patches_ref")
                    or seed_params.get("chartPatchesRef")
                    or spec.get("chart_patches_ref")
                )
                if not patches or not ref_patches:
                    continue
                val = color.patch_delta(img, patches, ref_patches)
            elif metric_id == "lum.mean":
                val = lum.lum_mean(img)
            elif metric_id == "lum.highlight_frac":
                val = lum.highlight_frac(img)
            elif metric_id == "lum.floor":
                val = lum.lum_floor(img)
            elif metric_id == "render.banding":
                val = render.banding(img)
            elif metric_id == "scene.star_count":
                val = scene.star_count(img)
            elif metric_id == "scene.star_roundness":
                val = scene.star_roundness(img)
            elif metric_id == "scene.silhouette":
                val = scene.silhouette(img)
            elif metric_id == "shape.circularity":
                state = s.get("state") or {}
                mask_ref = s.get("mask_file") or s.get("mask")
                m = _resolve_mask(mask_ref, img.shape[:2], base_dirs) if mask_ref else None
                mask_color = s.get("focused_mask_color") or state.get("focusedMaskColor")
                center = s.get("focused_center") or state.get("focusedCenter")
                val = shape.circularity(img, mask=m, mask_color=mask_color, center=center)
            elif metric_id == "visual.congestion":
                val = visual.congestion(img)
            elif metric_id == "visual.edge_density":
                val = visual.edge_density(img)
            else:
                return None

            results.append({"key": s["key"], "value": val})

        if not results:
            return None

    raw_val = aggregate_values([r["value"] for r in results], agg=agg, score_spec=score_spec)
    detail.setdefault("agg", agg)
    detail.setdefault("count", len(results))
    return {
        "raw": raw_val,
        "samples": results,
        "detail": detail,
    }


def compute_metrics(
    manifest_path: str | Path,
    spec_path: str | Path | None = None,
    renovation_start_path: str | Path | None = None,
    requested_metrics: list[str] | None = None,
) -> dict[str, Any]:
    """Compute all implemented metrics specified by `spec_path` (or `requested_metrics`)."""
    m_path = Path(manifest_path)
    manifest = load_json(m_path)
    validate_manifest_variants(manifest)

    spec: dict[str, Any] = {}
    spec_dir: Path | None = None
    if spec_path is not None:
        s_path = Path(spec_path)
        spec = load_json(s_path)
        spec_dir = s_path.parent

    start_manifest: dict[str, Any] | None = None
    start_dir: Path | None = None
    if renovation_start_path is not None:
        st_path = Path(renovation_start_path)
        start_manifest = load_json(st_path)
        validate_manifest_variants(start_manifest)
        start_dir = st_path.parent

    spec_entries = extract_spec_metrics(spec) if spec else []
    spec_by_id = {e["id"]: e for e in spec_entries}

    if requested_metrics:
        target_ids = list(dict.fromkeys(requested_metrics))
    elif spec_entries:
        target_ids = [e["id"] for e in spec_entries]
    else:
        target_ids = sorted(IMPLEMENTED_METRICS)

    hidden_dir: Path | None = None
    if spec_dir is not None and spec.get("room"):
        cand_hidden = spec_dir.parent.parent / "hidden" / str(spec["room"])
        if cand_hidden.exists():
            hidden_dir = cand_hidden

    base_dirs = (m_path.parent, spec_dir, hidden_dir, Path.cwd())
    start_dirs = (start_dir, m_path.parent, spec_dir, hidden_dir, Path.cwd())

    output: dict[str, Any] = {}
    skipped: list[str] = []
    img_cache: dict[Path, Any] = {}

    for mid in target_ids:
        if mid not in IMPLEMENTED_METRICS:
            skipped.append(mid)
            continue
        cfg = spec_by_id.get(mid, {"id": mid})
        res = _compute_single_metric(
            mid, cfg, manifest, spec, start_manifest, base_dirs, start_dirs, img_cache=img_cache
        )
        if res is None:
            skipped.append(mid)
        else:
            output[mid] = res

    output["_skipped"] = skipped
    return output


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m molmetrics", description="MoL-Bench image/time-series metrics")
    sub = parser.add_subparsers(dest="command", required=True)

    comp = sub.add_parser("compute", help="Compute metrics from a capture manifest")
    comp.add_argument("--manifest", required=True, help="Path to capture manifest.json")
    comp.add_argument("--spec", required=False, default=None, help="Path to room spec.json")
    comp.add_argument("--out", required=False, default=None, help="Path to write output metrics.json")
    comp.add_argument(
        "--renovation-start",
        required=False,
        default=None,
        help="Path to start submission manifest.json for renovation comparisons",
    )
    flip = sub.add_parser("flip", help="Print mean FLIP between two PNG images")
    flip.add_argument("image_a")
    flip.add_argument("image_b")
    comp.add_argument(
        "--metric",
        action="append",
        dest="metrics",
        default=None,
        help="Compute specific metric id (repeatable)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "flip":
        from .flip import mean_flip

        print(mean_flip(load_image(args.image_a), load_image(args.image_b)))
        return 0
    if args.command == "compute":
        result = compute_metrics(
            manifest_path=args.manifest,
            spec_path=args.spec,
            renovation_start_path=args.renovation_start,
            requested_metrics=args.metrics,
        )
        if args.out:
            save_json(args.out, result)
        else:
            import json

            print(json.dumps(result, indent=2))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
