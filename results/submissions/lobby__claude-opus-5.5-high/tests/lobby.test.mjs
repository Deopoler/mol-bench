// Regression tests for the lobby. Run from the repo root:
//   PLAYWRIGHT_BROWSERS_PATH=0 node tests/lobby.test.mjs [screenshotDir]
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const repo = process.cwd();
const { chromium } = await import(pathToFileURL(path.join(repo, 'node_modules/playwright/index.mjs')).href);
const { generate } = await import(pathToFileURL(path.join(repo, 'bench/rooms/lobby.mjs')).href);
const url = pathToFileURL(path.join(repo, 'lobby/index.html')).href;
const shotDir = process.argv[2] || null;

const browser = await chromium.launch();
let failures = 0;

async function open(params, { viewport = '1440x900', scheme = 'light', reducedMotion = 'no-preference', seed = 1 } = {}) {
  const [width, height] = viewport.split('x').map(Number);
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(`window.__benchHost = { contractVersion: 1, seed: ${seed}, params: ${JSON.stringify(params)},
    clock: { now: () => 0 }, rng: { next: () => 0.5, int: () => 0, fork() { return this; } } };`);
  await page.goto(url);
  await page.evaluate(() => window.__bench.ready);
  return { ctx, page, errors };
}

async function test(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failures += 1; console.log(`FAIL ${name}\n     ${String(e.message).split('\n')[0]}`); }
}

const variants = ['normal', 'empty_rooms', 'one_room', 'long_title', 'many_rooms', 'coming_soon'];
for (const variant of variants) {
  for (const viewport of ['360x780', '768x1024', '1440x900']) {
    await test(`${variant} @ ${viewport}: cards, landmarks, no overflow`, async () => {
      const params = generate(2, { variant });
      const { ctx, page, errors } = await open(params, { viewport });
      const r = await page.evaluate(() => ({
        cards: [...document.querySelectorAll('[data-bench="room-card"]')].map((c) => ({
          h3: c.querySelector('h3')?.textContent,
          status: c.dataset.status,
          link: c.querySelector('a[href]')?.getAttribute('href') ?? null,
        })),
        landmarks: ['header', 'hero-title', 'body', 'footer', 'empty-state'].filter((x) => !document.querySelector(`[data-bench="${x}"]`)),
        emptyHidden: document.querySelector('[data-bench="empty-state"]').hidden,
        overflow: document.documentElement.scrollWidth - innerWidth,
        h1: document.querySelectorAll('h1').length,
      }));
      assert.deepEqual(r.landmarks, []);
      assert.equal(r.h1, 1);
      assert.equal(r.cards.length, params.rooms.length);
      params.rooms.forEach((room, i) => {
        assert.equal(r.cards[i].h3, room.title_ko);
        if (room.status === 'coming_soon') {
          assert.equal(r.cards[i].link, null);
          assert.equal(r.cards[i].status, 'coming_soon');
        } else assert.equal(r.cards[i].link, room.route);
      });
      assert.equal(r.emptyHidden, params.rooms.length > 0);
      assert.ok(r.overflow <= 0, `horizontal overflow ${r.overflow}px`);
      assert.deepEqual(errors, []);
      if (shotDir && viewport !== '768x1024') {
        await page.screenshot({ path: path.join(shotDir, `${variant}_${viewport}.png`), fullPage: true });
      }
      await ctx.close();
    });
  }
}

await test('coming-soon card does not navigate', async () => {
  const { ctx, page } = await open(generate(1, { variant: 'coming_soon' }));
  await page.click('[data-bench="room-card"][data-status="coming_soon"]');
  assert.equal(await page.evaluate(() => location.hash), '');
  assert.equal(await page.evaluate(() => window.__bench.state().route), 'lobby');
  await page.evaluate(() => { location.hash = '#/room/room-1'; });
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__bench.state().route), 'lobby');
  await ctx.close();
});

await test('open room routes and back returns to lobby with scroll kept', async () => {
  const { ctx, page } = await open(generate(3));
  const card = page.locator('[data-bench="room-card"] a').nth(4);
  await card.scrollIntoViewIfNeeded();
  const y = await page.evaluate(() => scrollY);
  await card.click();
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.__bench.state().route), 'room-5');
  assert.equal(await page.evaluate(() => location.hash), '#/room/room-5');
  if (shotDir) await page.screenshot({ path: path.join(shotDir, 'room-view.png') });
  await page.goBack();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__bench.state().route), 'lobby');
  assert.ok(Math.abs((await page.evaluate(() => scrollY)) - y) <= 50, 'scroll restored');
  await ctx.close();
});

await test('keyboard Enter on a card navigates', async () => {
  const { ctx, page } = await open(generate(1));
  await page.focus('[data-bench="room-card"] a');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__bench.state().route), 'room-1');
  await ctx.close();
});

await test('language toggle switches to English titles and persists', async () => {
  const params = generate(1);
  const { ctx, page } = await open(params);
  assert.equal(await page.evaluate(() => window.__bench.state().lang), 'ko');
  await page.click('[data-bench="lang-toggle"]');
  const r = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    state: window.__bench.state().lang,
    stored: localStorage.getItem('mol-lang'),
    h3: [...document.querySelectorAll('[data-bench="room-card"] h3')].map((h) => h.textContent),
    overflow: document.documentElement.scrollWidth - innerWidth,
  }));
  assert.equal(r.lang, 'en');
  assert.equal(r.state, 'en');
  assert.equal(r.stored, 'en');
  assert.deepEqual(r.h3, params.rooms.map((x) => x.title_en));
  assert.ok(r.overflow <= 0);
  if (shotDir) await page.screenshot({ path: path.join(shotDir, 'english_1440.png'), fullPage: true });
  await ctx.close();
});

await test('theme toggle flips theme; system scheme change resets override', async () => {
  const { ctx, page } = await open(generate(1), { scheme: 'dark' });
  assert.equal(await page.evaluate(() => window.__bench.state().theme), 'dark');
  if (shotDir) await page.screenshot({ path: path.join(shotDir, 'dark_1440.png'), fullPage: true });
  await page.click('[data-bench="theme-toggle"]');
  assert.equal(await page.evaluate(() => window.__bench.state().theme), 'light');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(50);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__bench.state().theme), 'dark');
  await ctx.close();
});

await test('reduced motion removes the room transition', async () => {
  const { ctx, page } = await open(generate(1), { reducedMotion: 'reduce' });
  const d = await page.evaluate(() => getComputedStyle(document.getElementById('room-view')).transitionDuration);
  assert.ok(d.split(',').every((x) => parseFloat(x) === 0), d);
  await ctx.close();
});

await browser.close();
console.log(failures ? `${failures} failing` : 'all passed');
process.exit(failures ? 1 : 0);
