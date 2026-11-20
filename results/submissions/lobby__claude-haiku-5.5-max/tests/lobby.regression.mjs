// Regression tests for lobby/index.html.
// Run from the repository root:  node --test tests/lobby.regression.mjs
// Uses the Playwright Chromium bundled in node_modules and a host-injected room list (no network).
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '0';

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = pathToFileURL(path.join(here, '..', 'lobby', 'index.html')).href;

function room(id, overrides = {}) {
  return {
    id,
    route: `#/room/${id}`,
    title_ko: `${id} 한국어 제목`,
    title_en: `${id} English title`,
    summary_ko: '빛과 기억이 포개지는 작은 전시를 천천히 거닐어 보세요.',
    accent_oklch: [0.68, 0.12, 200],
    status: 'open',
    ...overrides,
  };
}

const FIXTURE = [
  room('room-1'),
  room('room-2', { status: 'coming_soon' }),
  room('room-3'),
  room('room-4'),
  room('room-5'),
  room('room-6'),
];

const LONG_TITLE_ROOM = room('room-long', {
  title_ko: '빛의 기억이 머무는 아주 긴 복도에서 만나는 서른여덟 글자의 긴 이야기를 다시 천천히 읽어요',
  title_en: 'A Quiet Museum of Light for Curious Visitors Everywhere Today',
});

let chromium;
let browser;

before(async () => {
  ({ chromium } = await import('playwright'));
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

async function openLobby({ rooms = FIXTURE, viewport = { width: 1440, height: 900 }, colorScheme = 'light', reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport, colorScheme, reducedMotion, locale: 'en-US' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.addInitScript((params) => {
    window.__benchHost = Object.freeze({ contractVersion: 1, seed: 1, params: Object.freeze({ rooms: params }) });
  }, rooms);
  await page.goto(pageUrl, { waitUntil: 'load' });
  await page.evaluate(() => window.__bench.ready);
  return { context, page, errors };
}

test('required data-bench landmarks exist exactly once', async () => {
  const { context, page } = await openLobby();
  try {
    const counts = await page.evaluate(() => Object.fromEntries(
      ['header', 'hero-title', 'body', 'footer', 'empty-state', 'lang-toggle', 'theme-toggle'].map((name) => [
        name,
        document.querySelectorAll(`[data-bench="${name}"]`).length,
      ]),
    ));
    assert.equal(counts.header, 1);
    assert.equal(counts['hero-title'], 1);
    assert.ok(counts.body >= 1);
    assert.equal(counts.footer, 1);
    assert.equal(counts['empty-state'], 1);
    assert.equal(counts['lang-toggle'], 1);
    assert.equal(counts['theme-toggle'], 1);
    assert.equal(await page.evaluate(() => document.querySelector('[data-bench="hero-title"]').tagName), 'H1');
  } finally {
    await context.close();
  }
});

test('renders one room-card per room; open rooms link to their route, coming-soon rooms do not', async () => {
  const { context, page, errors } = await openLobby();
  try {
    const cards = await page.evaluate(() => [...document.querySelectorAll('[data-bench="room-card"]')].map((c) => ({
      status: c.dataset.status,
      h3: c.querySelector('h3')?.textContent ?? null,
      href: c.querySelector('a')?.getAttribute('href') ?? null,
    })));
    assert.equal(cards.length, FIXTURE.length);
    assert.deepEqual(cards.map((c) => c.status), ['open', 'coming_soon', 'open', 'open', 'open', 'open']);
    assert.equal(cards[0].h3, 'room-1 한국어 제목');
    assert.equal(cards[0].href, '#/room/room-1');
    assert.equal(cards[1].href, null, 'coming-soon card must not contain a link');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('empty collection shows the empty state and no cards', async () => {
  const { context, page } = await openLobby({ rooms: [] });
  try {
    const state = await page.evaluate(() => ({
      cards: document.querySelectorAll('[data-bench="room-card"]').length,
      emptyVisible: !document.querySelector('[data-bench="empty-state"]').hidden,
    }));
    assert.equal(state.cards, 0);
    assert.equal(state.emptyVisible, true);
  } finally {
    await context.close();
  }
});

test('coming-soon room click does not change the route', async () => {
  const { context, page } = await openLobby();
  try {
    await page.locator('[data-bench="room-card"]').nth(1).click();
    assert.equal(await page.evaluate(() => window.__bench.state().route), 'lobby');
    assert.equal(await page.evaluate(() => location.hash), '');
  } finally {
    await context.close();
  }
});

test('opening a room and going back restores the lobby and its scroll position', async () => {
  const { context, page } = await openLobby();
  try {
    await page.evaluate(() => window.scrollTo(0, 500));
    const before = await page.evaluate(() => scrollY);
    await page.locator('[data-bench="room-card"] a').first().click();
    assert.equal(await page.evaluate(() => window.__bench.state().route), 'room-1');
    assert.equal(await page.evaluate(() => scrollY), before, 'opening a room must not scroll the lobby');
    await page.goBack();
    assert.equal(await page.evaluate(() => window.__bench.state().route), 'lobby');
    assert.ok(Math.abs((await page.evaluate(() => scrollY)) - before) <= 50);
  } finally {
    await context.close();
  }
});

test('Escape closes an open room', async () => {
  const { context, page } = await openLobby();
  try {
    await page.evaluate(() => { location.hash = '#/room/room-3'; });
    await page.waitForFunction(() => window.__bench.state().route === 'room-3');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__bench.state().route === 'lobby');
    assert.equal(await page.evaluate(() => location.hash), '#/');
  } finally {
    await context.close();
  }
});

test('language toggle switches titles to English and persists the choice', async () => {
  const { context, page } = await openLobby();
  try {
    await page.locator('[data-bench="lang-toggle"]').focus();
    await page.keyboard.press('Enter');
    const state = await page.evaluate(() => ({
      lang: window.__bench.state().lang,
      htmlLang: document.documentElement.lang,
      h3: document.querySelector('[data-bench="room-card"] h3').textContent,
      stored: localStorage.getItem('mol-lang'),
    }));
    assert.equal(state.lang, 'en');
    assert.equal(state.htmlLang, 'en');
    assert.equal(state.h3, 'room-1 English title');
    assert.equal(state.stored, 'en');
    await page.reload({ waitUntil: 'load' });
    await page.evaluate(() => window.__bench.ready);
    assert.equal(await page.evaluate(() => window.__bench.state().lang), 'en');
  } finally {
    await context.close();
  }
});

test('theme toggle flips the rendered theme', async () => {
  const { context, page } = await openLobby();
  try {
    const before = await page.evaluate(() => window.__bench.state().theme);
    await page.locator('[data-bench="theme-toggle"]').click();
    const after = await page.evaluate(() => window.__bench.state().theme);
    assert.notEqual(before, after);
    assert.equal(await page.locator('[data-bench="theme-toggle"]').getAttribute('aria-pressed'), after === 'dark' ? 'true' : 'false');
  } finally {
    await context.close();
  }
});

test('reduced motion: opening a room runs no animation', async () => {
  const { context, page } = await openLobby({ reducedMotion: 'reduce' });
  try {
    await page.locator('[data-bench="room-card"] a').first().click();
    const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);
    assert.equal(running, 0);
  } finally {
    await context.close();
  }
});

test('no horizontal overflow at phone width with a long title', async () => {
  const { context, page } = await openLobby({ rooms: [LONG_TITLE_ROOM, ...FIXTURE], viewport: { width: 360, height: 780 } });
  try {
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth }));
    assert.ok(scrollWidth <= innerWidth, `scrollWidth ${scrollWidth} > innerWidth ${innerWidth}`);
    const h3 = await page.evaluate(() => document.querySelector('[data-bench="room-card"] h3').textContent);
    assert.equal(h3, LONG_TITLE_ROOM.title_ko);
  } finally {
    await context.close();
  }
});

test('room links are keyboard reachable in document order', async () => {
  const { context, page } = await openLobby();
  try {
    const reached = new Set();
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press('Tab');
      const id = await page.evaluate(() => document.activeElement?.closest?.('[data-room-id]')?.getAttribute('data-room-id') ?? null);
      if (id) reached.add(id);
    }
    assert.ok(reached.has('room-1') && reached.has('room-3') && reached.has('room-6'));
    assert.ok(!reached.has('room-2'), 'coming-soon room must not take focus');
  } finally {
    await context.close();
  }
});
