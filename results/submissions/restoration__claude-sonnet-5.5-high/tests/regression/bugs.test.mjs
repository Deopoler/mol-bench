import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = fs
  .readFileSync(path.join(root, "room", "src", "orrery.js"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

// Return the source of `function <name>(...) { ... }` (brace-balanced).
function body(name) {
  const m = new RegExp(String.raw`(?:async\s+)?function\s+${name}\s*\(`).exec(src);
  assert.ok(m, `function ${name} not found`);
  const open = src.indexOf("{", src.indexOf(")", m.index));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

test("B1: makeColor does not double-encode colors to sRGB (no fog / washed-out look)", () => {
  // new THREE.Color(hex) already yields linear working-space values; the renderer
  // applies the sRGB output encoding, so any convertLinearToSRGB here washes the scene out.
  assert.equal(/convertLinearToSRGB/.test(body("makeColor")), false);
});

test("B2: floor compass decal keeps polygonOffset and a sane camera near plane (no z-fighting)", () => {
  assert.equal(/decalMaterial\.polygonOffset\s*=\s*false/.test(src), false, "decal polygonOffset must not be disabled");
  assert.equal(/camera\.near\s*=\s*0?\.0\d*/.test(src), false, "camera.near must not be collapsed to a tiny value");
  const m = /new THREE\.PerspectiveCamera\(\s*[\d.]+\s*,\s*[^,]+,\s*([\d.]+)\s*,/.exec(src);
  assert.ok(m && Number(m[1]) >= 0.05, "camera near plane must be >= 0.05");
});

test("B7: unmount removes the Next Planet click listener and the resize listener", () => {
  const b = body("unmount");
  assert.match(b, /removeEventListener\(\s*["']click["']/);
  assert.match(b, /removeEventListener\(\s*["']resize["']/);
});

test("B5: orbit clock follows __benchHost.clock, not a fixed per-frame step", () => {
  const b = body("tick");
  assert.match(b, /host\.clock\.now\(\)/);
  assert.equal(/currentClockMs\s*\+\s*\w+|\+=|16\.6/.test(b), false, "no fixed per-frame increment");
});
