"""Deterministic image, mask, and JSON I/O helpers."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image


def load_json(path: str | Path) -> Any:
    """Load a UTF-8 JSON file."""
    with Path(path).open("r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: str | Path, data: Any) -> None:
    """Write data to a UTF-8 JSON file deterministically."""
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=False)
        f.write("\n")


def resolve_path(ref_path: str | Path, *base_dirs: str | Path | None) -> Path:
    """Resolve a relative path against candidate base directories (or return if absolute)."""
    p = Path(ref_path)
    if p.is_absolute():
        return p
    for base in base_dirs:
        if base is None:
            continue
        candidate = Path(base) / p
        if candidate.exists():
            return candidate
    for base in base_dirs:
        if base is not None:
            return Path(base) / p
    return p


def load_image(path: str | Path) -> np.ndarray:
    """Load an 8-bit sRGB image as an (H, W, 3) uint8 numpy array."""
    with Image.open(path) as img:
        rgb = img.convert("RGB")
        return np.asarray(rgb, dtype=np.uint8)


def load_mask(path: str | Path, target_shape: tuple[int, int] | None = None) -> np.ndarray:
    """Load a mask PNG as an (H, W) bool array, optionally resizing nearest-neighbor."""
    with Image.open(path) as img:
        gray = img.convert("L")
        if target_shape is not None and (gray.height, gray.width) != target_shape:
            gray = gray.resize((target_shape[1], target_shape[0]), Image.Resampling.NEAREST)
        arr = np.asarray(gray, dtype=np.uint8)
        return arr > 127


def load_sequence_frames(
    seq: dict[str, Any],
    base_dirs: tuple[Path | None, ...] = (),
) -> list[np.ndarray]:
    """Load ordered frames from a manifest sequence entry (`files` list or `dir`)."""
    if "files" in seq and seq["files"]:
        return [load_image(resolve_path(f, *base_dirs)) for f in seq["files"]]
    if "dir" in seq:
        seq_dir = resolve_path(seq["dir"], *base_dirs)
        pngs = sorted(seq_dir.glob("*.png"))
        return [load_image(p) for p in pngs]
    raise ValueError(f"Sequence entry missing 'files' or 'dir': {seq.get('key', '<unknown>')}")
