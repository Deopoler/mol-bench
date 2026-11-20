/**
 * Public functional self-check tests for Restoration ("The Broken Orrery Room").
 * Format per docs/ARCHITECTURE.md "Hidden tests".
 */

export default [
  {
    id: "orbits-and-resize-aspect",
    title: "Planet orbits advance with clock and window resize updates camera aspect",
    async run(ctx) {
      const page = ctx.page;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(async () => {
        window.__bench.setSeed(1);
        window.__bench.seek(0);
        await window.__bench.renderFrame();
      });
      const s0 = await page.evaluate(() => window.__bench.state());
      await page.evaluate(async () => {
        window.__bench.seek(4000);
        await window.__bench.renderFrame();
      });
      const s1 = await page.evaluate(() => window.__bench.state());
      const angleDiff = Math.abs((s1.orbitAngleDeg ?? 0) - (s0.orbitAngleDeg ?? 0));
      if (!(angleDiff > 10)) {
        return { pass: false, detail: `Orbit did not advance between t=0 and t=4000 (delta=${angleDiff})` };
      }

      // Resize portrait -> landscape and inspect projected focused planet circularity in canvas
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.evaluate(() => window.dispatchEvent(new Event("resize")));
      await page.setViewportSize({ width: 1200, height: 700 });
      await page.evaluate(async () => {
        window.dispatchEvent(new Event("resize"));
        await window.__bench.renderFrame();
      });

      const aspectCheck = await page.evaluate(() => {
        const st = window.__bench.state();
        const canvas = document.querySelector("canvas");
        if (!canvas) return { ok: false, reason: "no canvas" };
        const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
        const w = canvas.width;
        const h = canvas.height;
        if (w !== 1200 || h !== 700) {
          return { ok: false, reason: `canvas drawingBuffer size ${w}x${h} != 1200x700` };
        }
        const cx = st.focusedCenter?.x ?? 600;
        const cy = st.focusedCenter?.y ?? 350;
        const mc = st.focusedMaskColor || [52, 212, 196];
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let minX = w, maxX = 0, minY = h, maxY = 0, count = 0;
        for (let y = Math.max(0, cy - 90); y < Math.min(h, cy + 90); y++) {
          for (let x = Math.max(0, cx - 90); x < Math.min(w, cx + 90); x++) {
            const idx = ((h - 1 - y) * w + x) * 4;
            const dr = px[idx] - mc[0];
            const dg = px[idx + 1] - mc[1];
            const db = px[idx + 2] - mc[2];
            if (dr * dr + dg * dg + db * db <= 144) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
              count++;
            }
          }
        }
        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;
        const ratio = bh > 0 ? bw / bh : 0;
        return { ok: count > 100 && ratio >= 0.85 && ratio <= 1.18, ratio, count };
      });

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(async () => {
        window.dispatchEvent(new Event("resize"));
        await window.__bench.renderFrame();
      });

      if (!aspectCheck.ok) {
        return { pass: false, detail: `Planet aspect distorted after resize (${JSON.stringify(aspectCheck)})` };
      }
      return { pass: true, detail: "Orbits advance and resize aspect is preserved" };
    }
  },
  {
    id: "focus-cycling-single-step",
    title: "Next-planet control advances focusedIndex by 1 after lifecycle remounts",
    async run(ctx) {
      const page = ctx.page;
      const res = await page.evaluate(async () => {
        const container = document.getElementById("orrery-stage") || document.body;
        const s0 = window.__bench.stats();
        for (let i = 0; i < 6; i++) {
          await window.__bench.unmount();
          await window.__bench.mount(container);
        }
        const sAfter = window.__bench.stats();
        const beforeIdx = window.__bench.state().focusedIndex;
        const btn = document.querySelector('[data-bench="next-planet"]');
        if (!btn) return { ok: false, detail: "Missing [data-bench=next-planet] button" };
        btn.click();
        const afterIdx = window.__bench.state().focusedIndex;
        const step = (afterIdx - beforeIdx + 7) % 7;
        const geomOk = sAfter.geometries === s0.geometries;
        return {
          ok: step === 1 && geomOk,
          step,
          geomBefore: s0.geometries,
          geomAfter: sAfter.geometries
        };
      });
      return {
        pass: Boolean(res.ok),
        detail: res.ok ? "Single-step focus and resource baseline preserved" : JSON.stringify(res)
      };
    }
  },
  {
    id: "mount-unmount-lifecycle",
    title: "unmount() removes canvas and disposes resources; mount() restores baseline",
    async run(ctx) {
      const page = ctx.page;
      const res = await page.evaluate(async () => {
        const container = document.getElementById("orrery-stage") || document.body;
        const base = window.__bench.stats();
        await window.__bench.unmount();
        const hasCanvasWhileUnmounted = container.querySelector("canvas") !== null;
        await window.__bench.mount(container);
        const after = window.__bench.stats();
        const ok =
          !hasCanvasWhileUnmounted &&
          after.geometries === base.geometries &&
          after.textures === base.textures;
        return { ok, hasCanvasWhileUnmounted, base, after };
      });
      return {
        pass: Boolean(res.ok),
        detail: res.ok ? "Clean unmount/mount lifecycle" : JSON.stringify(res)
      };
    }
  },
  {
    id: "plaque-chart-calibration",
    title: "Wall plaque 12 chartPatches are within viewport and render calibrated sRGB colors",
    async run(ctx) {
      const page = ctx.page;
      await page.setViewportSize({ width: 1440, height: 900 });
      const res = await page.evaluate(async () => {
        window.__bench.setSeed(1);
        window.__bench.seek(1000);
        await window.__bench.renderFrame();
        const st = window.__bench.state();
        const patches = st.chartPatches || [];
        if (patches.length !== 12) return { ok: false, detail: `Expected 12 chartPatches, got ${patches.length}` };
        const canvas = document.querySelector("canvas");
        const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
        const w = canvas.width;
        const h = canvas.height;
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

        const p0 = patches[0];
        const idx0 = ((h - 1 - p0.y) * w + p0.x) * 4;
        const r0 = px[idx0], g0 = px[idx0 + 1], b0 = px[idx0 + 2];
        // Patch 0 reference sRGB is [194, 150, 130]; background at (20, 20) is [20, 24, 34]
        const bgIdx = ((h - 1 - 20) * w + 20) * 4;
        const bgR = px[bgIdx], bgG = px[bgIdx + 1], bgB = px[bgIdx + 2];
        const patchErr = Math.hypot(r0 - 194, g0 - 150, b0 - 130);
        const bgErr = Math.hypot(bgR - 20, bgG - 24, bgB - 34);
        return {
          ok: patchErr <= 18 && bgErr <= 18,
          patch0: [r0, g0, b0],
          bg: [bgR, bgG, bgB],
          patchErr,
          bgErr
        };
      });
      return {
        pass: Boolean(res.ok),
        detail: res.ok ? "Color chart and scene colors calibrated" : JSON.stringify(res)
      };
    }
  },
  {
    id: "camera-drift-and-floor-decal",
    title: "Camera follows seeded drift path and floor decal renders without z-fighting",
    async run(ctx) {
      const page = ctx.page;
      const res = await page.evaluate(async () => {
        window.__bench.setSeed(1);
        window.__bench.seek(2500);
        await window.__bench.renderFrame();
        const cam0 = window.__bench.state().camera.position;

        const canvas = document.querySelector("canvas");
        const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
        const rw = 200;
        const rh = 80;
        const rx = 760;
        const ry = 160;

        const frames = [];
        for (let k = 0; k < 4; k++) {
          window.__bench.seek(2500 + k * 16.667);
          await window.__bench.renderFrame();
          const buf = new Uint8Array(rw * rh * 4);
          gl.readPixels(rx, ry, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          frames.push(buf);
        }
        window.__bench.seek(4000);
        await window.__bench.renderFrame();
        const cam1 = window.__bench.state().camera.position;
        const camMoved = Math.hypot(cam1[0] - cam0[0], cam1[1] - cam0[1], cam1[2] - cam0[2]) > 0.004;

        let jumpingPixels = 0;
        for (let i = 0; i < rw * rh * 4; i += 4) {
          const d01 = Math.abs(frames[1][i] - frames[0][i]);
          const d12 = Math.abs(frames[2][i] - frames[1][i]);
          if (d01 > 75 && d12 > 75) {
            jumpingPixels++;
          }
        }
        return { ok: camMoved && jumpingPixels < 50, camMoved, jumpingPixels };
      });
      return {
        pass: Boolean(res.ok),
        detail: res.ok ? "Camera drift and floor decal stable" : JSON.stringify(res)
      };
    }
  }
];
