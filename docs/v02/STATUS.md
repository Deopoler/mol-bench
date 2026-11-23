# v0.2 작업 현황

설계: [`docs/V02-DESIGN.md`](../V02-DESIGN.md) · 확장 규약: [`docs/v02/HOOKS.md`](HOOKS.md)(wp0a 병합 후)
작업 중인 브랜치는 GitHub에 그대로 올려 둔다(`wp0a`, `wp4`, …). 숨김 채점 자료(`hidden-v2/`)는 올리지 않는다.

마지막 갱신: 2026-11-23 20:15

## 작업 패키지

| WP | 내용 | 작업자 | 상태 |
|---|---|---|---|
| 설계 | v0.2 설계 문서 | Gemini 4 Neon (High) | ✅ 완료 (리뷰 10건 반영, main) |
| runner | 반복 수집 버그, 깨어 있는 시간·활동 시간 측정 | Gemini 4 Hydrogen (High) | ✅ 완료 (main) |
| WP-0a | 채점 핵심: fail-closed, `--version 2`, 확장 훅, room-harness | Gemini 4 Neon (High) | ✅ 완료 (리뷰 13건 반영, main) |
| WP-4 | restoration v0.2 (버그 10종, 변형 4개) | Gemini 4 Argon (High) + 지휘자 마무리 | ✅ 보정 완료 (null 0 · a5 5.53 · a8 9.59 · 공격 1.0~1.3), 정답·채점 코드는 비공개 — WP-0b 병합 뒤 main에 squash |
| WP-0b | 캡처(host.js)·연쇄 수정 실행기·리더보드 | Gemini 4 Hydrogen (High) | 🔧 2차 리뷰 지적(비밀값 유출 경로·Worker/iframe 우회·오탐) 수정 중 |
| WP-1 | 새 지표·프로브 | Gemini 4 Hydrogen (High) | ✅ 완료 (리뷰 반영, WP-0b와 통합 시험 통과) |
| WP-2 | aurora v0.2 | Claude Sonnet 5.5 (agy) 예정 | ⏳ agy Claude 쿼터 초기화(11-25 오후) 후 |
| WP-3 | lobby v0.2 | Claude Sonnet 5.5 (agy) 예정 | ⏳ agy Claude 쿼터 초기화(11-25 오후) 후 |
| WP-5 | atelier v0.2 (P1) | – | ⏳ 쿼터 여유 시 |
| WP-6 | lobby 연쇄 수정 r1→r2→r3 (P1) | – | ⏳ 쿼터 여유 시 |

## 참가 시험 계획

- 모델별 최고 effort만 1회씩.
- Wave 0(카나리): Gemini 4 Neon (XHigh), Gemini 3.8 Flash (High) — P0 방이 완성되면 시작.
- 시험 쿼터 상한(주간): Gemini 35% · Claude Pro 15% · Argon 40%. codex는 쿼터 복구(약 3주) 전까지 사용 안 함.
