import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { patchHtml, generateParams, buildGallery } from "../src/gallery.mjs";

test("patchHtml injects shim script before the first script tag", () => {
  const input = `<!doctype html><html><head><title>Test</title><script src="./app.js"></script></head><body></body></html>`;
  const patched = patchHtml(input, "../../shim/bench-host.js");

  assert.ok(patched.includes('<script src="../../shim/bench-host.js"></script>'));
  const shimIdx = patched.indexOf('<script src="../../shim/bench-host.js"></script>');
  const appIdx = patched.indexOf('<script src="./app.js"></script>');
  assert.ok(shimIdx !== -1 && appIdx !== -1);
  assert.ok(shimIdx < appIdx, "shim script must appear before the original script tag");
});

test("patchHtml is idempotent and does not inject duplicate tags", () => {
  const input = `<!doctype html><html><head><script src="./main.js" type="module"></script></head></html>`;
  const once = patchHtml(input, "../../shim/bench-host.js");
  const twice = patchHtml(once, "../../shim/bench-host.js");

  assert.equal(once, twice, "running patchHtml twice must produce the exact same HTML");

  const count = (once.match(/bench-host\.js/g) || []).length;
  assert.equal(count, 1, "bench-host.js must only be injected once");
});

test("patchHtml handles HTML without script tags gracefully", () => {
  const noScriptHead = `<!doctype html><html><head><title>No Scripts</title></head><body><h1>Hello</h1></body></html>`;
  const patchedHead = patchHtml(noScriptHead, "../../shim/bench-host.js");
  assert.ok(patchedHead.includes('<script src="../../shim/bench-host.js"></script>'));
  assert.ok(patchedHead.indexOf('<script src="../../shim/bench-host.js"></script>') < patchedHead.indexOf('</head>'));

  const noHead = `<!doctype html><html><body><h1>Hello</h1></body></html>`;
  const patchedBody = patchHtml(noHead, "../../shim/bench-host.js");
  assert.ok(patchedBody.includes('<script src="../../shim/bench-host.js"></script>'));
});

test("patchHtml supports custom relative shim paths", () => {
  const input = `<html><head><script src="x.js"></script></head></html>`;
  const custom = "../../../../shim/bench-host.js";
  const patched = patchHtml(input, custom);

  assert.ok(patched.includes(`<script src="${custom}"></script>`));
  assert.ok(patched.indexOf(custom) < patched.indexOf("x.js"));
});

test("generateParams produces valid deterministic params for lobby", async () => {
  const params1 = await generateParams("lobby", 1);
  assert.ok(params1 && typeof params1 === "object");
  assert.ok(Array.isArray(params1.rooms), "lobby params must contain rooms array");
  assert.ok(params1.rooms.length > 0, "lobby rooms array must not be empty");

  const params1Again = await generateParams("lobby", 1);
  assert.deepEqual(params1, params1Again, "generateParams must be deterministic for identical seeds");

  const params2 = await generateParams("lobby", 2);
  assert.notDeepEqual(params1, params2, "different seeds must produce different room params");
});

test("generateParams produces deterministic params for atelier and restoration", async () => {
  const atelierParams = await generateParams("atelier", 1);
  assert.equal(atelierParams.seed, 1);
  assert.ok(atelierParams.token !== undefined);

  const restoParams = await generateParams("restoration", 1);
  assert.equal(restoParams.seed, 1);
  assert.ok(Array.isArray(restoParams.orbitPhasesDeg));
  assert.equal(restoParams.orbitPhasesDeg.length, 7);
  assert.ok(restoParams.cameraPath && restoParams.cameraPath.basePosition);
});

test("buildGallery builds complete gallery structure into target directory", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mol-gallery-test-"));
  try {
    const res = await buildGallery({ siteDir: tempDir });
    assert.ok(res && res.runsCount > 0, "buildGallery must process runs");

    assert.ok(fs.existsSync(path.join(tempDir, "index.html")), "index.html must exist");
    assert.ok(fs.existsSync(path.join(tempDir, "shim", "bench-host.js")), "bench-host.js must exist");
    assert.ok(fs.existsSync(path.join(tempDir, "params", "lobby.json")), "params/lobby.json must exist");
    assert.ok(fs.existsSync(path.join(tempDir, "params", "atelier.json")), "params/atelier.json must exist");
    assert.ok(fs.existsSync(path.join(tempDir, "params", "restoration.json")), "params/restoration.json must exist");
    assert.ok(fs.existsSync(path.join(tempDir, "vendor", "three.module.js")), "vendor/three.module.js must exist");
    assert.ok(fs.existsSync(path.join(tempDir, "vendor", "GLTFLoader.js")), "vendor/GLTFLoader.js must exist");
    assert.ok(fs.existsSync(path.join(tempDir, "vendor", "OrbitControls.js")), "vendor/OrbitControls.js must exist");

    const indexContent = fs.readFileSync(path.join(tempDir, "index.html"), "utf8");
    assert.ok(indexContent.includes("MoL-Bench Results Gallery"));
    assert.ok(indexContent.includes("runs/"));
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      //
    }
  }
});
