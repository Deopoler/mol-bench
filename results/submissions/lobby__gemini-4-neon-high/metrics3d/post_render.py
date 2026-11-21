"""
Post-render 3D metric computation (`metrics3d/post_render.py`).
Runs in `.venv/Scripts/python` using `numpy`, `scipy`, `skimage`, `PIL`, and `molmetrics`
over the studio renders produced by `harness/blender/render_submission.py`.
Computes:
  - shape.iou_public (front, side, top)
  - shape.iou_hidden (12 hidden views, when hidden refs available)
  - shape.iou_vs_start (12 hidden views vs start+AT-R1 reference, for Renovation r1)
  - vq.shading_artifacts (from world-space normal pass)
  - vq.exposure (mean OKLab L over object pixels in 8 turntable renders)
  - vq.highlight_metal (fraction of metal pixels with OKLab L > 0.85 in 8 turntable renders)
  - vq.detail_scale (1024px vs 128px upscaled silhouette perimeter ratio)
  - render.aliasing (turntable DPR1 vs DPR2 pairs)
  - Renovation r1 turntable comparisons: render.flip_vs_start, color.chroma_mean ({before, after}), color.hue_shift
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image
from scipy.ndimage import binary_erosion
from skimage.measure import find_contours

THIS_DIR = Path(__file__).resolve().parent
REPO_ROOT = THIS_DIR.parent
METRICS_PKG_DIR = REPO_ROOT / "metrics"
if str(METRICS_PKG_DIR) not in sys.path:
    sys.path.insert(0, str(METRICS_PKG_DIR))

from molmetrics import color as mol_color
from molmetrics import render as mol_render
from molmetrics.io import load_image, load_mask


def compute_mask_iou(mask_a: np.ndarray, mask_b: np.ndarray) -> float:
    a = np.asarray(mask_a, dtype=bool)
    b = np.asarray(mask_b, dtype=bool)
    inter = int(np.sum(a & b))
    union = int(np.sum(a | b))
    if union == 0:
        return 0.0
    return float(inter / union)


def contour_perimeter(mask: np.ndarray) -> float:
    padded = np.pad(mask.astype(np.float64), pad_width=1, mode="constant", constant_values=0.0)
    contours = find_contours(padded, level=0.5)
    total = 0.0
    for c in contours:
        diffs = np.diff(c, axis=0)
        total += float(np.sum(np.hypot(diffs[:, 0], diffs[:, 1])))
    return total


def compute_detail_scale_single(mask_1024: np.ndarray) -> float:
    """Perimeter at 1024 px divided by perimeter at 128 px (upscaled by 8x)."""
    p_1024 = contour_perimeter(mask_1024)
    if p_1024 <= 1e-6:
        return 0.0
    # Box-downsample 1024x1024 boolean mask by 8x to 128x128
    m_f = mask_1024[:1024, :1024].astype(np.float64)
    m_128 = m_f.reshape(128, 8, 128, 8).mean(axis=(1, 3)) >= 0.5
    p_128_upscaled = contour_perimeter(m_128) * 8.0
    if p_128_upscaled <= 1e-6:
        return 1.0
    return float(p_1024 / p_128_upscaled)


def compute_shading_artifacts_single(normal_img: np.ndarray, obj_mask: np.ndarray) -> float:
    """Detect normal discontinuities (> 20 deg between neighboring pixels) inside eroded object mask
    that do not coincide with sharp structural edges (> 58 deg) or silhouette edges.
    """
    h, w = normal_img.shape[:2]
    if obj_mask.shape[:2] != (h, w):
        pil_m = Image.fromarray((obj_mask.astype(np.uint8) * 255)).resize((w, h), Image.Resampling.NEAREST)
        mask = np.asarray(pil_m, dtype=np.uint8) > 127
    else:
        mask = np.asarray(obj_mask, dtype=bool)

    # Erode by 2 px to exclude geometric silhouette boundary pixels
    interior = binary_erosion(mask, structure=np.ones((5, 5), dtype=bool))
    n_obj = int(np.sum(interior))
    if n_obj < 32:
        return 0.0

    # Decode unit normals from [0, 255] RGB
    n_raw = (normal_img.astype(np.float64) / 127.5) - 1.0
    norm = np.linalg.norm(n_raw, axis=2, keepdims=True)
    n_unit = np.where(norm > 1e-4, n_raw / np.maximum(norm, 1e-4), 0.0)

    # Horizontal & vertical neighbor angles (degrees)
    dot_x = np.clip(np.sum(n_unit[:, :-1] * n_unit[:, 1:], axis=2), -1.0, 1.0)
    ang_x = np.rad2deg(np.arccos(dot_x))
    valid_x = interior[:, :-1] & interior[:, 1:]

    dot_y = np.clip(np.sum(n_unit[:-1, :] * n_unit[1:, :], axis=2), -1.0, 1.0)
    ang_y = np.rad2deg(np.arccos(dot_y))
    valid_y = interior[:-1, :] & interior[1:, :]

    # Second-difference check along X and Y: smooth curved surfaces (like a torus) have steady normal steps,
    # whereas shading artifacts (pinched normals, bad decimation triangles, faceting) have abrupt second differences.
    jump_x = np.zeros((h, w), dtype=bool)
    jump_y = np.zeros((h, w), dtype=bool)

    # Discontinuity between 20 deg and 58 deg (sharp geometric edges > 58 deg are excluded per METRICS.md)
    disc_x = valid_x & (ang_x > 20.0) & (ang_x <= 58.0)
    disc_y = valid_y & (ang_y > 20.0) & (ang_y <= 58.0)

    jump_x[:, :-1] |= disc_x
    jump_y[:-1, :] |= disc_y

    artifacts = (jump_x | jump_y) & interior
    return float(np.sum(artifacts) / n_obj)


def evaluate_post_render(
    work_dir: Path,
    blueprint_dir: Path,
    hidden_refs_dir: Path | None = None,
    start_work_dir: Path | None = None,
    r1_start_hidden_refs_dir: Path | None = None,
) -> dict[str, Any]:
    manifest = json.loads((work_dir / "manifest.json").read_text(encoding="utf-8"))
    blender_eval = json.loads((work_dir / "blender_eval.json").read_text(encoding="utf-8"))
    metrics: dict[str, Any] = dict(blender_eval.get("metrics", {}))

    # 1. shape.iou_public (front, side, top)
    ortho_views = manifest.get("ortho_views", {})
    public_pairs = [
        ("front", "front_ortho", "front.png"),
        ("side", "side_ortho", "side.png"),
        ("top", "top_ortho", "top.png"),
    ]
    pub_samples: list[dict[str, Any]] = []
    for short_name, view_key, bp_png in public_pairs:
        sub_rel = ortho_views.get(view_key)
        if not sub_rel or not (work_dir / sub_rel).exists():
            continue
        sub_mask = load_mask(work_dir / sub_rel)
        if hidden_refs_dir and (hidden_refs_dir / f"{view_key}.png").exists():
            ref_mask = load_mask(hidden_refs_dir / f"{view_key}.png", target_shape=sub_mask.shape)
        elif (blueprint_dir / bp_png).exists():
            ref_mask = load_mask(blueprint_dir / bp_png, target_shape=sub_mask.shape).copy()
            # Mask out bottom-left scale bar region (rows >= 1900, cols <= 550) when using blueprint PNG fallback
            h_m, w_m = ref_mask.shape
            y_cut = int(h_m * (1900.0 / 2048.0))
            x_cut = int(w_m * (550.0 / 2048.0))
            ref_mask[y_cut:, :x_cut] = False
            sub_mask = sub_mask.copy()
            sub_mask[y_cut:, :x_cut] = False
        else:
            continue

        iou_val = compute_mask_iou(sub_mask, ref_mask)
        pub_samples.append({"key": short_name, "value": round(iou_val, 5)})

    if pub_samples:
        worst_pub = min(s["value"] for s in pub_samples)
        metrics["shape.iou_public"] = {"raw": round(worst_pub, 5), "samples": pub_samples}

    # 2. shape.iou_hidden (12 hidden views)
    hidden_views = manifest.get("hidden_views", {})
    if hidden_refs_dir and hidden_views:
        hid_samples: list[dict[str, Any]] = []
        for idx in range(12):
            vkey = f"hidden_{idx:02d}"
            sub_rel = hidden_views.get(vkey)
            ref_p = hidden_refs_dir / f"{vkey}.png"
            if sub_rel and (work_dir / sub_rel).exists() and ref_p.exists():
                sub_m = load_mask(work_dir / sub_rel)
                ref_m = load_mask(ref_p, target_shape=sub_m.shape)
                hid_samples.append({"key": vkey, "value": round(compute_mask_iou(sub_m, ref_m), 5)})
        if hid_samples:
            med_hid = float(np.median([s["value"] for s in hid_samples]))
            metrics["shape.iou_hidden"] = {"raw": round(med_hid, 5), "samples": hid_samples}

    # 3. shape.iou_vs_start (Renovation r1: 12 hidden views compared against start with AT-R1 handle change)
    if r1_start_hidden_refs_dir and hidden_views:
        vs_start_samples: list[dict[str, Any]] = []
        for idx in range(12):
            vkey = f"hidden_{idx:02d}"
            sub_rel = hidden_views.get(vkey)
            ref_p = r1_start_hidden_refs_dir / f"r1_start_{vkey}.png"
            if not ref_p.exists() and hidden_refs_dir:
                ref_p = hidden_refs_dir / f"{vkey}.png"
            if sub_rel and (work_dir / sub_rel).exists() and ref_p.exists():
                sub_m = load_mask(work_dir / sub_rel)
                ref_m = load_mask(ref_p, target_shape=sub_m.shape)
                vs_start_samples.append({"key": vkey, "value": round(compute_mask_iou(sub_m, ref_m), 5)})
        if vs_start_samples:
            med_vs = float(np.median([s["value"] for s in vs_start_samples]))
            metrics["shape.iou_vs_start"] = {"raw": round(med_vs, 5), "samples": vs_start_samples}

    # 4. Turntable visual quality metrics: vq.exposure, vq.highlight_metal, vq.detail_scale,
    #    vq.shading_artifacts, render.aliasing
    samples = manifest.get("samples", [])
    exposures: list[float] = []
    highlights: list[float] = []
    detail_scales: list[float] = []
    shading_arts: list[float] = []
    aliasing_samples: list[dict[str, Any]] = []
    sub_chromas: list[float] = []

    for s in samples:
        beauty_path = work_dir / s["file"]
        dpr1_path = work_dir / s["dpr1_file"]
        obj_mask_path = work_dir / s["object_mask"]
        metal_mask_path = work_dir / s["metal_mask"]
        normal_path = work_dir / s["normal_pass"]

        if not beauty_path.exists():
            continue

        img_512 = load_image(beauty_path)
        l_map = mol_color.srgb_to_oklab_l(img_512)

        if obj_mask_path.exists():
            mask_1024 = load_mask(obj_mask_path)
            detail_scales.append(compute_detail_scale_single(mask_1024))
            mask_512 = load_mask(obj_mask_path, target_shape=img_512.shape[:2])
        else:
            mask_512 = l_map > 0.05

        if np.any(mask_512):
            exposures.append(float(np.mean(l_map[mask_512])))
        else:
            exposures.append(0.0)

        if metal_mask_path.exists():
            metal_512 = load_mask(metal_mask_path, target_shape=img_512.shape[:2])
        else:
            metal_512 = mask_512

        if np.any(metal_512):
            highlights.append(float(np.mean(l_map[metal_512] > 0.85)))
            sub_chromas.append(mol_color.chroma_mean(img_512, mask=metal_512))
        else:
            highlights.append(0.0)

        if normal_path.exists():
            norm_img = load_image(normal_path)
            shading_arts.append(compute_shading_artifacts_single(norm_img, mask_512))

        if dpr1_path.exists():
            img_256 = load_image(dpr1_path)
            al_val = mol_render.aliasing(img_256, img_512)
            aliasing_samples.append({"key": s["key"], "value": round(float(al_val), 5)})

    if exposures:
        metrics["vq.exposure"] = round(float(np.mean(exposures)), 5)
    if highlights:
        metrics["vq.highlight_metal"] = round(float(np.mean(highlights)), 5)
    if detail_scales:
        metrics["vq.detail_scale"] = round(float(np.mean(detail_scales)), 5)
    if shading_arts:
        metrics["vq.shading_artifacts"] = round(float(np.mean(shading_arts)), 5)
    if aliasing_samples:
        med_al = float(np.median([x["value"] for x in aliasing_samples]))
        metrics["render.aliasing"] = {"raw": round(med_al, 5), "samples": aliasing_samples}

    # 5. Renovation r1 turntable comparisons against start_work_dir
    if start_work_dir and (start_work_dir / "manifest.json").exists():
        start_manifest = json.loads((start_work_dir / "manifest.json").read_text(encoding="utf-8"))
        start_by_key = {s["key"]: s for s in start_manifest.get("samples", [])}

        flip_samples: list[dict[str, Any]] = []
        hue_samples: list[dict[str, Any]] = []
        start_chromas: list[float] = []

        for s in samples:
            s0 = start_by_key.get(s["key"])
            if s0 is None:
                continue
            p_sub = work_dir / s["file"]
            p_start = start_work_dir / s0["file"]
            if not p_sub.exists() or not p_start.exists():
                continue
            img_sub = load_image(p_sub)
            img_start = load_image(p_start)

            f_val = mol_render.flip_vs_start(img_sub, img_start)
            flip_samples.append({"key": s["key"], "value": round(float(f_val), 5)})

            m_sub = load_mask(work_dir / s["metal_mask"], target_shape=img_sub.shape[:2]) if (work_dir / s["metal_mask"]).exists() else None
            m_start = load_mask(start_work_dir / s0["metal_mask"], target_shape=img_start.shape[:2]) if (start_work_dir / s0["metal_mask"]).exists() else None

            h_val = mol_color.hue_shift(img_start, img_sub, mask=m_sub)
            hue_samples.append({"key": s["key"], "value": round(float(h_val), 5)})

            if m_start is not None and np.any(m_start):
                start_chromas.append(mol_color.chroma_mean(img_start, mask=m_start))

        if flip_samples:
            metrics["render.flip_vs_start"] = {
                "raw": round(float(np.median([x["value"] for x in flip_samples])), 5),
                "samples": flip_samples,
            }
        if hue_samples:
            metrics["color.hue_shift"] = {
                "raw": round(float(np.median([x["value"] for x in hue_samples])), 5),
                "samples": hue_samples,
            }
        if start_chromas and sub_chromas:
            metrics["color.chroma_mean"] = {
                "before": round(float(np.median(start_chromas)), 5),
                "after": round(float(np.median(sub_chromas)), 5),
            }
    elif sub_chromas:
        metrics["color.chroma_mean"] = round(float(np.median(sub_chromas)), 5)

    out_payload = {
        "gates": blender_eval.get("gates", {}),
        "metrics": metrics,
    }
    (work_dir / "metrics3d.json").write_text(json.dumps(out_payload, indent=2) + "\n", encoding="utf-8")
    return out_payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Compute post-render 3D metrics")
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--blueprint", required=True)
    parser.add_argument("--hidden-refs", default=None)
    parser.add_argument("--start-work-dir", default=None)
    parser.add_argument("--r1-start-hidden-refs", default=None)
    args = parser.parse_args()

    evaluate_post_render(
        work_dir=Path(args.work_dir).resolve(),
        blueprint_dir=Path(args.blueprint).resolve(),
        hidden_refs_dir=Path(args.hidden_refs).resolve() if args.hidden_refs else None,
        start_work_dir=Path(args.start_work_dir).resolve() if args.start_work_dir else None,
        r1_start_hidden_refs_dir=Path(args.r1_start_hidden_refs).resolve() if args.r1_start_hidden_refs else None,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
