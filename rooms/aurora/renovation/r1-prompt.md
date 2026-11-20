# Aurora Renovation (r1) — Aesthetic Direction & Targeted Fixes

You are renovating an existing WebGL2 aurora room (`room/index.html`). Your goal is to fulfill the visitor and art-director requests below with **minimal, targeted edits** while preserving existing functionality and visual structure.

> **One-shot task:** You will receive no further messages. Do not ask questions — resolve ambiguities thoughtfully and record your decisions in `decisions.json` and `report.json`.

---

## Change Requests

Address all four requests below:

1. **`A-R1` (Aesthetic Direction)**
   - **EN:** "It feels too busy and restless. I want it calmer — a quieter, deeper night."
   - **KO:** "너무 정신없고 들떠 보여요. 더 차분하게, 고요하고 깊은 밤 느낌이면 좋겠어요."
   - *(Note: make it calmer and deeper, not frozen or pitch-black — the aurora should remain alive and the night sky clearly visible, keeping the original palette hues.)*

2. **`A-R2` (Bug Report)**
   - **EN:** "When I resize the window, the stars turn into little ovals."
   - **KO:** "창 크기를 바꾸면 별이 작은 타원으로 변해요."

3. **`A-R3` (Accessibility)**
   - **EN:** "Some visitors get dizzy from motion. Please respect their system setting for reduced motion."
   - **KO:** "움직임에 어지러움을 느끼는 관람객이 있어요. 시스템의 '동작 줄이기' 설정을 따라 주세요."
   - *(Note: reduced-motion mode must still render the full starry sky and aurora at comparable luminance and star count — never a blank/black screen.)*

4. **`A-R4` (Preservation)**
   - **EN:** "Keep the horizon silhouette exactly as it is."
   - **KO:** "지평선 실루엣은 지금 모양 그대로 두세요."

---

## Workspace, Scope & Deliverables

- **Allowed scope:** `room/**`, `tests/**`, `report.json`, `decisions.json` (do not edit files outside these paths).
- **Required deliverables:**
  1. Updated source under `room/**`
  2. `decisions.json` at the workspace root (valid against `contract/decisions.schema.json` / `schemas/decisions.schema.json`, containing one entry per `request_id`: `A-R1`, `A-R2`, `A-R3`, `A-R4`)
  3. `report.json` at the workspace root (valid against `contract/report.schema.json` / `schemas/report.schema.json`)
- **Time limit:** 45 minutes
- **Discipline:**
  - Make **minimal, surgical changes** — do not rewrite the shader or page from scratch. Changing/removing >= 60% of the start source lines or touching out-of-scope files is heavily penalized.
  - Preserve existing `window.__bench` contract behavior, seed determinism, palette identity, and the horizon silhouette.
  - Keep the design canvas-only (no extra DOM overlays).
  - Be mindful that a darker, calmer sky can expose 8-bit quantization banding if dithering is missing.

---

## Gates & Scoring Overview

- **Gates:** `G-load`, `G-console`, `G-contract`, `G-determinism`, `G-live`, `G-offline`, `G-raster`, `G-report`, `G-decisions`.
- **Composite axes:** `revision` (0.55), `craft` (0.15), `visual_quality` (0.15), `reliability` (0.15).
- **`revision` measures:** fulfillment of `A-R1`..`A-R4`, preservation of existing passing behavior, minimal diff size (`diff.change_ratio`, `diff.rewrite`, `diff.out_of_scope_files`), and decision accuracy.
- **`visual_quality` / `craft`:** palette fidelity (`>= 0.75`), real-GPU frame time (`<= 16.7` ms), banding (`render.banding`), and edge aliasing (`render.aliasing`).

---

## Self-Check & Preview Tools

- `npm run selfcheck` (`node bench/cli.mjs selfcheck --renovation r1`) — checks gates, public tests, and public-seed metrics, and writes `selfcheck.json`.
- `npm run preview` (`node bench/cli.mjs preview`) — generates PNG contact sheets in `preview/` for visual inspection.

---

## `decisions.json` & `report.json` Format

### `decisions.json`

Must contain `schema_version: 1` and `requests` with one object per `request_id` (`A-R1`, `A-R2`, `A-R3`, `A-R4`):

```json
{
  "schema_version": 1,
  "requests": [
    {
      "request_id": "A-R1",
      "status": "done",
      "reason": "AMBIGUOUS_RESOLVED",
      "tradeoff": "Reduced motion speed, oversaturation, and sky/aurora luminance while preserving hues and keeping the night sky visible.",
      "expected_metrics": [
        { "metric_id": "time.motion", "value": 0.008 }
      ]
    },
    { "request_id": "A-R2", "status": "done", "reason": "NONE" },
    { "request_id": "A-R3", "status": "done", "reason": "NONE" },
    { "request_id": "A-R4", "status": "done", "reason": "NONE" }
  ]
}
```

### `report.json`

Same format as `contract/report.schema.json` (`schema_version: 1`, `summary`, `deliverables`, `claims`, `blocked: false`). Report only verified measurements as `"verified"`, and mark anything unmeasured (such as reference-GPU performance) as `"not_verified"`.
