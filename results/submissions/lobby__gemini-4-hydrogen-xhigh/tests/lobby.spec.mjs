export default [
  {
    id: 'landmarks-and-headings',
    title: 'Required landmarks, heading hierarchy, and BenchRoom state contract hold',
    async run({ page, bench }) {
      const res = await page.evaluate(() => {
        const required = ['header', 'hero-title', 'body', 'empty-state', 'footer', 'theme-toggle', 'lang-toggle'];
        const missing = required.filter((name) => !document.querySelector(`[data-bench="${name}"]`));
        const h1s = document.querySelectorAll('h1');
        const h2s = document.querySelectorAll('h2');
        const h3s = document.querySelectorAll('[data-bench="room-card"] h3');
        const state = window.__bench.state();
        const stats = window.__bench.stats();
        return {
          missing,
          h1Count: h1s.length,
          hasH2BeforeH3: h2s.length > 0 && h3s.length > 0,
          stateOk: state.route === 'lobby' && (state.lang === 'ko' || state.lang === 'en') && (state.theme === 'light' || state.theme === 'dark'),
          statsOk: typeof stats.drawCalls === 'number' && typeof stats.triangles === 'number',
          versionOk: window.__bench.version === 1,
        };
      });
      const pass =
        res.missing.length === 0 &&
        res.h1Count === 1 &&
        res.hasH2BeforeH3 &&
        res.stateOk &&
        res.statsOk &&
        res.versionOk;
      return { pass, detail: JSON.stringify(res) };
    },
  },
  {
    id: 'rooms-rendered-and-long-title',
    title: 'All generated rooms render and long_title stays unclipped at 360x780',
    async run({ page, bench, params }) {
      await bench.resize('360x780');
      const longParams = params(1, { variant: 'long_title' });
      await bench.setSeed(1, longParams);
      await bench.renderFrame();

      const check = await page.evaluate(() => {
        const rooms = window.__benchHost.params.rooms || [];
        const cards = [...document.querySelectorAll('[data-bench="room-card"]')];
        const h3 = document.querySelector('[data-bench="room-card"] h3');
        const noOverflow = document.documentElement.scrollWidth <= window.innerWidth;
        const h3Rect = h3 ? h3.getBoundingClientRect() : null;
        return {
          countMatch: cards.length === rooms.length && rooms.length === 1,
          titleExact: h3?.textContent === rooms[0]?.title_ko,
          visibleHeight: h3Rect ? h3Rect.height > 0 : false,
          notClipped: h3 ? h3.scrollWidth <= h3.clientWidth + 1 && h3.scrollHeight <= h3.clientHeight + 1 : false,
          noOverflow,
        };
      });
      const pass = Object.values(check).every(Boolean);
      return { pass, detail: JSON.stringify(check) };
    },
  },
  {
    id: 'many-and-one-room-responsive',
    title: 'One-room and 24-room collections avoid horizontal overflow across viewports',
    async run({ page, bench, params }) {
      const viewports = ['320x640', '360x780', '768x1024', '1440x900'];
      const variants = ['one_room', 'many_rooms'];
      const failures = [];

      for (const variant of variants) {
        const p = params(2, { variant });
        await bench.setSeed(2, p);
        for (const vp of viewports) {
          await bench.resize(vp);
          await bench.renderFrame();
          const ok = await page.evaluate((expectedLen) => {
            const cards = document.querySelectorAll('[data-bench="room-card"]');
            return {
              countOk: cards.length === expectedLen,
              overflow: document.documentElement.scrollWidth > window.innerWidth,
            };
          }, p.rooms.length);
          if (!ok.countOk || ok.overflow) {
            failures.push(`${variant}@${vp}: countOk=${ok.countOk}, overflow=${ok.overflow}`);
          }
        }
      }
      return { pass: failures.length === 0, detail: failures.join('; ') || 'ok' };
    },
  },
  {
    id: 'empty-state-and-repopulate',
    title: 'Empty collection toggles empty-state cleanly and recovers when repopulated',
    async run({ page, bench, params }) {
      await bench.setSeed(1, params(1, { variant: 'empty_rooms' }));
      await bench.renderFrame();
      const emptyCheck = await page.evaluate(() => {
        const empty = document.querySelector('[data-bench="empty-state"]');
        const cards = document.querySelectorAll('[data-bench="room-card"]');
        return Boolean(empty && !empty.hidden && getComputedStyle(empty).display !== 'none' && cards.length === 0);
      });

      await bench.setSeed(1, params(1, { variant: 'normal' }));
      await bench.renderFrame();
      const repopCheck = await page.evaluate(() => {
        const empty = document.querySelector('[data-bench="empty-state"]');
        const cards = document.querySelectorAll('[data-bench="room-card"]');
        return Boolean(empty?.hidden === true && cards.length === (window.__benchHost.params.rooms || []).length && cards.length > 0);
      });

      return { pass: emptyCheck && repopCheck, detail: `empty=${emptyCheck}, repop=${repopCheck}` };
    },
  },
  {
    id: 'coming-soon-non-navigable',
    title: 'Coming-soon room is visually distinct and cannot navigate to room route',
    async run({ page, bench, params }) {
      const p = params(1, { variant: 'coming_soon' });
      await bench.setSeed(1, p);
      await bench.renderFrame();

      const comingCard = page.locator('[data-bench="room-card"][data-status="coming_soon"]');
      if ((await comingCard.count()) !== 1) {
        return { pass: false, detail: 'missing coming_soon card' };
      }
      const hasAnchor = (await comingCard.locator('a[href]').count()) > 0;
      await comingCard.click();
      await page.waitForTimeout(50);

      const stateAfterClick = await page.evaluate(() => ({
        hash: location.hash,
        route: window.__bench.state().route,
      }));

      // Also verify manual hash attempt to coming_soon room does not enter it
      const comingId = p.rooms[0].id;
      await page.evaluate((id) => {
        location.hash = `#/room/${id}`;
      }, comingId);
      await page.waitForTimeout(50);
      const stateAfterHash = await bench.state();

      const pass =
        !hasAnchor &&
        stateAfterClick.route === 'lobby' &&
        !stateAfterClick.hash.includes(comingId) &&
        stateAfterHash.route === 'lobby';
      return {
        pass,
        detail: `hasAnchor=${hasAnchor}, afterClick=${JSON.stringify(stateAfterClick)}, afterHash=${JSON.stringify(stateAfterHash)}`,
      };
    },
  },
  {
    id: 'open-room-navigation-and-back-scroll',
    title: 'Clicking open room updates route and browser Back restores lobby and scrollY',
    async run({ page, bench, params }) {
      await bench.resize('360x780');
      await bench.setSeed(3, params(3, { variant: 'many_rooms' }));
      await bench.renderFrame();

      const targetHref = await page.evaluate(() => {
        const links = [...document.querySelectorAll('[data-bench="room-card"][data-status="open"] a[href]')];
        const target = links[links.length - 1];
        target.scrollIntoView({ block: 'center', behavior: 'instant' });
        return target.getAttribute('href');
      });
      const beforeScrollY = await page.evaluate(() => window.scrollY);

      await page.locator(`[data-bench="room-card"] a[href="${targetHref}"]`).click();
      await page.waitForTimeout(80);
      const inRoom = await page.evaluate(() => ({
        hash: location.hash,
        route: window.__bench.state().route,
      }));

      await page.goBack();
      await page.waitForTimeout(80);
      const back = await page.evaluate(() => ({
        hash: location.hash,
        route: window.__bench.state().route,
        scrollY: window.scrollY,
      }));

      const expectedId = targetHref.replace('#/room/', '');
      const pass =
        inRoom.hash === targetHref &&
        inRoom.route === expectedId &&
        back.route === 'lobby' &&
        Math.abs(back.scrollY - beforeScrollY) <= 50;
      return { pass, detail: JSON.stringify({ beforeScrollY, inRoom, back }) };
    },
  },
  {
    id: 'language-toggle-bilingual',
    title: 'Language toggle switches KO/EN, room titles, html lang, localStorage, without overflow',
    async run({ page, bench }) {
      for (const vp of ['320x640', '1440x900']) {
        await bench.resize(vp);
        const toggle = page.locator('[data-bench="lang-toggle"]');
        await toggle.focus();
        await toggle.click();
        await bench.renderFrame();

        const checkEn = await page.evaluate(() => {
          const rooms = window.__benchHost.params.rooms || [];
          const h3s = [...document.querySelectorAll('[data-bench="room-card"] h3')].map((h) => h.textContent);
          return {
            langAttr: document.documentElement.lang,
            stateLang: window.__bench.state().lang,
            stored: localStorage.getItem('mol-lang'),
            titlesOk: rooms.every((r, i) => h3s[i] === r.title_en),
            noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
          };
        });
        if (checkEn.langAttr !== 'en' || checkEn.stateLang !== 'en' || checkEn.stored !== 'en' || !checkEn.titlesOk || !checkEn.noOverflow) {
          return { pass: false, detail: `en@${vp}: ${JSON.stringify(checkEn)}` };
        }

        await toggle.click();
        await bench.renderFrame();
        const checkKo = await page.evaluate(() => {
          const rooms = window.__benchHost.params.rooms || [];
          const h3s = [...document.querySelectorAll('[data-bench="room-card"] h3')].map((h) => h.textContent);
          return {
            langAttr: document.documentElement.lang,
            stateLang: window.__bench.state().lang,
            stored: localStorage.getItem('mol-lang'),
            titlesOk: rooms.every((r, i) => h3s[i] === r.title_ko),
            noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
          };
        });
        if (checkKo.langAttr !== 'ko' || checkKo.stateLang !== 'ko' || checkKo.stored !== 'ko' || !checkKo.titlesOk || !checkKo.noOverflow) {
          return { pass: false, detail: `ko@${vp}: ${JSON.stringify(checkKo)}` };
        }
      }
      return { pass: true, detail: 'ok' };
    },
  },
  {
    id: 'theme-and-reduced-motion',
    title: 'Theme responds to colorScheme and toggle; reduced-motion disables route animations',
    async run({ page, bench }) {
      await bench.emulate({ colorScheme: 'light' });
      await bench.renderFrame();
      const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

      await bench.emulate({ colorScheme: 'dark' });
      await bench.renderFrame();
      const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

      const beforeToggle = (await bench.state()).theme;
      await page.locator('[data-bench="theme-toggle"]').click();
      await bench.renderFrame();
      const afterToggle = (await bench.state()).theme;

      await bench.emulate({ reducedMotion: 'reduce' });
      await page.locator('[data-bench="room-card"] a[href]').first().click();
      const activeAnims = await page.evaluate(() =>
        document.getAnimations().filter((a) => a.playState === 'running').length,
      );

      const pass = lightBg !== darkBg && beforeToggle === 'dark' && afterToggle === 'light' && activeAnims === 0;
      return { pass, detail: `lightBg=${lightBg}, darkBg=${darkBg}, toggle=${beforeToggle}->${afterToggle}, runningAnims=${activeAnims}` };
    },
  },
  {
    id: 'listener-stability-across-seeds',
    title: 'Repeated setSeed calls do not leak EventTarget listeners',
    async run({ bench, params }) {
      const initialListeners = await bench.getListenerCount();
      for (let s = 1; s <= 10; s++) {
        await bench.setSeed(s, params(s, { variant: 'normal' }));
        await bench.renderFrame();
      }
      const afterListeners = await bench.getListenerCount();
      return {
        pass: afterListeners === initialListeners,
        detail: `listeners: ${initialListeners} -> ${afterListeners}`,
      };
    },
  },
];
