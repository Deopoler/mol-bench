import { pixelSha256, pngMeanAbsDiff } from './shared.js';
import { probeAxe } from './a11y.js';

/**
 * Navigation & theme probes:
 * - nav.routes
 * - nav.transition_ms (CDP virtual time)
 * - theme.both_valid
 */

export async function probeNavRoutes(page, args = {}) {
  const cardSelector = args.cardSelector || '[data-bench="room-card"]';

  const cards = await page.evaluate((sel) => {
    const els = Array.from(document.querySelectorAll(sel));
    return els.map((el, idx) => {
      const link = el.matches('a[href]') ? el : el.querySelector('a[href]');
      const href = link ? link.getAttribute('href') : el.getAttribute('data-route');
      const status = el.getAttribute('data-status') || 'open';
      return { idx, href, status };
    });
  }, cardSelector);

  const navigable = cards.filter((c) => c.href && c.status !== 'coming_soon');
  if (navigable.length === 0) {
    return {
      'nav.routes': 0,
      details: { passed: 0, total: 0, results: [] },
    };
  }

  let passed = 0;
  const results = [];

  for (const card of navigable) {
    // Scroll card into view and record scrollY
    const before = await page.evaluate(([sel, idx]) => {
      const els = document.querySelectorAll(sel);
      const el = els[idx];
      if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' });
      return {
        scrollY: window.scrollY,
        href: window.location.href,
        hash: window.location.hash,
        route: window.__bench?.state?.()?.route ?? null,
      };
    }, [cardSelector, card.idx]);

    // Click the card link (or card itself)
    const clicked = await page.evaluate(([sel, idx]) => {
      const els = document.querySelectorAll(sel);
      const el = els[idx];
      if (!el) return false;
      const link = el.matches('a[href]') ? el : el.querySelector('a[href]');
      const target = link || el;
      target.click();
      return true;
    }, [cardSelector, card.idx]);

    if (!clicked) {
      results.push({ idx: card.idx, pass: false, reason: 'card not found' });
      continue;
    }

    await page.waitForTimeout(80);

    const after = await page.evaluate(() => ({
      hash: window.location.hash,
      pathname: window.location.pathname,
      href: window.location.href,
      route: window.__bench?.state?.()?.route ?? null,
    }));

    // Expected room id or route
    const expectedHref = card.href;
    const expectedId = expectedHref.replace(/^#\/room\//, '').replace(/^#\/?/, '').replace(/^\/+/, '');
    const urlMatches =
      after.hash === expectedHref ||
      after.pathname === expectedHref ||
      after.href.endsWith(expectedHref);
    const stateMatches =
      after.route === expectedId ||
      after.route === expectedHref ||
      (typeof after.route === 'string' && expectedHref.endsWith(after.route));

    // Browser Back returns to lobby with scroll position within 50 px
    await page.goBack().catch(() => {});
    await page.waitForTimeout(80);

    const back = await page.evaluate(() => ({
      scrollY: window.scrollY,
      hash: window.location.hash,
      route: window.__bench?.state?.()?.route ?? null,
    }));

    const backRouteOk = back.route === before.route || back.hash === before.hash || back.route === 'lobby';
    const backScrollOk = Math.abs(back.scrollY - before.scrollY) <= 50;
    const ok = urlMatches && stateMatches && backRouteOk && backScrollOk;
    if (ok) passed += 1;

    results.push({
      idx: card.idx,
      href: expectedHref,
      pass: ok,
      urlMatches,
      stateMatches,
      backRouteOk,
      backScrollOk,
      scrollDelta: Math.abs(back.scrollY - before.scrollY),
    });
  }

  return {
    'nav.routes': passed / navigable.length,
    details: { passed, total: navigable.length, results },
  };
}

/**
 * Measure nav.transition_ms using CDP virtual time.
 * Activate a card at t0, capture frames every 16 ms; transition ends at the first frame
 * after which 5 consecutive frames have diff < 0.002 against each other.
 */
export async function probeNavTransitionMs(pageHandle, args = {}) {
  const { page, cdp } = pageHandle;
  const stepMs = Number(args.stepMs || 16);
  const maxMs = Number(args.maxMs || 1500);
  const threshold = Number(args.threshold || 0.002);
  const stableRequired = Number(args.stableFrames || 5);
  const triggerSelector = args.triggerSelector || '[data-bench="room-card"] a[href], [data-bench="room-card"]';

  // Ensure a trigger exists
  const hasTrigger = await page.evaluate((sel) => Boolean(document.querySelector(sel)), triggerSelector);
  if (!hasTrigger) {
    return {
      'nav.transition_ms': 0,
      details: { triggered: false, framesCaptured: 0 },
    };
  }

  const initialUrl = page.url();
  let transitionMs = 0;
  let framesCaptured = 0;
  let settled = false;

  try {
    // Ensure any prior animations (e.g., from probeNavRoutes goBack) are settled before t0
    await page.evaluate(() => {
      for (const a of document.getAnimations()) {
        try { a.finish(); } catch { /* ignore */ }
      }
    });

    await cdp.send('Animation.enable');
    // Freeze CSS transitions/animations via CDP Animation domain so stepping is 100% deterministic
    // and never races wall clock during screenshot readback.
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 });
    await pageHandle.installRafOverride();

    // Capture t0 frame right before activating card
    let prevFrame = await pageHandle.screenshotCdp();
    framesCaptured = 1;

    // Activate card at t0, wait one macrotask so async hashchange/router handlers spawn
    // their CSS transitions while playbackRate=0 holds them frozen at t=0.
    const clickDiag = await page.evaluate(async (sel) => {
      window.__benchAnimBorn = new WeakMap();
      const el = document.querySelector(sel);
      const target = el ? (el.matches('a[href], button') ? el : (el.querySelector('a[href], button') || el)) : null;
      const beforeHash = location.hash;
      if (target) target.click();
      await new Promise((r) => setTimeout(r, 0));
      const anims = document.getAnimations();
      for (const a of anims) {
        a.pause();
        a.currentTime = 0;
        window.__benchAnimBorn.set(a, 0);
      }
      return {
        beforeHash,
        afterHash: location.hash,
        animsAfterClick: anims.length,
        scrollY: window.scrollY,
        reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      };
    }, triggerSelector);

    let consecutiveStable = 0;
    let candidateEndMs = 0;
    let elapsedMs = 0;
    const sampleDiffs = [];

    while (elapsedMs < maxMs) {
      elapsedMs += stepMs;

      // Advance both rAF-driven JS transitions and CSS/Web Animations by exactly stepMs
      await pageHandle.stepRafVirtual(stepMs, 1000 / stepMs);
      await page.evaluate(([ms, dt]) => {
        if (!window.__benchAnimBorn) window.__benchAnimBorn = new WeakMap();
        for (const a of document.getAnimations()) {
          if (!window.__benchAnimBorn.has(a)) {
            a.pause();
            window.__benchAnimBorn.set(a, ms - dt);
          }
          a.currentTime = ms - window.__benchAnimBorn.get(a);
        }
      }, [elapsedMs, stepMs]);

      const frame = await pageHandle.screenshotCdp();
      framesCaptured += 1;
      const diff = pngMeanAbsDiff(prevFrame, frame);
      if (sampleDiffs.length < 12) sampleDiffs.push(Number(diff.toFixed(6)));
      prevFrame = frame;

      if (diff < threshold) {
        if (consecutiveStable === 0) {
          candidateEndMs = elapsedMs - stepMs;
        }
        consecutiveStable += 1;
        if (consecutiveStable >= stableRequired) {
          transitionMs = candidateEndMs;
          settled = true;
          break;
        }
      } else {
        consecutiveStable = 0;
      }
    }

    if (!settled) {
      transitionMs = elapsedMs;
    }
    return {
      'nav.transition_ms': transitionMs,
      details: {
        triggered: true,
        settled,
        framesCaptured,
        stepMs,
        clickDiag,
        sampleDiffs,
      },
    };
  } finally {
    await pageHandle.uninstallRafOverride().catch(() => {});
    await page.evaluate(() => {
      for (const a of document.getAnimations()) {
        try { a.play(); } catch { /* ignore */ }
      }
      delete window.__benchAnimBorn;
    }).catch(() => {});
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 }).catch(() => {});
    // Navigate back if URL changed
    if (page.url() !== initialUrl) {
      await page.goBack().catch(() => {});
      await page.waitForTimeout(50);
    }
  }
}

/**
 * Measure theme.both_valid:
 * Pass if renders under prefers-color-scheme: dark and light differ (SHA-256)
 * AND both have 0 axe color-contrast violations.
 */
export async function probeThemeBothValid(pageHandle) {
  const { page } = pageHandle;

  // Light scheme
  await pageHandle.emulate({ colorScheme: 'light' });
  await pageHandle.renderFrame().catch(() => {});
  const lightPng = await pageHandle.screenshot();
  const lightHash = pixelSha256(lightPng);
  const lightAxe = await probeAxe(page);

  // Dark scheme
  await pageHandle.emulate({ colorScheme: 'dark' });
  await pageHandle.renderFrame().catch(() => {});
  const darkPng = await pageHandle.screenshot();
  const darkHash = pixelSha256(darkPng);
  const darkAxe = await probeAxe(page);

  const differs = lightHash !== darkHash;
  const lightOk = lightAxe.colorContrastViolations === 0;
  const darkOk = darkAxe.colorContrastViolations === 0;
  const pass = differs && lightOk && darkOk;

  return {
    'theme.both_valid': pass,
    details: {
      differs,
      lightHash,
      darkHash,
      lightContrastViolations: lightAxe.colorContrastViolations,
      darkContrastViolations: darkAxe.colorContrastViolations,
    },
  };
}
