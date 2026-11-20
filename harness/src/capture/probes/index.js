import { probeLayout } from './layout.js';
import { probeText } from './text.js';
import { probeType } from './type.js';
import { probeSpaceAndAlign } from './space.js';
import { probeA11y, probeAxe, probeKeyboardReach, probeFocusVisible } from './a11y.js';
import { probeNavRoutes, probeNavTransitionMs, probeThemeBothValid } from './nav.js';

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
      return probeType(page, {
        ...args,
        checkHeroSerif: args.checkHeroSerif ?? probeName === 'type.hero_serif',
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

    default:
      throw new Error(`Unknown probe: "${probeName}"`);
  }
}
