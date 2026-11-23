/**
 * Public functional self-check tests for Restoration v0.2 ("The Fractured Planetarium").
 */
export default [
  {
    id: "orbits-and-resize-aspect",
    title: "Planet orbits advance with clock and portrait-to-landscape resize preserves planet circularity",
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

      await page.setViewportSize({ width: 768, height: 1024 });
      await page.evaluate(() => window.dispatchEvent(new Event("resize")));
      await page.setViewportSize({ width: 1200, height: 700 });
      const aspectCheck = await page.evaluate(async () => {
        window.dispatchEvent(new Event("resize"));
        await window.__bench.renderFrame();
        const st = window.__bench.state();
        const aspect = st.probes?.focusedAspect ?? 0;
        const count = st.probes?.focusedPixelCount ?? 0;
        return {
          ok: count > 60 && aspect >= 0.86 && aspect <= 1.16,
          aspect,
          count
        };
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
    id: "mount-unmount-and-focus-cycling",
    title: "Repeated mount/unmount cycles preserve shared geometry triangles, release per-mount resources, and advance focus by 1",
    async run(ctx) {
      const page = ctx.page;
      const res = await page.evaluate(async () => {
        const container = document.getElementById("orrery-stage") || document.body;
        window.__bench.setSeed(1);
        window.__bench.seek(1000);
        await window.__bench.renderFrame();
        const s0 = window.__bench.stats();

        await window.__bench.unmount();
        const detached = container.querySelector("canvas") === null;
        await window.__bench.mount(container);

        for (let i = 0; i < 5; i++) {
          await window.__bench.unmount();
          await window.__bench.mount(container);
        }
        window.__bench.seek(1000);
        await window.__bench.renderFrame();
        const sAfter = window.__bench.stats();
        const beforeIdx = window.__bench.state().focusedIndex;
        const btn = document.querySelector('[data-bench="next-planet"]');
        if (!btn) return { ok: false, detail: "Missing [data-bench=next-planet] button" };
        btn.click();
        const afterIdx = window.__bench.state().focusedIndex;
        const step = (afterIdx - beforeIdx + 7) % 7;

        const ok =
          detached &&
          step === 1 &&
          sAfter.geometries === s0.geometries &&
          sAfter.textures === s0.textures &&
          sAfter.listeners === s0.listeners &&
          sAfter.triangles === s0.triangles &&
          sAfter.triangles > 1000;
        return { ok, detached, step, s0, sAfter };
      });
      return {
        pass: Boolean(res.ok),
        detail: res.ok ? "Lifecycle baseline, shared geometries, and focus step preserved" : JSON.stringify(res)
      };
    }
  },
  {
    id: "tonemap-relief-and-shadows",
    title: "Post-FX tonemap, relief normal orientation, ORM roughness sectors, and pedestal contact shadow are calibrated",
    async run(ctx) {
      const page = ctx.page;
      await page.setViewportSize({ width: 1440, height: 900 });
      const res = await page.evaluate(async () => {
        window.__bench.setSeed(1);
        window.__bench.seek(1000);
        await window.__bench.renderFrame();
        const st = window.__bench.state();
        const p = st.probes;
        if (!p) return { ok: false, detail: "Missing state().probes" };
        const bgErr = Math.hypot(p.bgSrgb[0] - 20, p.bgSrgb[1] - 24, p.bgSrgb[2] - 34);
        const topLum = 0.2126 * p.topBevelSrgb[0] + 0.7152 * p.topBevelSrgb[1] + 0.0722 * p.topBevelSrgb[2];
        const botLum = 0.2126 * p.botBevelSrgb[0] + 0.7152 * p.botBevelSrgb[1] + 0.0722 * p.botBevelSrgb[2];
        const satinLum = 0.2126 * p.satinSectorSrgb[0] + 0.7152 * p.satinSectorSrgb[1] + 0.0722 * p.satinSectorSrgb[2];
        const shadowLum = 0.2126 * p.contactShadowSrgb[0] + 0.7152 * p.contactShadowSrgb[1] + 0.0722 * p.contactShadowSrgb[2];
        const ok = bgErr <= 22 && botLum > topLum + 10 && satinLum > 160 && shadowLum < 65;
        return { ok, bgErr, topLum, botLum, satinLum, shadowLum };
      });
      return {
        pass: Boolean(res.ok),
        detail: res.ok ? "Visual pipeline and contact shadow calibrated" : JSON.stringify(res)
      };
    }
  }
];
