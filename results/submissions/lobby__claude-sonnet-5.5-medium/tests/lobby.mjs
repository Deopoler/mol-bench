export default [
  {
    id: "coming-soon-no-nav",
    title: "Coming-soon cards have no link to a room route",
    async run({ page }) {
      const bad = await page.evaluate(() => [...document.querySelectorAll('[data-bench="room-card"][data-status="coming_soon"]')]
        .filter((c) => c.querySelector("a[href]")).length);
      return { pass: bad === 0, detail: String(bad) };
    }
  },
  {
    id: "lang-toggle",
    title: "Language toggle switches html lang and state().lang",
    async run({ page }) {
      await page.locator('[data-bench="lang-toggle"]').click();
      const r = await page.evaluate(() => [document.documentElement.lang, window.__bench.state().lang]);
      return { pass: r[0] === "en" && r[1] === "en", detail: r.join(",") };
    }
  }
];
