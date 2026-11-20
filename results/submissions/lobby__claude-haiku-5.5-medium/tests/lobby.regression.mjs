// Regression checks for the lobby. Same shape as public-tests/smoke.mjs (page-based checks).
export default [
  {
    id: "lobby-landmarks",
    title: "Required [data-bench] landmarks exist",
    async run({ page }) {
      const missing = await page.evaluate(() => ["header", "hero-title", "body", "footer", "empty-state", "room-card"]
        .filter((x) => !document.querySelector(`[data-bench="${x}"]`)));
      return { pass: missing.length === 0, detail: missing.join(",") };
    }
  },
  {
    id: "lang-toggle-updates-titles",
    title: "Language toggle switches html lang and room card titles",
    async run({ page }) {
      const before = await page.evaluate(() => ({ lang: document.documentElement.lang, state: window.__bench.state().lang }));
      await page.locator('[data-bench="lang-toggle"]').click();
      const after = await page.evaluate(() => {
        const rooms = window.__benchHost?.params?.rooms ?? [];
        const headings = [...document.querySelectorAll('[data-bench="room-card"] h3')].map((h) => h.textContent);
        return {
          lang: document.documentElement.lang,
          state: window.__bench.state().lang,
          titlesEn: rooms.every((r) => !r.title_en || headings.includes(r.title_en)),
        };
      });
      const pass = before.lang === "ko" && after.lang === "en" && after.state === "en" && after.titlesEn;
      await page.locator('[data-bench="lang-toggle"]').click();
      return { pass, detail: JSON.stringify({ before, after }) };
    }
  },
  {
    id: "coming-soon-not-linked",
    title: "Coming-soon cards contain no link",
    async run({ page }) {
      const linked = await page.evaluate(() => [...document.querySelectorAll('[data-bench="room-card"][data-status="coming_soon"] a')].length);
      return { pass: linked === 0, detail: `linked=${linked}` };
    }
  },
  {
    id: "room-route-and-back",
    title: "Opening a room changes route and back returns to lobby",
    async run({ page }) {
      const link = page.locator('[data-bench="room-card"][data-status="open"] a').first();
      if (await link.count() === 0) return { pass: true, detail: "no open rooms" };
      const href = await link.getAttribute("href");
      await link.click();
      const inRoom = await page.evaluate((h) => window.__bench.state().route !== "lobby" && location.hash === h, href);
      await page.goBack();
      const back = await page.evaluate(() => window.__bench.state().route);
      return { pass: inRoom && back === "lobby", detail: `inRoom=${inRoom} back=${back}` };
    }
  }
];
