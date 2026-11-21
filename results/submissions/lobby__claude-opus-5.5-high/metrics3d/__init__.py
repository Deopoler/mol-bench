"""3D metrics package (`metrics3d`) executed inside Blender (`bpy`) and post-render."""

from .bevel import compute_bevel_ratio
from .gltf_check import validate_glb

__all__ = ["compute_bevel_ratio", "validate_glb"]
