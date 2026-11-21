export default [
  {
    id: "landmarks-exist",
    title: "Required landmarks exist in DOM",
    async run({ page }) {
      const required = ["header", "hero-title", "body", "empty-state", "footer", "lang-toggle", "theme-toggle"];
      const missing = await page.evaluate((req) => req.filter((x) => !document.querySelector(`[data-bench="${x}"]`)), required);
      return { pass: missing.length === 0, detail: missing.join(",") };
    }
  },
  {
    id: "lang-toggle-works",
    title: "Language toggle changes language in DOM and state",
    async run({ page }) {
      const initial = await page.evaluate(() => window.__bench.state().lang);
      const btn = page.locator('[data-bench="lang-toggle"]');
      await btn.click();
      const updated = await page.evaluate(() => window.__bench.state().lang);
      return { pass: initial !== updated, detail: `${initial} -> ${updated}` };
    }
  },
  {
    id: "bench-contract",
    title: "window.__bench satisfies BenchRoom v1 contract",
    async run({ page }) {
      const result = await page.evaluate(() => {
        const b = window.__bench;
        if (!b) return { pass: false, detail: "missing __bench" };
        const hasProps = b.version === 1 && typeof b.setSeed === "function" && typeof b.seek === "function" && typeof b.resume === "function" && typeof b.renderFrame === "function" && typeof b.state === "function" && typeof b.stats === "function";
        const st = b.state();
        const hasState = st && typeof st.route === "string" && typeof st.lang === "string" && typeof st.theme === "string";
        return { pass: hasProps && hasState, detail: JSON.stringify(st) };
      });
      return result;
    }
  }
];
