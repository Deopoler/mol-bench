import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { gradeSubmission, generatePreviewContactSheets } from "../src/cli.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI_PATH = path.join(REPO_ROOT, "harness", "src", "cli.mjs");
const MOCK_AURORA = path.join(__dirname, "data", "mock-aurora");

test("CLI grade aurora rooms/aurora --no-capture --no-python --lenient prints valid JSON", () => {
  const stdout = execFileSync(
    process.execPath,
    [CLI_PATH, "grade", "aurora", "rooms/aurora", "--no-capture", "--no-python", "--lenient"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  const res = JSON.parse(stdout);
  assert.equal(res.room, "aurora");
  assert.equal(res.track, "build");
  assert.equal(res.seeds, "public");
  assert.equal(res.gates["G-report"].pass, false);
  assert.equal(res.gates["G-load"].pass, null);
  assert.equal(res.axes.craft, null);
  assert.equal(res.axes.visual_quality, null);
  assert.equal(res.axes.reliability, 0);
  assert.equal(res.composite, null);
});

test("gradeSubmission on mock-aurora with valid report.json computes reliability = 10", async () => {
  const res = await gradeSubmission({
    room: "aurora",
    submissionDir: MOCK_AURORA,
    noCapture: true,
    noPython: true,
    repoRoot: REPO_ROOT
  });
  assert.equal(res.gates["G-report"].pass, true);
  assert.equal(res.axes.reliability, 10);
});

test("CLI selfcheck reads .bench-room and writes selfcheck.json", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mol-selfcheck-"));
  try {
    fs.cpSync(MOCK_AURORA, tmpDir, { recursive: true });
    const stdout = execFileSync(
      process.execPath,
      [CLI_PATH, "selfcheck", "--dir", tmpDir, "--no-capture", "--no-python"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    assert.match(stdout, /MoL-Bench selfcheck: aurora/);
    const outFile = path.join(tmpDir, "selfcheck.json");
    assert.equal(fs.existsSync(outFile), true);
    const saved = JSON.parse(fs.readFileSync(outFile, "utf8"));
    assert.equal(saved.seeds, "public");
    assert.equal(saved.axes.reliability, 10);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("generatePreviewContactSheets builds contact sheet PNG from manifest", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mol-preview-"));
  try {
    const framesDir = path.join(tmpDir, "frames");
    fs.mkdirSync(framesDir, { recursive: true });
    const png = new PNG({ width: 16, height: 16 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 40;
      png.data[i + 1] = 200;
      png.data[i + 2] = 140;
      png.data[i + 3] = 255;
    }
    fs.writeFileSync(path.join(framesDir, "s1.png"), PNG.sync.write(png));
    fs.writeFileSync(path.join(framesDir, "s2.png"), PNG.sync.write(png));
    const manifestPath = path.join(tmpDir, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        room: "aurora",
        samples: [
          { key: "s1", file: "frames/s1.png" },
          { key: "s2", file: "frames/s2.png" }
        ]
      })
    );

    const sheets = generatePreviewContactSheets(manifestPath, path.join(tmpDir, "preview"));
    assert.equal(sheets.length, 1);
    assert.equal(fs.existsSync(sheets[0]), true);
    const outPng = PNG.sync.read(fs.readFileSync(sheets[0]));
    assert.ok(outPng.width > 0 && outPng.height > 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

const CAPTURE_PRESENT = fs.existsSync(new URL("../src/capture/plan.mjs", import.meta.url));
test("gradeSubmission fails clearly when capture/plan.mjs is missing and --no-capture is omitted", { skip: CAPTURE_PRESENT && "capture layer present" }, async () => {
  await assert.rejects(
    () =>
      gradeSubmission({
        room: "aurora",
        submissionDir: MOCK_AURORA,
        noCapture: false,
        noPython: true,
        repoRoot: REPO_ROOT
      }),
    /Capture layer missing/
  );
});
