export default [
  {
    id: "lobby-dom",
    title: "Required lobby landmarks exist",
    async run({ page }) {
      const missing = await page.evaluate(() => ["header", "hero-title", "body", "footer", "empty-state"]
        .filter((x) => !document.querySelector(`[data-bench="${x}"]`)));
      return { pass: missing.length === 0, detail: missing.join(",") };
    }
  },
  {
    id: "theme-control",
    title: "Theme control changes the rendered theme",
    async run({ page }) {
      const control = page.locator('[data-bench="theme-toggle"]');
      if (await control.count() !== 1) return { pass: false, detail: "theme control missing" };
      const before = await page.evaluate(() => window.__bench.state().theme);
      await control.click();
      const after = await page.evaluate(() => window.__bench.state().theme);
      return { pass: before !== after, detail: `${before} -> ${after}` };
    }
  }
];
