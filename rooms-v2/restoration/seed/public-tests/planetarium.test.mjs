/**
 * Public smoke checks for Restoration v0.2 ("The Fractured Planetarium").
 * Checks only basic contract and gallery health — never leaks per-bug probe names or expected thresholds.
 */
export default [
  {
    id: "orbits-and-clock-advance",
    title: "Planetarium mounts, renders WebGL canvas, and advances planet orbits with clock",
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
      if (!Array.isArray(s1.chartPatches) || s1.chartPatches.length !== 12) {
        return { pass: false, detail: `Expected 12 chartPatches in state(), got ${s1.chartPatches?.length}` };
      }
      return { pass: true, detail: "Planetarium renders and advances orbits cleanly" };
    }
  },
  {
    id: "mount-unmount-and-focus-button",
    title: "Unmount detaches canvas, remount restores stage, and next-planet control updates focus readout",
    async run(ctx) {
      const page = ctx.page;
      const res = await page.evaluate(async () => {
        const container = document.getElementById("orrery-stage") || document.body;
        window.__bench.setSeed(1);
        window.__bench.seek(1000);
        await window.__bench.renderFrame();

        await window.__bench.unmount();
        const detached = container.querySelector("canvas") === null;
        await window.__bench.mount(container);
        const reattached = container.querySelector("canvas") !== null;

        const beforeIdx = window.__bench.state().focusedIndex;
        const btn = document.querySelector('[data-bench="next-planet"]');
        if (!btn) return { ok: false, detail: "Missing [data-bench=next-planet] button" };
        btn.click();
        const afterIdx = window.__bench.state().focusedIndex;
        const readout = document.getElementById("focused-planet-name")?.textContent || "";

        const ok = detached && reattached && afterIdx !== beforeIdx && readout.length > 0;
        return { ok, detached, reattached, beforeIdx, afterIdx, readout };
      });
      return {
        pass: Boolean(res.ok),
        detail: res.ok ? "Mount/unmount and focus button operational" : JSON.stringify(res)
      };
    }
  }
];
