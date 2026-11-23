/**
 * Scripted 10-checkpoint interactive flow probe for `lobby` v0.2:
 * - interact.scripted_flow:
 *   1. Search filters visible room cards
 *   2. Category chip actually filters room cards (count < initialCount)
 *   3. Sort by duration reorders room cards monotonically
 *   4. Keyboard Tab reaches 3rd visible room card
 *   5. Enter opens detail drawer
 *   6. Tab cycles multiple elements and wraps inside detail drawer (focus trap)
 *   7. Escape closes drawer & restores focus to exact 3rd card
 *   8. Enter Room navigates to room route & updates __bench.state().route
 *   9. Browser Back restores lobby, active filter/sort state, and scroll (+/- 50 px)
 *  10. Page reload preserves filter/sort/lang state
 */

export const probeName = 'flow';
export const aliases = ['interact.scripted_flow'];

async function settleFlow(pageHandle, page, budgetMs = 120) {
  if (pageHandle && typeof pageHandle.virtualTimeAdvance === 'function') {
    try {
      await pageHandle.virtualTimeAdvance(budgetMs);
    } catch {
      // ignore if virtual time unavailable
    } finally {
      if (typeof pageHandle.virtualTimeResume === 'function') {
        await pageHandle.virtualTimeResume().catch(() => {});
      }
    }
  }
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        queueMicrotask(resolve);
      });
    });
  }));
}

export async function runProbe(pageHandle, args = {}) {
  const { page } = pageHandle;
  const checkpoints = [];
  const record = (id, pass, detail = '') => {
    checkpoints.push({ id, pass: Boolean(pass), detail });
  };

  const countVisibleCards = () =>
    page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[data-bench="room-card"]'));
      return cards.filter((el) => {
        const st = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return !el.hidden && st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      }).length;
    });

  // ---- 1. Search input ----
  let initialCount = await countVisibleCards();
  let searchPass = false;
  try {
    const searchExists = await page.evaluate(() => Boolean(document.querySelector('[data-bench="search-input"]')));
    if (searchExists && initialCount >= 2) {
      const query = await page.evaluate((explicitQuery) => {
        if (explicitQuery) return explicitQuery;
        const rooms = window.__benchHost?.params?.rooms || [];
        if (rooms.length >= 2) {
          const lang = window.__bench?.state?.()?.lang || document.documentElement.lang || 'ko';
          const title = rooms[0][`title_${lang}`] || rooms[0].title_ko || rooms[0].title_en || '';
          return title.trim().slice(0, Math.min(8, title.trim().length));
        }
        const firstCard = document.querySelector('[data-bench="room-card"]');
        const txt = (firstCard?.textContent || '').trim();
        return txt.slice(0, Math.min(6, txt.length));
      }, args.searchQuery || null);

      if (query) {
        const input = page.locator('[data-bench="search-input"]').first();
        await input.fill(query);
        await settleFlow(pageHandle, page);
        const filtered = await countVisibleCards();
        searchPass = filtered >= 1 && filtered < initialCount;
        await input.fill('');
        await settleFlow(pageHandle, page);
      }
    }
  } catch {
    searchPass = false;
  }
  record('search_filter', searchPass, `initial=${initialCount}`);

  // ---- 2. Category chip ----
  let categoryPass = false;
  let chosenCat = null;
  try {
    const catInfo = await page.evaluate(() => {
      const bar = document.querySelector('[data-bench="filter-bar"]');
      if (!bar) return null;
      const buttons = Array.from(bar.querySelectorAll('button, [role="button"], input[type="radio"], a'));
      const nonAll = buttons.filter((b) => {
        const val = (b.getAttribute('data-category') || b.getAttribute('data-filter') || b.value || b.textContent || '').trim().toLowerCase();
        return val && val !== 'all' && val !== '전체' && val !== 'すべて';
      });
      if (nonAll.length === 0) return null;

      // Prefer a category that keeps >= 3 open cards so subsequent Tab-to-3rd-card works smoothly
      const rooms = window.__benchHost?.params?.rooms || [];
      let bestIdx = 0;
      let bestCount = -1;
      nonAll.forEach((btn, idx) => {
        const cat = (btn.getAttribute('data-category') || btn.getAttribute('data-filter') || btn.value || btn.textContent || '').trim().toLowerCase();
        const cnt = rooms.filter((r) => String(r.category || '').toLowerCase() === cat).length;
        if (cnt >= 3 && (bestCount < 3 || cnt < bestCount)) {
          bestIdx = idx;
          bestCount = cnt;
        } else if (bestCount < 0) {
          bestIdx = idx;
          bestCount = cnt;
        }
      });

      const target = nonAll[bestIdx];
      target.setAttribute('data-bench-flow-cat', '1');
      return {
        category: (target.getAttribute('data-category') || target.getAttribute('data-filter') || target.value || target.textContent || '').trim(),
      };
    });

    if (catInfo) {
      chosenCat = catInfo.category;
      await page.locator('[data-bench-flow-cat="1"]').first().click();
      await settleFlow(pageHandle, page);
      const afterCat = await countVisibleCards();
      categoryPass = afterCat >= 1 && afterCat < initialCount;
      // If fewer than 3 cards remain for checkpoint 4, reset to "all" only after verifying filter worked.
      if (afterCat < 3) {
        await page.evaluate(() => {
          const bar = document.querySelector('[data-bench="filter-bar"]');
          const allBtn = bar?.querySelector('[data-category="all"], [data-filter="all"], button');
          allBtn?.click();
        });
        await settleFlow(pageHandle, page);
      }
    }
  } catch {
    categoryPass = false;
  }
  record('category_chip', categoryPass, `category=${chosenCat}`);

  // ---- 3. Sort by duration ----
  let sortPass = false;
  try {
    const sortSel = page.locator('[data-bench="sort-select"]').first();
    const hasSort = (await sortSel.count()) > 0;
    if (hasSort) {
      await sortSel.selectOption('duration');
      await settleFlow(pageHandle, page);
      sortPass = await page.evaluate(() => {
        const sel = document.querySelector('[data-bench="sort-select"]');
        if (!sel || sel.value !== 'duration') return false;
        const rooms = window.__benchHost?.params?.rooms || [];
        const byId = new Map(rooms.map((r) => [r.id, Number(r.duration_min)]));
        const cards = Array.from(document.querySelectorAll('[data-bench="room-card"]')).filter((el) => {
          const st = getComputedStyle(el);
          return !el.hidden && st.display !== 'none';
        });
        if (cards.length < 2) return true;
        const durations = cards
          .map((c) => {
            const rid = c.getAttribute('data-room-id') || c.getAttribute('data-id') || '';
            if (byId.has(rid)) return byId.get(rid);
            const href = c.querySelector('a[href]')?.getAttribute('href') || '';
            const m = href.match(/\/([^/]+)$/);
            if (m && byId.has(m[1])) return byId.get(m[1]);
            const attrDur = c.getAttribute('data-duration');
            return attrDur !== null ? Number(attrDur) : NaN;
          })
          .filter((n) => Number.isFinite(n));

        if (durations.length < 2) return false;
        let nonDec = true;
        let nonInc = true;
        for (let i = 1; i < durations.length; i++) {
          if (durations[i] < durations[i - 1]) nonDec = false;
          if (durations[i] > durations[i - 1]) nonInc = false;
        }
        return nonDec || nonInc;
      });
    }
  } catch {
    sortPass = false;
  }
  record('sort_duration', sortPass);

  // ---- 4. Keyboard Tab to 3rd visible card ----
  let tabThirdPass = false;
  try {
    const readyForTab = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[data-bench="room-card"]')).filter((el) => {
        const st = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return !el.hidden && st.display !== 'none' && r.width > 0 && r.height > 0;
      });
      if (cards.length < 3) return false;
      cards[2].setAttribute('data-bench-flow-third', '1');
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
      window.scrollTo(0, 0);
      return true;
    });

    if (readyForTab) {
      for (let i = 0; i < 100; i++) {
        await page.keyboard.press('Tab');
        const hit = await page.evaluate(() => {
          const third = document.querySelector('[data-bench-flow-third="1"]');
          const active = document.activeElement;
          if (!third || !active) return false;
          if (active === third || third.contains(active)) {
            active.setAttribute('data-bench-flow-trigger', '1');
            return true;
          }
          return false;
        });
        if (hit) {
          tabThirdPass = true;
          break;
        }
      }
    }
  } catch {
    tabThirdPass = false;
  }
  record('tab_to_third_card', tabThirdPass);

  // ---- 5. Enter opens detail drawer ----
  let drawerOpenPass = false;
  const isDrawerVisible = () =>
    page.evaluate(() => {
      const d = document.querySelector('[data-bench="detail-drawer"]');
      if (!d) return false;
      if (d.hasAttribute('hidden') || d.getAttribute('aria-hidden') === 'true') return false;
      const st = getComputedStyle(d);
      if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) <= 0) return false;
      const r = d.getBoundingClientRect();
      return r.width > 10 && r.height > 10;
    });

  try {
    if (tabThirdPass) {
      await page.keyboard.press('Enter');
      await settleFlow(pageHandle, page);
      const open = await isDrawerVisible();
      const focusInside = await page.evaluate(() => {
        const d = document.querySelector('[data-bench="detail-drawer"]');
        return Boolean(d && document.activeElement && (d === document.activeElement || d.contains(document.activeElement)));
      });
      drawerOpenPass = open && focusInside;
    }
  } catch {
    drawerOpenPass = false;
  }
  record('enter_opens_drawer', drawerOpenPass);

  // ---- 6. Tab wraps inside drawer (focus trap) ----
  let trapPass = false;
  try {
    if (drawerOpenPass) {
      const visited = [];
      let stayedInside = true;
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press('Tab');
        const step = await page.evaluate(() => {
          const d = document.querySelector('[data-bench="detail-drawer"]');
          const a = document.activeElement;
          const inside = Boolean(d && a && (d === a || d.contains(a)));
          if (!inside) return { inside: false, tag: null };
          if (!a.dataset.benchFlowFocusId) {
            a.dataset.benchFlowFocusId = String(Math.random()).slice(2, 10);
          }
          return { inside: true, fid: a.dataset.benchFlowFocusId };
        });
        if (!step.inside) {
          stayedInside = false;
          break;
        }
        visited.push(step.fid);
      }
      const uniqueCount = new Set(visited).size;
      const wrapped = visited.length >= 2 && visited.slice(1).includes(visited[0]);
      trapPass = stayedInside && wrapped && uniqueCount >= 2;
    }
  } catch {
    trapPass = false;
  }
  record('drawer_focus_trap', trapPass);

  // ---- 7. Esc closes drawer & restores focus to exact 3rd card ----
  let escRestorePass = false;
  try {
    if (drawerOpenPass) {
      await page.keyboard.press('Escape');
      await settleFlow(pageHandle, page);
      const closed = !(await isDrawerVisible());
      const restored = await page.evaluate(() => {
        const third = document.querySelector('[data-bench-flow-third="1"]');
        const trigger = document.querySelector('[data-bench-flow-trigger="1"]');
        const a = document.activeElement;
        return Boolean(a && (a === trigger || a === third || (third && third.contains(a))));
      });
      escRestorePass = closed && restored;
    }
  } catch {
    escRestorePass = false;
  }
  record('esc_restores_focus', escRestorePass);

  // ---- 8. Enter Room navigates ----
  let navPass = false;
  let savedScrollY = 0;
  let savedSortVal = null;
  let savedVisibleCount = null;
  let savedLang = null;

  try {
    await page.evaluate(() => {
      const maxY = Math.max(0, (document.scrollingElement?.scrollHeight || 0) - window.innerHeight);
      window.scrollTo(0, Math.min(180, maxY));
    });
    const beforeState = await page.evaluate(() => ({
      scrollY: window.scrollY,
      sortVal: document.querySelector('[data-bench="sort-select"]')?.value ?? null,
      lang: window.__bench?.state?.()?.lang ?? document.documentElement.lang ?? null,
      url: window.location.href,
    }));
    savedScrollY = beforeState.scrollY;
    savedSortVal = beforeState.sortVal;
    savedLang = beforeState.lang;
    savedVisibleCount = await countVisibleCards();

    // Open drawer for first open room and click Enter Room link/button, or click open card link directly
    const clickedNav = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[data-bench="room-card"]')).filter((c) => {
        const st = getComputedStyle(c);
        return !c.hidden && st.display !== 'none' && c.getAttribute('data-status') !== 'coming_soon';
      });
      const openCard = cards[0];
      if (!openCard) return false;
      const enterLink = openCard.querySelector('[data-bench="enter-room"], a[href^="#/room/"], a[href], button, [role="button"]');
      if (enterLink) {
        enterLink.click();
        return true;
      }
      openCard.click();
      return true;
    });

    await settleFlow(pageHandle, page);
    if (clickedNav && (await isDrawerVisible())) {
      await page.evaluate(() => {
        const d = document.querySelector('[data-bench="detail-drawer"]');
        const btn = d?.querySelector('[data-bench="enter-room"], a[href^="#/room/"], a[href], button[data-route]');
        btn?.click();
      });
      await settleFlow(pageHandle, page);
    }

    const afterNav = await page.evaluate(() => ({
      url: window.location.href,
      hash: window.location.hash,
      route: window.__bench?.state?.()?.route ?? null,
    }));
    navPass =
      afterNav.url !== beforeState.url &&
      afterNav.route !== null &&
      afterNav.route !== 'lobby';
  } catch {
    navPass = false;
  }
  record('enter_room_navigates', navPass);

  // ---- 9. Back restores filter/sort/scroll ----
  let backPass = false;
  try {
    if (navPass) {
      await page.goBack();
      await settleFlow(pageHandle, page);
      const backState = await page.evaluate(() => ({
        scrollY: window.scrollY,
        route: window.__bench?.state?.()?.route ?? null,
        sortVal: document.querySelector('[data-bench="sort-select"]')?.value ?? null,
      }));
      const backCount = await countVisibleCards();
      const scrollOk = Math.abs(backState.scrollY - savedScrollY) <= 50;
      const routeOk = backState.route === 'lobby';
      const sortOk = savedSortVal === null || backState.sortVal === savedSortVal;
      const countOk = savedVisibleCount === null || backCount === savedVisibleCount;
      backPass = scrollOk && routeOk && sortOk && countOk;
    }
  } catch {
    backPass = false;
  }
  record('back_restores_state', backPass);

  // ---- 10. Reload preserves state ----
  let reloadPass = false;
  try {
    if (sortPass || categoryPass) {
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => Boolean(window.__bench && window.__bench.ready), null, { timeout: 10000 }).catch(() => {});
      await page.evaluate(() => Promise.resolve(window.__bench?.ready)).catch(() => {});
      await settleFlow(pageHandle, page);

      const reloadState = await page.evaluate(() => ({
        sortVal: document.querySelector('[data-bench="sort-select"]')?.value ?? null,
        lang: window.__bench?.state?.()?.lang ?? document.documentElement.lang ?? null,
        route: window.__bench?.state?.()?.route ?? null,
      }));
      const reloadCount = await countVisibleCards();
      const sortOk = savedSortVal === null || reloadState.sortVal === savedSortVal;
      const langOk = savedLang === null || reloadState.lang === savedLang;
      const countOk = savedVisibleCount === null || reloadCount === savedVisibleCount;
      reloadPass = sortOk && langOk && countOk && reloadState.route === 'lobby';
    }
  } catch {
    reloadPass = false;
  }
  record('reload_preserves_state', reloadPass);

  // Cleanup temp attributes
  await page.evaluate(() => {
    for (const attr of ['data-bench-flow-cat', 'data-bench-flow-third', 'data-bench-flow-trigger', 'data-bench-flow-focus-id']) {
      for (const el of document.querySelectorAll(`[${attr}]`)) {
        el.removeAttribute(attr);
      }
    }
  }).catch(() => {});

  const passed = checkpoints.filter((c) => c.pass).length;
  return {
    'interact.scripted_flow': passed / checkpoints.length,
    details: {
      passed,
      total: checkpoints.length,
      checkpoints,
    },
  };
}
