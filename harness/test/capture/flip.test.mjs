import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { measureLiveFlip } from "../../src/capture/plan.mjs";

function writeSolid(file, color) {
  const png = new PNG({ width: 64, height: 64 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = color[0]; png.data[i + 1] = color[1]; png.data[i + 2] = color[2]; png.data[i + 3] = 255;
  }
  fs.writeFileSync(file, PNG.sync.write(png));
}

test("G-live uses FLIP: identical PNGs pass and very different PNGs fail", () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), "work", "mol-flip-"));
  const a = path.join(dir, "a.png"), same = path.join(dir, "same.png"), different = path.join(dir, "different.png");
  writeSolid(a, [20, 30, 40]); writeSolid(same, [20, 30, 40]); writeSolid(different, [245, 230, 220]);
  const identicalResult = measureLiveFlip(a, same);
  assert.equal(identicalResult.pass, true, identicalResult.detail);
  assert.equal(identicalResult.flip, 0);
  const differentResult = measureLiveFlip(a, different);
  assert.equal(differentResult.pass, false, differentResult.detail);
  assert.ok(differentResult.flip > 0.02);
  assert.equal(measureLiveFlip(a, same, { noPython: true }).pass, null);
});
