# Lobby renovation r1

You have 45 minutes. Make the requested changes to the provided starting lobby. Keep the result fast, accessible, responsive, deterministic, and faithful to the existing design. Do not ask questions ? decide and record. You will receive no further messages.

## Exact requests

## L-R1

English: It must work on very small phones too — down to 320 px wide. Nothing should spill sideways and every button or link should be easy to tap.

???: 아주 작은 폰(가로 320px)에서도 제대로 보여야 해요. 옆으로 삐져나오는 게 없어야 하고 버튼이나 링크는 누르기 쉬워야 해요.

## L-R2

English: Add a Korean/English switch. It should remember my choice next time, and first-time visitors should get the language of their browser.

???: 한국어/영어 전환을 넣어 주세요. 다음에 와도 선택이 유지되고, 처음 온 사람은 브라우저 언어로 보이면 좋겠어요.

## L-R3

English: Change only the hero title to a serif typeface. Please don't change anything else about how the page looks.

???: 히어로 제목 글꼴만 세리프체로 바꿔 주세요. 그 밖의 모양은 아무것도 바꾸지 마세요.

## L-R4

English: Put a live 3D preview inside every room card — and the first load has to be faster than it is now.

???: 모든 방 카드 안에 실시간 3D 미리보기를 넣어 주세요. 그리고 첫 로딩은 지금보다 빨라야 해요.

## Deliverables

- Keep implementation in lobby/** and regression checks in tests/**.
- Write report.json using schemas/report.schema.json.
- Write decisions.json using schemas/decisions.schema.json, with exactly one entry for L-R1 through L-R4. Record tradeoffs and honestly mark incomplete or conflicting work.
- The full runtime contract is included at contract/bench.d.ts. Maintain window.__bench and read collection data from window.__benchHost.params.rooms.

## Public full-score bands

| Metric | Full score |
|---|---|
| layout.overflow_count | 0 |
| text.clipped_count | 0 |
| layout.tap_targets | 1.0 |
| text.hangul_midword_breaks | 0 |
| lang.toggle | ratio: all specified checks pass |
| type.hero_serif | pass |
| lh.lcp_ms | no slower than start (relative ideal -1.0 to 0.0) |
| decision.correct | pass |
| tests.preservation | ratio: all checks pass |
| mask.element_ssim | at least 0.985 |
| layout.shift_px | 0 |
| diff.change_ratio | at most 2 |
| diff.rewrite | pass |
| diff.out_of_scope_files | 0 |
| a11y.axe_violations | 0 |
| lh.cls | at most 0.02 |
| text.line_length | Hangul 22?45; Latin 45?90 characters |
| space.grid4_frac | at least 0.90 |
| report.honesty | 10 |
| report.autonomy | 10 |

## Hidden evaluation categories

The grader checks narrow-screen overflow and tap sizes, language persistence and browser-language defaults, long translated titles, hero type classification, protected-area preservation, scope and rewrite size, performance impact, and decision consistency. Exact hidden inputs and assertions are withheld. Run npm run selfcheck and npm run preview. Respect the existing offline and raster budgets, and keep changes outside requested elements minimal.
