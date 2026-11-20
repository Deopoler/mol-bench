/** Probes for the generated lobby collection and Renovation language control. */
export async function probeLobbyData(page) {
  return page.evaluate(() => {
    const rooms = Array.isArray(window.__benchHost?.params?.rooms) ? window.__benchHost.params.rooms : [];
    const cards = [...document.querySelectorAll('[data-bench="room-card"]')];
    const rendered = cards.length === rooms.length && rooms.every((r) => cards.some((c) => c.textContent.includes(r.title_ko)));
    const long = rooms.every((r) => r.title_ko.length < 30 || [...document.querySelectorAll('[data-bench="room-card"] h3')].some((h) => h.textContent === r.title_ko && h.getBoundingClientRect().height > 0));
    const empty = document.querySelector('[data-bench="empty-state"]');
    const emptyPass = rooms.length ? empty?.hidden === true : Boolean(empty && !empty.hidden && getComputedStyle(empty).display !== 'none');
    return { metrics: {
      'data.rooms_rendered': { passed: rendered ? 1 : 0, total: 1 },
      'data.long_title': long,
      'data.empty_state': emptyPass,
    } };
  });
}

export async function probeLobbyLanguage(page) {
  const checks = await page.evaluate(async () => {
    const button = document.querySelector('[data-bench="lang-toggle"]');
    if (!button) return { passed: 0, total: 5 };
    button.focus();
    const keyboardReach = document.activeElement === button;
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    button.click();
    await Promise.resolve();
    const english = document.documentElement.lang === 'en' && window.__bench?.state?.().lang === 'en';
    const titles = [...(window.__benchHost?.params?.rooms || [])].every((r) => !r.title_en || [...document.querySelectorAll('[data-bench="room-card"] h3')].some((h) => h.textContent === r.title_en));
    const persisted = localStorage.getItem('mol-lang') === 'en';
    const noOverflow = document.documentElement.scrollWidth <= innerWidth;
    return { passed: [keyboardReach, english, titles, persisted, noOverflow].filter(Boolean).length, total: 5 };
  });
  return { metrics: { 'lang.toggle': checks } };
}
