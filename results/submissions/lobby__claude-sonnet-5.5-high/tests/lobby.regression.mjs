// Regression tests for the Museum of Light lobby (same format as public-tests/smoke.mjs).
const cards = '[data-bench="room-card"]';

async function load(ctx, variant) {
  await ctx.bench.setSeed(1, ctx.params(1, { variant }));
  await ctx.page.waitForTimeout(50);
}

export default [
  {
    id: 'lobby-empty-state',
    title: 'Empty collection shows the empty state and no cards',
    async run(ctx) {
      await load(ctx, 'empty_rooms');
      const r = await ctx.page.evaluate((c) => ({
        cards: document.querySelectorAll(c).length,
        shown: !document.querySelector('[data-bench="empty-state"]').hidden,
      }), cards);
      return { pass: r.cards === 0 && r.shown, detail: JSON.stringify(r) };
    },
  },
  {
    id: 'lobby-coming-soon',
    title: 'Coming-soon room is distinct, has no link and does not navigate',
    async run(ctx) {
      await load(ctx, 'coming_soon');
      const r = await ctx.page.evaluate((c) => {
        const first = document.querySelector(c);
        const before = location.hash;
        first.click();
        first.querySelector('.card-body')?.click();
        return {
          status: first.dataset.status,
          links: first.querySelectorAll('a[href]').length,
          badge: !!first.querySelector('.badge'),
          unchanged: location.hash === before,
          route: window.__bench.state().route,
        };
      }, cards);
      return { pass: r.status === 'coming_soon' && r.links === 0 && r.badge && r.unchanged && r.route === 'lobby', detail: JSON.stringify(r) };
    },
  },
  {
    id: 'lobby-room-route',
    title: 'Room card routes by hash; the back link returns to the lobby; direct hash works',
    async run(ctx) {
      await load(ctx, 'normal');
      await ctx.page.click(`${cards} a`);
      const inRoom = await ctx.page.evaluate(() => window.__bench.state().route);
      await ctx.page.click('#back');
      const back = await ctx.page.evaluate(() => window.__bench.state().route);
      await ctx.page.evaluate(() => { location.hash = '#/room/room-2'; });
      await ctx.page.waitForTimeout(50);
      const direct = await ctx.page.evaluate(() => window.__bench.state().route);
      return { pass: inRoom === 'room-1' && back === 'lobby' && direct === 'room-2', detail: `${inRoom},${back},${direct}` };
    },
  },
  {
    id: 'lobby-lang-toggle',
    title: 'Language toggle switches titles to title_en and html lang',
    async run(ctx) {
      await load(ctx, 'normal');
      await ctx.page.click('[data-bench="lang-toggle"]');
      const r = await ctx.page.evaluate((c) => ({
        lang: document.documentElement.lang,
        state: window.__bench.state().lang,
        title: document.querySelector(`${c} h3`).textContent,
        want: window.__benchHost.params.rooms[0].title_en,
      }), cards);
      return { pass: r.lang === 'en' && r.state === 'en' && r.title === r.want, detail: JSON.stringify(r) };
    },
  },
  {
    id: 'lobby-theme-toggle',
    title: 'Theme toggle flips state().theme and the data-theme attribute',
    async run(ctx) {
      const before = await ctx.page.evaluate(() => window.__bench.state().theme);
      await ctx.page.click('[data-bench="theme-toggle"]');
      const after = await ctx.page.evaluate(() => [window.__bench.state().theme, document.documentElement.dataset.theme]);
      return { pass: after[0] !== before && after[0] === after[1], detail: `${before} -> ${after.join('/')}` };
    },
  },
  {
    id: 'lobby-no-overflow-long-title',
    title: 'Long titles and 24 rooms do not overflow at 360px',
    async run(ctx) {
      await ctx.bench.resize('360x780');
      for (const variant of ['long_title', 'many_rooms']) {
        await load(ctx, variant);
        const w = await ctx.page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
        if (w[0] > w[1]) return { pass: false, detail: `${variant}: ${w.join('>')}` };
      }
      return { pass: true, detail: 'no horizontal overflow' };
    },
  },
];
