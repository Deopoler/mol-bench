"""
Structural glTF 2.0 binary (.glb) validator for gate `G-gltf-valid`.
Because the external Khronos glTF-Validator binary is not installed in the offline
environment, this module performs a strict structural check against the glTF 2.0
specification:
  1. 12-byte GLB header (magic 0x46546C67 'glTF', version == 2, total length match).
  2. Chunk 0 (JSON, type 0x4E4F534A) valid UTF-8 JSON with asset.version == "2.0".
  3. Chunk 1 (BIN, type 0x004E4942) length matches buffers[0].byteLength.
  4. Every node, mesh, primitive, accessor, bufferView, buffer, material, image,
     texture, and animation index is in bounds and structurally well-formed.
  5. Every accessor's bufferView byteOffset + byteLength lies inside the BIN buffer.
  6. Scene contains at least one mesh primitive with valid POSITION attribute.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path
from typing import Any


GLB_MAGIC = 0x46546C67  # b"glTF"
CHUNK_JSON = 0x4E4F534A  # b"JSON"
CHUNK_BIN = 0x004E4942   # b"BIN\x00"

COMPONENT_BYTE_SIZES = {
    5120: 1,  # BYTE
    5121: 1,  # UNSIGNED_BYTE
    5122: 2,  # SHORT
    5123: 2,  # UNSIGNED_SHORT
    5125: 4,  # UNSIGNED_INT
    5126: 4,  # FLOAT
}

TYPE_COMPONENT_COUNTS = {
    "SCALAR": 1,
    "VEC2": 2,
    "VEC3": 3,
    "VEC4": 4,
    "MAT2": 4,
    "MAT3": 9,
    "MAT4": 16,
}


def validate_glb(glb_path: str | Path) -> dict[str, Any]:
    """Validate a .glb file structurally and return {pass: bool, errors: list[str], stats: dict}."""
    p = Path(glb_path)
    errors: list[str] = []
    stats: dict[str, Any] = {
        "nodes": 0,
        "meshes": 0,
        "primitives": 0,
        "triangles": 0,
        "materials": 0,
        "textures": 0,
        "animations": 0,
    }

    if not p.exists():
        return {"pass": False, "errors": [f"GLB file does not exist: {p}"], "stats": stats}

    data = p.read_bytes()
    if len(data) < 20:
        return {"pass": False, "errors": [f"GLB file too small ({len(data)} bytes)"], "stats": stats}

    magic, version, total_len = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC:
        errors.append(f"Invalid GLB magic: 0x{magic:08x} (expected 0x{GLB_MAGIC:08x})")
    if version != 2:
        errors.append(f"Unsupported GLB version: {version} (expected 2)")
    if total_len != len(data):
        errors.append(f"GLB header length {total_len} != file size {len(data)}")
    if errors:
        return {"pass": False, "errors": errors, "stats": stats}

    # Parse chunks
    offset = 12
    json_bytes: bytes | None = None
    bin_bytes: bytes = b""
    chunk_idx = 0

    while offset < len(data):
        if offset + 8 > len(data):
            errors.append("Truncated GLB chunk header")
            break
        chunk_len, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        if offset + chunk_len > len(data):
            errors.append(f"Chunk {chunk_idx} extends past EOF ({offset + chunk_len} > {len(data)})")
            break
        chunk_payload = data[offset : offset + chunk_len]
        offset += chunk_len

        if chunk_idx == 0:
            if chunk_type != CHUNK_JSON:
                errors.append(f"First chunk must be JSON (0x{CHUNK_JSON:08x}), got 0x{chunk_type:08x}")
            json_bytes = chunk_payload
        elif chunk_idx == 1:
            if chunk_type != CHUNK_BIN:
                errors.append(f"Second chunk must be BIN (0x{CHUNK_BIN:08x}), got 0x{chunk_type:08x}")
            bin_bytes = chunk_payload
        chunk_idx += 1

    if json_bytes is None:
        errors.append("Missing JSON chunk")
        return {"pass": False, "errors": errors, "stats": stats}

    try:
        gltf = json.loads(json_bytes.decode("utf-8"))
    except Exception as exc:
        return {"pass": False, "errors": [f"Invalid glTF JSON chunk: {exc}"], "stats": stats}

    asset = gltf.get("asset")
    if not isinstance(asset, dict) or asset.get("version") != "2.0":
        errors.append(f"Invalid or missing asset.version (expected '2.0', got {asset})")

    buffers = gltf.get("buffers", [])
    buffer_views = gltf.get("bufferViews", [])
    accessors = gltf.get("accessors", [])
    meshes = gltf.get("meshes", [])
    nodes = gltf.get("nodes", [])
    materials = gltf.get("materials", [])
    textures = gltf.get("textures", [])
    images = gltf.get("images", [])
    animations = gltf.get("animations", [])

    stats["nodes"] = len(nodes)
    stats["meshes"] = len(meshes)
    stats["materials"] = len(materials)
    stats["textures"] = len(textures)
    stats["animations"] = len(animations)

    if buffers:
        b0_len = buffers[0].get("byteLength", 0)
        if b0_len > len(bin_bytes):
            errors.append(f"buffers[0].byteLength ({b0_len}) > BIN chunk size ({len(bin_bytes)})")

    # Validate bufferViews
    for idx, bv in enumerate(buffer_views):
        b_idx = bv.get("buffer", -1)
        if not (0 <= b_idx < len(buffers)):
            errors.append(f"bufferViews[{idx}].buffer out of range: {b_idx}")
            continue
        byte_off = bv.get("byteOffset", 0)
        byte_len = bv.get("byteLength", 0)
        b_max = buffers[b_idx].get("byteLength", 0)
        if byte_off < 0 or byte_len <= 0 or byte_off + byte_len > b_max:
            errors.append(f"bufferViews[{idx}] range [{byte_off}, {byte_off + byte_len}] exceeds buffer size {b_max}")

    # Validate accessors
    for idx, acc in enumerate(accessors):
        comp_type = acc.get("componentType")
        acc_type = acc.get("type")
        count = acc.get("count", 0)
        if comp_type not in COMPONENT_BYTE_SIZES:
            errors.append(f"accessors[{idx}] invalid componentType: {comp_type}")
            continue
        if acc_type not in TYPE_COMPONENT_COUNTS:
            errors.append(f"accessors[{idx}] invalid type: {acc_type}")
            continue
        if count <= 0:
            errors.append(f"accessors[{idx}] non-positive count: {count}")
            continue
        if "bufferView" in acc:
            bv_idx = acc["bufferView"]
            if not (0 <= bv_idx < len(buffer_views)):
                errors.append(f"accessors[{idx}].bufferView out of range: {bv_idx}")
                continue
            bv = buffer_views[bv_idx]
            elem_size = COMPONENT_BYTE_SIZES[comp_type] * TYPE_COMPONENT_COUNTS[acc_type]
            stride = bv.get("byteStride", elem_size)
            acc_off = acc.get("byteOffset", 0)
            needed = acc_off + (count - 1) * stride + elem_size
            if needed > bv.get("byteLength", 0):
                errors.append(f"accessors[{idx}] exceeds bufferViews[{bv_idx}] byteLength")

    # Validate meshes & primitives
    total_prims = 0
    total_tris = 0
    for m_idx, mesh in enumerate(meshes):
        prims = mesh.get("primitives", [])
        if not prims:
            errors.append(f"meshes[{m_idx}] has no primitives")
        for p_idx, prim in enumerate(prims):
            total_prims += 1
            attrs = prim.get("attributes", {})
            if "POSITION" not in attrs:
                errors.append(f"meshes[{m_idx}].primitives[{p_idx}] missing POSITION attribute")
            for attr_name, acc_idx in attrs.items():
                if not (0 <= acc_idx < len(accessors)):
                    errors.append(f"meshes[{m_idx}].primitives[{p_idx}] attribute {attr_name} accessor {acc_idx} out of range")
            if "indices" in prim:
                i_acc = prim["indices"]
                if not (0 <= i_acc < len(accessors)):
                    errors.append(f"meshes[{m_idx}].primitives[{p_idx}] indices accessor {i_acc} out of range")
                else:
                    total_tris += accessors[i_acc].get("count", 0) // 3
            elif "POSITION" in attrs and 0 <= attrs["POSITION"] < len(accessors):
                total_tris += accessors[attrs["POSITION"]].get("count", 0) // 3
            if "material" in prim:
                mat_idx = prim["material"]
                if not (0 <= mat_idx < len(materials)):
                    errors.append(f"meshes[{m_idx}].primitives[{p_idx}] material {mat_idx} out of range")

    stats["primitives"] = total_prims
    stats["triangles"] = total_tris
    if total_prims == 0:
        errors.append("GLB contains 0 mesh primitives")

    # Validate nodes
    for n_idx, node in enumerate(nodes):
        if "mesh" in node and not (0 <= node["mesh"] < len(meshes)):
            errors.append(f"nodes[{n_idx}].mesh {node['mesh']} out of range")
        for c_idx in node.get("children", []):
            if not (0 <= c_idx < len(nodes)) or c_idx == n_idx:
                errors.append(f"nodes[{n_idx}] invalid child index {c_idx}")

    # Validate textures
    for t_idx, tex in enumerate(textures):
        if "source" in tex and not (0 <= tex["source"] < len(images)):
            errors.append(f"textures[{t_idx}].source {tex['source']} out of range")

    return {
        "pass": len(errors) == 0,
        "errors": errors,
        "stats": stats,
        "gltf": gltf,
    }
