import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { probeLayout } from './layout.js';
import { probeText } from './text.js';
import { probeType } from './type.js';
import { probeSpaceAndAlign } from './space.js';
import { probeA11y, probeAxe, probeKeyboardReach, probeFocusVisible } from './a11y.js';
import { probeNavRoutes, probeNavTransitionMs, probeThemeBothValid } from './nav.js';
import { probeLobbyData, probeLobbyLanguage } from './lobby.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_SKIP_FILES = new Set([
  'index.js',
  'shared.js',
  'layout.js',
  'text.js',
  'type.js',
  'space.js',
  'a11y.js',
  'nav.js',
  'lobby.js',
]);

export {
  probeLayout,
  probeText,
  probeType,
  probeSpaceAndAlign,
  probeA11y,
  probeAxe,
  probeKeyboardReach,
  probeFocusVisible,
  probeNavRoutes,
  probeNavTransitionMs,
  probeThemeBothValid,
};

/**
 * Single source of truth for built-in v0.1 probe handlers (also drives listProbes()).
 */
const BUILTIN_HANDLERS = Object.freeze({
  layout: ({ page }, args) => probeLayout(page, args),
  'layout.overflow_count': ({ page }, args) => probeLayout(page, args),
  'layout.tap_targets': ({ page }, args) => probeLayout(page, args),

  text: ({ page }, args) => probeText(page, args),
  'text.clipped_count': ({ page }, args) => probeText(page, args),
  'text.hangul_midword_breaks': ({ page }, args) => probeText(page, args),
  'text.line_length': ({ page }, args) => probeText(page, args),
  'text.line_height': ({ page }, args) => probeText(page, args),

  type: ({ page, cdp }, args) => probeType(page, { ...args, checkHeroSerif: args.checkHeroSerif ?? false }, cdp),
  'type.size_steps': ({ page, cdp }, args) => probeType(page, { ...args, checkHeroSerif: args.checkHeroSerif ?? false }, cdp),
  'type.scale_ratio_min': ({ page, cdp }, args) => probeType(page, { ...args, checkHeroSerif: args.checkHeroSerif ?? false }, cdp),
  'type.hero_serif': ({ page, cdp }, args) => probeType(page, { ...args, checkHeroSerif: args.checkHeroSerif ?? true }, cdp),
  type_hero_serif: ({ page, cdp }, args) => probeType(page, { ...args, checkHeroSerif: args.checkHeroSerif ?? true }, cdp),

  space: ({ page }, args) => probeSpaceAndAlign(page, args),
  align: ({ page }, args) => probeSpaceAndAlign(page, args),
  'space.grid4_frac': ({ page }, args) => probeSpaceAndAlign(page, args),
  'align.column_count': ({ page }, args) => probeSpaceAndAlign(page, args),

  axe: ({ page }) => probeAxe(page),
  'a11y.axe_violations': ({ page }) => probeAxe(page),

  keyboard_reach: ({ page }, args) => probeKeyboardReach(page, args),
  'a11y.keyboard_reach': ({ page }, args) => probeKeyboardReach(page, args),

  focus_visible: ({ page }, args) => probeFocusVisible(page, args),
  'a11y.focus_visible': ({ page }, args) => probeFocusVisible(page, args),

  a11y: ({ page }, args) => probeA11y(page, args),

  nav_routes: ({ page }, args) => probeNavRoutes(page, args),
  'nav.routes': ({ page }, args) => probeNavRoutes(page, args),

  nav_transition: (pageHandle, args) => probeNavTransitionMs(pageHandle, args),
  'nav.transition_ms': (pageHandle, args) => probeNavTransitionMs(pageHandle, args),
  'a11y.reduced_motion_transition_ms': (pageHandle, args) => probeNavTransitionMs(pageHandle, args),

  nav: async (pageHandle, args) => {
    const routes = await probeNavRoutes(pageHandle.page, args);
    const trans = await probeNavTransitionMs(pageHandle, args);
    return {
      ...routes,
      ...trans,
      details: { routes: routes.details, transition: trans.details },
    };
  },

  theme: (pageHandle) => probeThemeBothValid(pageHandle),
  'theme.both_valid': (pageHandle) => probeThemeBothValid(pageHandle),

  data: ({ page }) => probeLobbyData(page),
  lang_toggle: ({ page }) => probeLobbyLanguage(page),

  all: async (pageHandle, args) => {
    const { page, cdp } = pageHandle;
    const layout = await probeLayout(page, args);
    const text = await probeText(page, args);
    const type = await probeType(page, args, cdp);
    const space = await probeSpaceAndAlign(page, args);
    const a11y = await probeA11y(page, args);
    const navRoutes = await probeNavRoutes(page, args);
    const navTrans = await probeNavTransitionMs(pageHandle, args);
    const theme = await probeThemeBothValid(pageHandle);
    return {
      'layout.overflow_count': layout['layout.overflow_count'],
      'layout.tap_targets': layout['layout.tap_targets'],
      'text.clipped_count': text['text.clipped_count'],
      'text.hangul_midword_breaks': text['text.hangul_midword_breaks'],
      'text.line_length': text['text.line_length'],
      'text.line_height': text['text.line_height'],
      'type.size_steps': type['type.size_steps'],
      'type.scale_ratio_min': type['type.scale_ratio_min'],
      'space.grid4_frac': space['space.grid4_frac'],
      'align.column_count': space['align.column_count'],
      'a11y.axe_violations': a11y['a11y.axe_violations'],
      'a11y.keyboard_reach': a11y['a11y.keyboard_reach'],
      'a11y.focus_visible': a11y['a11y.focus_visible'],
      'nav.routes': navRoutes['nav.routes'],
      'nav.transition_ms': navTrans['nav.transition_ms'],
      'theme.both_valid': theme['theme.both_valid'],
      details: {
        layout: layout.details,
        text: text.details,
        type: type.details,
        space: space.details,
        a11y: a11y.details,
        nav_routes: navRoutes.details,
        nav_transition: navTrans.details,
        theme: theme.details,
      },
    };
  },
});

let cachedPluginKey = null;
let cachedPlugins = new Map();
let cachedLoadErrors = [];

function resolveProbeDirs(extraDirs = []) {
  const envDirs = (process.env.MOL_PROBE_DIRS || '')
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
  const dirs = [__dirname, ...envDirs, ...(extraDirs || [])];
  return [...new Set(dirs.map((d) => path.resolve(d)))];
}

/**
 * Auto-discover probe plugins exporting `probeName` (string) and `runProbe(pageHandle, args, invokedName)`.
 * Scans `harness/src/capture/probes/*.js` plus any directories in `MOL_PROBE_DIRS` / `extraDirs`.
 *
 * - Throws immediately on duplicate `probeName` / `aliases` or collision with built-in probes.
 * - Isolates per-file import errors so healthy plugins still load; failed files are recorded
 *   and surfaced fail-closed when an unresolved probe is requested (or via `getProbeLoadErrors()`).
 */
export async function discoverProbes({ extraDirs = [], forceReload = false } = {}) {
  const dirs = resolveProbeDirs(extraDirs);
  const cacheKey = dirs.join(path.delimiter);
  if (!forceReload && cachedPluginKey === cacheKey) {
    return cachedPlugins;
  }

  const registry = new Map();
  const loadErrors = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    const isBuiltinDir = dir === path.resolve(__dirname);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) continue;
      if (isBuiltinDir && BUILTIN_SKIP_FILES.has(entry.name)) continue;
      if (entry.name.startsWith('_')) continue;

      const fullPath = path.join(dir, entry.name);
      let mod;
      try {
        mod = await import(pathToFileURL(fullPath).href);
      } catch (err) {
        loadErrors.push({ filePath: fullPath, fileName: entry.name, message: String(err?.message || err) });
        continue;
      }

      if (typeof mod.probeName === 'string' && mod.probeName.length > 0 && typeof mod.runProbe === 'function') {
        const aliases = Array.isArray(mod.aliases) ? mod.aliases.filter((a) => typeof a === 'string' && a.length > 0) : [];
        const record = {
          probeName: mod.probeName,
          aliases,
          runProbe: mod.runProbe,
          filePath: fullPath,
        };
        const keysToRegister = [mod.probeName, ...aliases];
        for (const key of keysToRegister) {
          if (Object.hasOwn(BUILTIN_HANDLERS, key)) {
            throw new Error(`Probe plugin "${fullPath}" cannot shadow built-in probe "${key}"`);
          }
          if (registry.has(key)) {
            const existing = registry.get(key);
            throw new Error(
              `Duplicate probe registration "${key}" in "${fullPath}" (already registered by "${existing.filePath}")`
            );
          }
          registry.set(key, record);
        }
      }
    }
  }

  cachedPluginKey = cacheKey;
  cachedPlugins = registry;
  cachedLoadErrors = loadErrors;
  return registry;
}

export function getProbeLoadErrors() {
  return [...cachedLoadErrors];
}

export async function listProbes({ extraDirs = [] } = {}) {
  const plugins = await discoverProbes({ extraDirs });
  return [...new Set([...Object.keys(BUILTIN_HANDLERS), ...plugins.keys()])].sort();
}

/**
 * Run a named probe group or specific metric probe on a PageHandle.
 * Built-in handlers are checked first (preserving v0.1 behavior), then auto-discovered plugins.
 */
export async function runProbe(probeName, pageHandle, args = {}) {
  if (Object.hasOwn(BUILTIN_HANDLERS, probeName)) {
    return BUILTIN_HANDLERS[probeName](pageHandle, args);
  }
  const plugins = await discoverProbes();
  const plugin = plugins.get(probeName);
  if (plugin) {
    return plugin.runProbe(pageHandle, args, probeName);
  }
  if (cachedLoadErrors.length > 0) {
    const failedDetail = cachedLoadErrors.map((e) => `${e.fileName}: ${e.message}`).join('; ');
    throw new Error(`Unknown probe: "${probeName}" (probe plugin load failure(s): ${failedDetail})`);
  }
  throw new Error(`Unknown probe: "${probeName}"`);
}
