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
const BUILTIN_PROBE_NAMES = Object.freeze([
  'layout',
  'text',
  'type',
  'type_hero_serif',
  'space',
  'align',
  'a11y',
  'axe',
  'keyboard_reach',
  'focus_visible',
  'nav',
  'nav_routes',
  'nav_transition',
  'theme',
  'data',
  'lang_toggle',
  'all',
]);

let cachedPluginKey = null;
let cachedPlugins = new Map();

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
 */
export async function discoverProbes({ extraDirs = [], forceReload = false } = {}) {
  const dirs = resolveProbeDirs(extraDirs);
  const cacheKey = dirs.join(path.delimiter);
  if (!forceReload && cachedPluginKey === cacheKey) {
    return cachedPlugins;
  }

  const registry = new Map();
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
      const mod = await import(pathToFileURL(fullPath).href);
      if (typeof mod.probeName === 'string' && mod.probeName.length > 0 && typeof mod.runProbe === 'function') {
        const record = {
          probeName: mod.probeName,
          aliases: Array.isArray(mod.aliases) ? mod.aliases.filter((a) => typeof a === 'string' && a.length > 0) : [],
          runProbe: mod.runProbe,
          filePath: fullPath,
        };
        registry.set(mod.probeName, record);
        for (const alias of record.aliases) {
          registry.set(alias, record);
        }
      }
    }
  }

  cachedPluginKey = cacheKey;
  cachedPlugins = registry;
  return registry;
}

export async function listProbes({ extraDirs = [] } = {}) {
  const plugins = await discoverProbes({ extraDirs });
  return [...new Set([...BUILTIN_PROBE_NAMES, ...plugins.keys()])].sort();
}

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
 * Run a named probe group or specific metric probe on a PageHandle.
 * Supported probe names:
 *   layout | text | type | space | align | a11y | axe | keyboard_reach | focus_visible |
 *   nav | nav_routes | nav_transition | theme | all | or any exact metric id.
 */
export async function runProbe(probeName, pageHandle, args = {}) {
  const { page, cdp } = pageHandle;
  switch (probeName) {
    case 'layout':
    case 'layout.overflow_count':
    case 'layout.tap_targets':
      return probeLayout(page, args);

    case 'text':
    case 'text.clipped_count':
    case 'text.hangul_midword_breaks':
    case 'text.line_length':
    case 'text.line_height':
      return probeText(page, args);

    case 'type':
    case 'type.size_steps':
    case 'type.scale_ratio_min':
    case 'type.hero_serif':
    case 'type_hero_serif':
      return probeType(page, {
        ...args,
        checkHeroSerif: args.checkHeroSerif ?? (probeName === 'type.hero_serif' || probeName === 'type_hero_serif'),
      }, cdp);

    case 'space':
    case 'align':
    case 'space.grid4_frac':
    case 'align.column_count':
      return probeSpaceAndAlign(page, args);

    case 'axe':
    case 'a11y.axe_violations':
      return probeAxe(page);

    case 'keyboard_reach':
    case 'a11y.keyboard_reach':
      return probeKeyboardReach(page, args);

    case 'focus_visible':
    case 'a11y.focus_visible':
      return probeFocusVisible(page, args);

    case 'a11y':
      return probeA11y(page, args);

    case 'nav_routes':
    case 'nav.routes':
      return probeNavRoutes(page, args);

    case 'nav_transition':
    case 'nav.transition_ms':
    case 'a11y.reduced_motion_transition_ms':
      return probeNavTransitionMs(pageHandle, args);

    case 'nav': {
      const routes = await probeNavRoutes(page, args);
      const trans = await probeNavTransitionMs(pageHandle, args);
      return {
        ...routes,
        ...trans,
        details: { routes: routes.details, transition: trans.details },
      };
    }

    case 'theme':
    case 'theme.both_valid':
      return probeThemeBothValid(pageHandle);

    case 'data':
      return probeLobbyData(page);

    case 'lang_toggle':
      return probeLobbyLanguage(page);

    case 'all': {
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
    }

    default: {
      const plugins = await discoverProbes();
      const plugin = plugins.get(probeName);
      if (plugin) {
        return plugin.runProbe(pageHandle, args, probeName);
      }
      throw new Error(`Unknown probe: "${probeName}"`);
    }
  }
}
