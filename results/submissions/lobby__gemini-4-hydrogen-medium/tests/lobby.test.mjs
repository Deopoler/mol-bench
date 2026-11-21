import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const LOBBY_DIR = path.resolve('lobby');

function startStaticServer() {
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };
  const server = http.createServer((req, res) => {
    const reqPath = (req.url || '/').split('?')[0];
    const rel = reqPath === '/' || reqPath === '/lobby/' ? 'index.html' : reqPath.replace(/^\/lobby\//, '').replace(/^\/+/, '');
    const filePath = path.join(LOBBY_DIR, rel);
    if (!filePath.startsWith(LOBBY_DIR) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}/index.html` });
    });
  });
}

function injectHost(rooms) {
  window.__benchHost = {
    contractVersion: 1,
    seed: 1,
    params: { rooms },
    clock: { now: () => 0 },
    rng: { next: () => 0.5, int: (n) => 0, fork: () => window.__benchHost.rng },
  };
}

const SAMPLE_ROOMS = [
  {
    id: 'room-1',
    route: '#/room/room-1',
    title_ko: '고요한 빛의 정원',
    title_en: 'A Garden of Quiet Light',
    summary_ko: '빛과 기억이 포개지는 작은 전시를 천천히 거닐어 보세요.',
    accent_oklch: [0.68, 0.12, 155],
    status: 'open',
  },
  {
    id: 'room-2',
    route: '#/room/room-2',
    title_ko: '기억을 수집하는 방',
    title_en: 'Rooms That Gather Memory',
    summary_ko: '조용한 관찰과 발견을 위한 공간입니다.',
    accent_oklch: [0.68, 0.12, 220],
    status: 'coming_soon',
  },
];

test('lobby renders rooms, handles coming_soon, empty state, language, theme, and routes', async () => {
  const { server, url } = await startStaticServer();
  const localChrome = path.resolve('node_modules/playwright-core/.local-browsers/chromium-1194/chrome-win/chrome.exe');
  const launchOpts = fs.existsSync(localChrome) ? { executablePath: localChrome } : {};
  const browser = await chromium.launch(launchOpts);
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(injectHost, SAMPLE_ROOMS);
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.evaluate(() => window.__bench.ready);

    // Landmarks
    for (const landmark of ['header', 'hero-title', 'body', 'footer', 'empty-state']) {
      assert.ok(await page.locator(`[data-bench="${landmark}"]`).count() >= 1, `missing ${landmark}`);
    }

    // Room cards & coming_soon distinction
    const cards = page.locator('[data-bench="room-card"]');
    assert.equal(await cards.count(), 2);
    assert.equal(await cards.nth(0).locator('a[href="#/room/room-1"]').count(), 1);
    assert.equal(await cards.nth(1).locator('a[href]').count(), 0);
    assert.equal(await cards.nth(1).getAttribute('data-status'), 'coming_soon');

    // Empty state hidden when rooms exist
    assert.equal(await page.locator('[data-bench="empty-state"]').isHidden(), true);

    // Language toggle switches to English titles
    await page.locator('[data-bench="lang-toggle"]').click();
    assert.equal(await page.evaluate(() => window.__bench.state().lang), 'en');
    assert.equal(await cards.nth(0).locator('h3').textContent(), 'A Garden of Quiet Light');

    // Theme toggle switches theme
    const themeBefore = await page.evaluate(() => window.__bench.state().theme);
    await page.locator('[data-bench="theme-toggle"]').click();
    const themeAfter = await page.evaluate(() => window.__bench.state().theme);
    assert.notEqual(themeBefore, themeAfter);

    // Navigation to open room and back
    await cards.nth(0).locator('a').click();
    assert.equal(await page.evaluate(() => window.__bench.state().route), 'room-1');
    await page.goBack();
    assert.equal(await page.evaluate(() => window.__bench.state().route), 'lobby');

    // Empty collection state
    const pageEmpty = await context.newPage();
    await pageEmpty.addInitScript(injectHost, []);
    await pageEmpty.goto(url, { waitUntil: 'networkidle' });
    await pageEmpty.evaluate(() => window.__bench.ready);
    assert.equal(await pageEmpty.locator('[data-bench="room-card"]').count(), 0);
    assert.equal(await pageEmpty.locator('[data-bench="empty-state"]').isVisible(), true);
  } finally {
    await browser.close();
    server.close();
  }
});
