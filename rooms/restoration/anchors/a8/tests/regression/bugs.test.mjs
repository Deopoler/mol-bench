import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.MOL_TARGET_DIR ? path.resolve(process.env.MOL_TARGET_DIR) : path.resolve(__dirname, "..", "..");
const ORRERY_SRC = fs.readFileSync(path.join(ROOT, "room", "src", "orrery.js"), "utf8");

test("B1: makeColor does not double-encode linear colors to sRGB", () => {
  const fnMatch = ORRERY_SRC.match(/function\s+makeColor\s*\([^)]*\)\s*\{[\s\S]*?\}/);
  assert.ok(fnMatch, "makeColor function must exist");
  assert.equal(/convertLinearToSRGB\s*\(/.test(fnMatch[0]), false, "makeColor must not double-encode to sRGB");
});

test("B2: floor decal uses elevated Y offset and polygonOffset with healthy near clip plane", () => {
  assert.equal(/camera\.near\s*=\s*0\.0002/.test(ORRERY_SRC), false, "camera.near must not be degraded to 0.0002");
  assert.equal(/decalMaterial\.polygonOffset\s*=\s*false/.test(ORRERY_SRC), false, "decalMaterial.polygonOffset must remain enabled");
  assert.ok(/decalMesh\.position\.set\(\s*0\.55\s*,\s*0\.012/.test(ORRERY_SRC), "decalMesh must be offset above floor");
});

test("B3: unmount disposes allocated geometries, materials, textures, and caches", () => {
  const unmountSection = ORRERY_SRC.split("async function unmount")[1]?.split("const readyPromise")[0] || "";
  assert.ok(unmountSection.length > 0, "unmount function must exist");
  assert.ok(/allocatedGeometries[\s\S]*?\.dispose\(\)/.test(unmountSection), "geometries must be disposed in unmount");
  assert.ok(/allocatedMaterials[\s\S]*?\.dispose\(\)/.test(unmountSection), "materials must be disposed in unmount");
  assert.ok(/allocatedTextures[\s\S]*?\.dispose\(\)/.test(unmountSection), "textures must be disposed in unmount");
});

test("B4: handleResize unconditionally updates renderer size and camera aspect ratio", () => {
  const resizeSection = ORRERY_SRC.split("function handleResize")[1]?.split("function projectWorldToPixel")[0] || "";
  assert.ok(resizeSection.length > 0, "handleResize function must exist");
  assert.ok(/renderer\.setSize\(/.test(resizeSection), "handleResize must call renderer.setSize");
  assert.equal(/if\s*\(\s*width\s*<\s*height\s*\)/.test(resizeSection), false, "handleResize must not restrict aspect update to portrait only");
});
