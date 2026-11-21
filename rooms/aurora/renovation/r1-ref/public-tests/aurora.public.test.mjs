export default [
  {
    id: "bench-contract-ready",
    title: "window.__bench implements version 1 contract and ready resolves",
    async run(ctx) {
      const ok = await ctx.page.evaluate(async () => {
        const b = window.__bench;
        if (!b || b.version !== 1) return { ok: false, reason: "missing __bench.version === 1" };
        await b.ready;
        const required = ["setSeed", "seek", "resume", "renderFrame", "state", "stats"];
        for (const k of required) {
          if (typeof b[k] !== "function") return { ok: false, reason: `missing function ${k}` };
        }
        return { ok: true };
      });
      return { pass: ok.ok, detail: ok.reason || "contract present" };
    }
  },
  {
    id: "state-shape",
    title: "state() returns palette, reducedMotion, and pointer",
    async run(ctx) {
      await ctx.bench.setSeed(1);
      await ctx.bench.seek(1000);
      await ctx.bench.renderFrame();
      const st = await ctx.bench.state();
      const valid =
        st &&
        Array.isArray(st.palette) &&
        typeof st.reducedMotion === "boolean" &&
        Array.isArray(st.pointer) &&
        st.pointer.length === 2;
      return {
        pass: Boolean(valid),
        detail: valid ? "state shape valid" : `unexpected state: ${JSON.stringify(st)}`
      };
    }
  },
  {
    id: "canvas-renders-single-draw-call",
    title: "WebGL2 canvas fills viewport and reports <= 4 draw calls",
    async run(ctx) {
      await ctx.bench.setSeed(1);
      await ctx.bench.seek(1000);
      await ctx.bench.renderFrame();
      const info = await ctx.page.evaluate(() => {
        const c = document.querySelector("canvas");
        const stats = window.__bench.stats();
        return {
          hasCanvas: Boolean(c),
          w: c?.width || 0,
          h: c?.height || 0,
          drawCalls: stats?.drawCalls ?? -1
        };
      });
      const pass = info.hasCanvas && info.w > 0 && info.h > 0 && info.drawCalls >= 1 && info.drawCalls <= 4;
      return {
        pass,
        detail: `canvas=${info.w}x${info.h}, drawCalls=${info.drawCalls}`
      };
    }
  }
];
