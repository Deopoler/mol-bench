export default [
  {
    id: "lobby-landmarks",
    title: "All required landmarks exist in DOM",
    async run({ page }) {
      const missing = await page.evaluate(() =>
        ["header", "hero-title", "body", "footer", "empty-state"].filter(
          (x) => !document.querySelector(`[data-bench="${x}"]`)
        )
      );
      return { pass: missing.length === 0, detail: missing.join(",") };
    }
  },
  {
    id: "theme-toggle-check",
    title: "Theme toggle switches rendered theme",
    async run({ page }) {
      const control = page.locator('[data-bench="theme-toggle"]');
      if ((await control.count()) !== 1) return { pass: false, detail: "theme control missing" };
      const before = await page.evaluate(() => window.__bench.state().theme);
      await control.click();
      const after = await page.evaluate(() => window.__bench.state().theme);
      return { pass: before !== after, detail: `${before} -> ${after}` };
    }
  },
  {
    id: "lang-toggle-check",
    title: "Language toggle switches language and titles",
    async run({ page }) {
      const control = page.locator('[data-bench="lang-toggle"]');
      if ((await control.count()) !== 1) return { pass: false, detail: "lang control missing" };
      const before = await page.evaluate(() => window.__bench.state().lang);
      await control.click();
      const after = await page.evaluate(() => window.__bench.state().lang);
      const docLang = await page.evaluate(() => document.documentElement.lang);
      return { pass: before !== after && after === docLang, detail: `${before} -> ${after}` };
    }
  },
  {
    id: "coming-soon-non-navigable",
    title: "Coming soon cards do not have routes or links",
    async run({ page }) {
      const nonNav = await page.evaluate(() => {
        const comingCards = document.querySelectorAll('[data-bench="room-card"][data-status="coming_soon"]');
        for (const card of comingCards) {
          if (card.matches('a[href]') || card.querySelector('a[href]')) {
            return false;
          }
        }
        return true;
      });
      return { pass: nonNav, detail: nonNav ? "ok" : "coming soon card has a[href]" };
    }
  }
];
