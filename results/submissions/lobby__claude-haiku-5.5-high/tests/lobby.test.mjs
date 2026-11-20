// Regression tests for lobby/index.html. Run with: node --test tests/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOBBY_URL = pathToFileURL(path.join(here, '..', 'lobby', 'index.html')).href;

const ROOMS = [
  { id: 'room-1', route: '#/room/room-1', title_ko: '고요한 빛의 정원', title_en: 'A Garden of Quiet Light', summary_ko: '빛과 기억이 포개지는 작은 전시입니다.', accent_oklch: [0.68, 0.12, 120], status: 'open' },
  { id: 'room-2', route: '#/room/room-2', title_ko: '준비 중인 방', title_en: 'A Room Being Prepared', summary_ko: '곧 공개됩니다.', accent_oklch: [0.6, 0.1, 40], status: 'coming_soon' },
  { id: 'room-3', route: '#/room/room-3', title_ko: '빛의 기억이 머무는 아주 긴 복도에서 만나는 서른여덟 글자의 긴 이야기를 다시 천천히 읽어요', title_en: 'A Quiet Museum of Light for Curious Visitors Everywhere Today', summary_ko: '긴 제목을 확인합니다.', accent_oklch: [0.7, 0.1, 250], status: 'open' }
];

let browser;

before(async () => {
  // PW_CHROMIUM_PATH optionally points at a Chromium binary when Playwright's bundled one is not installed.
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined });
});

after(async () => {
  await browser?.close();
});

async function openLobby({ rooms = ROOMS, colorScheme = 'light', reducedMotion = 'no-preference', viewport = { width: 1440, height: 900 } } = {}) {
  const context = await browser.newContext({ colorScheme, reducedMotion, viewport });
  const page = await context.newPage();
  await page.addInitScript((list) => {
    try { localStorage.removeItem('mol-lang'); } catch (e) { /* ignore */ }
    window.__benchHost = { contractVersion: 1, seed: 1, params: { rooms: list }, clock: { now: () => 0 } };
  }, rooms);
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(LOBBY_URL);
  await page.evaluate(() => window.__bench.ready);
  return { context, page, errors };
}

test('renders one room card per room; coming-soon cards have no link', async () => {
  const { context, page, errors } = await openLobby();
  try {
    const cards = await page.$$eval('[data-bench="room-card"]', (els) => els.map((el) => ({
      status: el.getAttribute('data-status'),
      links: el.querySelectorAll('a[href]').length,
      href: el.querySelector('a[href]')?.getAttribute('href') ?? null
    })));
    assert.equal(cards.length, ROOMS.length);
    assert.deepEqual(cards.map((c) => c.status), ['open', 'coming_soon', 'open']);
    assert.equal(cards[1].links, 0);
    assert.equal(cards[0].href, '#/room/room-1');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('open room navigates to its route and browser Back returns to the lobby', async () => {
  const { context, page } = await openLobby();
  try {
    await page.click('[data-bench="room-card"] a[href="#/room/room-1"]');
    await page.waitForFunction(() => window.__bench.state().route === 'room-1');
    assert.equal(await page.textContent('[data-bench="hero-title"]'), ROOMS[0].title_ko);
    await page.goBack();
    await page.waitForFunction(() => window.__bench.state().route === 'lobby');
  } finally {
    await context.close();
  }
});

test('coming-soon room does not navigate', async () => {
  const { context, page } = await openLobby();
  try {
    await page.click('[data-bench="room-card"][data-status="coming_soon"] .card-title');
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => location.hash), '');
    assert.equal(await page.evaluate(() => window.__bench.state().route), 'lobby');
  } finally {
    await context.close();
  }
});

test('empty collection shows the empty state and no cards', async () => {
  const { context, page } = await openLobby({ rooms: [] });
  try {
    assert.equal(await page.$$eval('[data-bench="room-card"]', (els) => els.length), 0);
    assert.equal(await page.$eval('[data-bench="empty-state"]', (el) => el.hidden), false);
    assert.equal(await page.isVisible('[data-bench="empty-state"]'), true);
  } finally {
    await context.close();
  }
});

test('language toggle switches card titles and document language', async () => {
  const { context, page } = await openLobby();
  try {
    await page.click('[data-bench="lang-toggle"]');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    assert.equal(await page.evaluate(() => window.__bench.state().lang), 'en');
    const titles = await page.$$eval('[data-bench="room-card"] h3', (els) => els.map((h) => h.textContent));
    assert.equal(titles[0], ROOMS[0].title_en);
  } finally {
    await context.close();
  }
});

test('theme toggle changes the rendered theme', async () => {
  const { context, page } = await openLobby({ colorScheme: 'light' });
  try {
    assert.equal(await page.evaluate(() => window.__bench.state().theme), 'light');
    await page.click('[data-bench="theme-toggle"]');
    assert.equal(await page.evaluate(() => window.__bench.state().theme), 'dark');
  } finally {
    await context.close();
  }
});

test('reduced motion keeps the route transition at or under 100 ms', async () => {
  const { context, page } = await openLobby({ reducedMotion: 'reduce' });
  try {
    await page.click('[data-bench="room-card"] a[href="#/room/room-1"]');
    await page.waitForFunction(() => window.__bench.state().route === 'room-1');
    const ms = await page.$eval('#room-view', (el) => {
      const d = getComputedStyle(el).animationDuration.split(',')[0].trim();
      return d.endsWith('ms') ? parseFloat(d) : parseFloat(d) * 1000;
    });
    assert.ok(ms <= 100, `animation duration ${ms} ms`);
  } finally {
    await context.close();
  }
});

test('open room links are keyboard reachable and Enter opens the room', async () => {
  const { context, page } = await openLobby();
  try {
    await page.evaluate(() => document.activeElement?.blur());
    let reached = false;
    for (let i = 0; i < 60 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => document.activeElement?.getAttribute('href') === '#/room/room-1');
    }
    assert.ok(reached, 'room-1 link never received keyboard focus');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__bench.state().route === 'room-1');
  } finally {
    await context.close();
  }
});

test('no horizontal overflow on a 360 px phone with a long title', async () => {
  const { context, page } = await openLobby({ viewport: { width: 360, height: 780 } });
  try {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `overflows by ${overflow}px`);
  } finally {
    await context.close();
  }
});
