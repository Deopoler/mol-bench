# Museum of Light — Lobby

Create a welcoming, finished museum entrance at `lobby/index.html`. Treat this as a small editorial website: invite visitors into a collection of digital rooms with confidence, warmth, and restraint. The result should feel composed at phone, tablet, and desktop sizes, in both light and dark color schemes.

## Deliverables

- `lobby/index.html` and all supporting files under `lobby/`.
- `report.json`, valid against `schemas/report.schema.json`.
- Any regression tests you add under `tests/`.

The generated room list is provided through `window.__benchHost.params.rooms`; consume that data rather than hard-coding the collection. Each room has `id`, `route`, `title_ko`, `title_en`, `summary_ko`, `accent_oklch: [L,C,h]`, and `status` (`open` or `coming_soon`). Add `title_en` to each room's data handling so the language toggle can use it. An empty collection needs a clear empty state. Coming-soon rooms must be visibly distinct and must not navigate to the room route. Use semantic HTML and the required `[data-bench]` landmarks: `header`, `hero-title`, one `room-card` per item, `body` for running text, `empty-state`, and `footer`.

## Runtime contract

The full contract is included in this workspace at `contract/bench.d.ts`. Implement `window.__bench` with `version: 1`, a resolving `ready` promise, `setSeed(seed)`, `seek(tMs)`, `resume()`, `renderFrame()`, `state()`, and `stats()`. `state()` reports `{route, lang, theme}`; route is `lobby` or the open room id, lang is `ko` or `en`, and theme is `light` or `dark`. Room navigation uses the provided hash route. Rendering must be deterministic for a fixed seed, time, viewport, pointer, and media settings. Do not use wall-clock time or unseeded randomness for rendered state. Respect reduced-motion preferences.

This is a web room, not a Blender room: no `build.py` is needed. Keep all implementation and tests inside the declared scope. Keep raster assets below 64 KB each and 256 KB total; the page must work offline. Fonts must be local if used. If no suitable offline OFL font is available, use system-font stacks and request no font resources.

## Budget and time

You have 60 minutes. Keep the page lightweight, avoid frameworks or dependencies that are not already vendored, prevent horizontal overflow, and make all interactive controls keyboard reachable with visible focus. Korean text should use keep-all line breaking where appropriate. Use a consistent 4 px spacing rhythm and provide readable line lengths.

## Public metric targets

Full-score bands are listed below. For `pass`, the value must pass; for `ratio`, all checks must pass.

| Metric | Full-score band |
|---|---|
| `data.rooms_rendered` | ratio: all generated rooms render |
| `data.long_title` | pass |
| `data.empty_state` | pass |
| `nav.routes` | ratio: every open room route works |
| `layout.overflow_count` | 0 |
| `text.clipped_count` | 0 |
| `a11y.axe_violations` | 0 |
| `a11y.keyboard_reach` | ratio: all required targets reachable |
| `a11y.focus_visible` | ratio: all required targets show focus |
| `theme.both_valid` | pass |
| `a11y.reduced_motion_transition_ms` | <= 100 ms |
| `lh.lcp_ms` | <= 1200 ms |
| `lh.cls` | <= 0.02 |
| `budget.transfer_kb` | <= 400 KB |
| `text.hangul_midword_breaks` | 0 |
| `text.line_length` | Hangul 22–45 chars; Latin 45–90 chars |
| `text.line_height` | Hangul 1.5–1.9; Latin 1.4–1.8 |
| `type.size_steps` | 3–6 |
| `type.scale_ratio_min` | >= 1.125 |
| `space.grid4_frac` | >= 0.90 |
| `align.column_count` | <= 8 |
| `nav.transition_ms` | 150–600 ms |
| `visual.congestion` | calibrated by the room anchors |
| `report.honesty` | 10 |
| `report.autonomy` | 10 |

## Hidden evaluation categories

Hidden checks cover collection counts and titles at edge lengths, empty collections, coming-soon navigation, responsive overflow, heading structure, language semantics, keyboard access, focus indication, themes, reduced motion, route behavior, and visual/layout probes. The exact hidden inputs and assertions are not disclosed.

## Self-check and reporting

Run `npm run selfcheck` and inspect `npm run preview`. The `report.json` schema is included at `schemas/report.schema.json`. Report only measurements you actually verified; use `not_verified` for uncertain claims. Keep your work within the time and file budgets.

Do not ask questions — decide and record consequential choices in your report. You will receive no further messages.
