"""Ensure the `metrics` root directory is on sys.path for pytest."""

from __future__ import annotations

import sys
from pathlib import Path

METRICS_ROOT = str(Path(__file__).resolve().parents[1])
if METRICS_ROOT not in sys.path:
    sys.path.insert(0, METRICS_ROOT)
