// Regression checks for renovation r1 (L-R1 narrow phones, L-R2 language switch, L-R3 serif hero, L-R4 3D preview).
// Run: node --test tests/lobby-r1.test.mjs   (needs the playwright chromium already used by `npm run selfcheck`)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

// Same room shape as bench/rooms/lobby.mjs (public generator). Includes a long English title.
const ROOMS = [
  { id: "room-1", route: "#/room/room-1", title_ko: "고요한 빛의 정원", title_en: "A Garden of Quiet Light", summary_ko: "빛과 기억이 포개지는 작은 전시를 천천히 거닐어 보세요. 새로운 시선으로 익숙한 풍경을 만납니다.", accent_oklch: [0.68, 0.12, 120], status: "open" },
  { id: "room-2", route: "#/room/room-2", title_ko: "기억을 수집하는 방", title_en: "A Quiet Museum of Light for Curious Visitors Everywhere Today", summary_ko: "조용한 관찰과 발견을 위한 공간입니다. 머무는 동안 각자의 이야기를 발견해 보세요.", accent_oklch: [0.68, 0.12, 250], status: "open" },
  { id: "room-3", route: "#/room/room-3", title_ko: "작은 파도의 기록", title_en: "Notes from a Small Wave", summary_ko: "조용한 관찰과 발견을 위한 공간입니다. 머무는 동안 각자의 이야기를 발견해 보세요.", accent_oklch: [0.68, 0.12, 30], status: "open" },
];

// Injected before any room script, like the harness does. Clock is controlled by window.__T.
function hostInit(rooms) {
  return `window.__T = 0;
  window.__benchHost = { contractVersion: 1, seed: 1, params: { rooms: ${JSON.stringify(rooms)} },
    clock: { now: () => window.__T }, rng: { next: () => 0.5, int: (n) => 0, fork() { return this; } } };`;
}

let server, base, browser, chromium;

before(async () => {
  // Same browser lookup as bench/capture/browser.mjs (the harness-installed Chromium).
  if (process.env.PLAYWRIGHT_BROWSERS_PATH === undefined) process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
  ({ chromium } = await import("playwright"));
  server = http.createServer((req, res) => {
    let p = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, ""));
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
    if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[path.extname(p)] || "application/octet-stream" });
    fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r) ?? r());
});

async function openPage({ width = 1440, height = 900, locale = "ko-KR", scheme = "light", rooms = ROOMS, storage = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale, colorScheme: scheme, deviceScaleFactor: 1 });
  await ctx.addInitScript(hostInit(rooms));
  if (storage) await ctx.addInitScript((s) => { localStorage.setItem("mol-lang", s); }, storage);
  const page = await ctx.newPage();
  await page.goto(base + "lobby/");
  await page.evaluate(() => window.__bench.ready);
  return { ctx, page };
}

test("L-R1: no sideways overflow and all tap targets >= 44px at 320x640 (both schemes)", async () => {
  for (const scheme of ["light", "dark"]) {
    const { ctx, page } = await openPage({ width: 320, height: 640, scheme });
    const res = await page.evaluate(() => {
      const overflow = document.documentElement.scrollWidth > window.innerWidth ? 1 : 0;
      const small = [...document.querySelectorAll("a, button")].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44);
      }).map((el) => el.textContent.trim() || el.id || el.className);
      return { overflow, small };
    });
    assert.equal(res.overflow, 0, `horizontal overflow (${scheme})`);
    // Room cards are large links; only header controls and nav links are measured as small targets.
    assert.deepEqual(res.small, [], `small tap targets (${scheme})`);
    await ctx.close();
  }
});

test("L-R2: first visit follows navigator.language, choice persists across reload", async () => {
  let { ctx, page } = await openPage({ locale: "en-US" });
  assert.equal(await page.evaluate(() => document.documentElement.lang), "en");
  assert.equal(await page.evaluate(() => window.__bench.state().lang), "en");
  await ctx.close();

  ({ ctx, page } = await openPage({ locale: "ko-KR" }));
  assert.equal(await page.evaluate(() => document.documentElement.lang), "ko");
  await page.focus('[data-bench="lang-toggle"]');
  await page.keyboard.press("Enter"); // keyboard operable
  assert.equal(await page.evaluate(() => document.documentElement.lang), "en");
  const titles = await page.$$eval('[data-bench="room-card"] h3', (hs) => hs.map((h) => h.textContent));
  assert.deepEqual(titles, ROOMS.map((r) => r.title_en));
  await page.reload();
  await page.evaluate(() => window.__bench.ready);
  assert.equal(await page.evaluate(() => window.__bench.state().lang), "en", "choice should persist after reload");
  await ctx.close();
});

test("L-R2: English long title does not overflow at 320 and 1440 wide", async () => {
  for (const width of [320, 1440]) {
    const { ctx, page } = await openPage({ width, height: 900, locale: "ko-KR", storage: "en" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `overflow at ${width}`);
    await ctx.close();
  }
});

test("L-R3: hero title is serif and nothing else's typeface changes", async () => {
  const { ctx, page } = await openPage();
  const family = await page.$eval('[data-bench="hero-title"]', (el) => getComputedStyle(el).fontFamily);
  assert.match(family, /serif/i);
  const bodyFamily = await page.$eval('[data-bench="body"]', (el) => getComputedStyle(el).fontFamily);
  assert.doesNotMatch(bodyFamily, /Batang|Georgia|Times/);
  await ctx.close();
});

test("L-R4: 3D prism pose is a pure function of the clock (seek + renderFrame)", async () => {
  const { ctx, page } = await openPage();
  const pose = () => page.$eval('[data-bench="room-card"] .prism', (el) => el.style.transform);
  await page.evaluate(() => { window.__bench.seek(1234); });
  await page.evaluate(() => window.__bench.renderFrame());
  const a = await pose();
  await page.evaluate(() => { window.__bench.seek(5000); });
  await page.evaluate(() => window.__bench.renderFrame());
  const b = await pose();
  await page.evaluate(() => { window.__bench.seek(1234); });
  await page.evaluate(() => window.__bench.renderFrame());
  const c = await pose();
  assert.ok(a.length > 0 && a !== b, "pose should change with time");
  assert.equal(a, c, "same time gives same pose");
  const count = await page.$$eval('[data-bench="room-card"] .prism', (els) => els.length);
  assert.equal(count, ROOMS.length, "every room card has a preview");
  await ctx.close();
});
