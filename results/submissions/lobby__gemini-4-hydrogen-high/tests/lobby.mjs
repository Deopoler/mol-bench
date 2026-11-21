export default [
  {
    id: "lobby-landmarks",
    title: "Required lobby landmarks exist and consume generated rooms",
    async run({ page, params }) {
      const p1 = params(1);
      const res = await page.evaluate((expectedCount) => {
        const missing = ["header", "hero-title", "body", "footer", "empty-state"]
          .filter((x) => !document.querySelector(`[data-bench="${x}"]`));
        const cards = document.querySelectorAll('[data-bench="room-card"]');
        const empty = document.querySelector('[data-bench="empty-state"]');
        return {
          missing,
          cardCount: cards.length,
          expectedCount,
          emptyHidden: empty?.hidden === true,
        };
      }, p1.rooms.length);
      const pass = res.missing.length === 0 && res.cardCount === res.expectedCount && res.emptyHidden;
      return { pass, detail: JSON.stringify(res) };
    },
  },
  {
    id: "empty-state-and-coming-soon",
    title: "Empty collection shows empty state and coming-soon room does not navigate",
    async run({ page, bench, params }) {
      const emptyParams = params(1, { variant: "empty_rooms" });
      await bench.setSeed(1, emptyParams);
      await bench.renderFrame();
      const emptyShown = await page.evaluate(() => {
        const empty = document.querySelector('[data-bench="empty-state"]');
        const cards = document.querySelectorAll('[data-bench="room-card"]');
        return Boolean(empty && !empty.hidden && getComputedStyle(empty).display !== "none" && cards.length === 0);
      });

      const soonParams = params(1, { variant: "coming_soon" });
      await bench.setSeed(1, soonParams);
      await bench.renderFrame();
      const beforeHash = await page.evaluate(() => window.location.hash);
      await page.locator('[data-bench="room-card"]').first().click();
      const after = await page.evaluate(() => ({
        hash: window.location.hash,
        route: window.__bench.state().route,
        status: document.querySelector('[data-bench="room-card"]')?.getAttribute("data-status"),
        hasAnchor: Boolean(document.querySelector('[data-bench="room-card"] a[href]')),
      }));
      const soonOk = after.status === "coming_soon" && !after.hasAnchor && after.hash === beforeHash && after.route === "lobby";
      return {
        pass: emptyShown && soonOk,
        detail: `emptyShown=${emptyShown}, soonOk=${soonOk}, after=${JSON.stringify(after)}, beforeHash=${JSON.stringify(beforeHash)}`,
      };
    },
  },
  {
    id: "long-title-responsive",
    title: "Long Korean title renders without overflow at 360x780",
    async run({ page, bench, params }) {
      await bench.resize("360x780");
      const longParams = params(1, { variant: "long_title" });
      await bench.setSeed(1, longParams);
      await bench.renderFrame();
      const res = await page.evaluate((expectedTitle) => {
        const h3 = document.querySelector('[data-bench="room-card"] h3');
        const noOverflow = document.documentElement.scrollWidth <= window.innerWidth;
        const rect = h3 ? h3.getBoundingClientRect() : null;
        return {
          matches: h3?.textContent === expectedTitle,
          visible: Boolean(rect && rect.height > 0 && rect.width > 0),
          noOverflow,
        };
      }, longParams.rooms[0].title_ko);
      return {
        pass: res.matches && res.visible && res.noOverflow,
        detail: JSON.stringify(res),
      };
    },
  },
  {
    id: "theme-and-language-toggles",
    title: "Theme and language toggles update state, DOM, and persistence",
    async run({ page }) {
      const beforeTheme = await page.evaluate(() => window.__bench.state().theme);
      await page.locator('[data-bench="theme-toggle"]').click();
      const afterTheme = await page.evaluate(() => window.__bench.state().theme);

      await page.locator('[data-bench="lang-toggle"]').click();
      const enCheck = await page.evaluate(() => ({
        langAttr: document.documentElement.lang,
        stateLang: window.__bench.state().lang,
        stored: localStorage.getItem("mol-lang"),
        firstTitle: document.querySelector('[data-bench="room-card"] h3')?.textContent,
        expectedTitle: window.__benchHost.params.rooms[0]?.title_en,
      }));

      await page.locator('[data-bench="lang-toggle"]').click();
      const koCheck = await page.evaluate(() => ({
        langAttr: document.documentElement.lang,
        stateLang: window.__bench.state().lang,
        stored: localStorage.getItem("mol-lang"),
      }));

      const pass =
        beforeTheme !== afterTheme &&
        enCheck.langAttr === "en" &&
        enCheck.stateLang === "en" &&
        enCheck.stored === "en" &&
        enCheck.firstTitle === enCheck.expectedTitle &&
        koCheck.langAttr === "ko" &&
        koCheck.stateLang === "ko" &&
        koCheck.stored === "ko";
      return { pass, detail: `theme=${beforeTheme}->${afterTheme}, langOk=${pass}` };
    },
  },
  {
    id: "route-navigation-and-back-scroll",
    title: "Navigating to an open room updates hash and state, and Back restores lobby scroll",
    async run({ page }) {
      const lastCardLink = page.locator('[data-bench="room-card"] a[href]').last();
      await lastCardLink.scrollIntoViewIfNeeded();
      const beforeScroll = await page.evaluate(() => window.scrollY);
      const href = await lastCardLink.getAttribute("href");
      const expectedId = href.replace("#/room/", "");
      await lastCardLink.click();
      await page.waitForTimeout(80);
      const during = await page.evaluate(() => ({
        hash: window.location.hash,
        route: window.__bench.state().route,
      }));
      await page.goBack();
      await page.waitForTimeout(80);
      const back = await page.evaluate(() => ({
        route: window.__bench.state().route,
        scrollY: window.scrollY,
      }));
      const pass =
        during.hash === href &&
        during.route === expectedId &&
        back.route === "lobby" &&
        Math.abs(back.scrollY - beforeScroll) <= 50;
      return { pass, detail: JSON.stringify({ during, back, beforeScroll }) };
    },
  },
];
