# Auto-model routing → GLM 5.3 Flash (base) / gpt-5.4 (complex)

## Problem
Auto routing (`model: "auto"` on `/ai/*` and the old server agent) resolves the
model via `catalog.default_resolved(tier)` — the **first model of that tier in
`models.yml` order** whose provider key is present. Today that's:
- lite → `gpt-5.4-mini` (first lite)
- pro → `gpt-5.5` (first pro)

So normal complexity no longer uses GLM (it was never wired explicitly — it's all
tier order), and complex defaults to gpt-5.5, not gpt-5.4.

## Desired
- **normal (lite) → GLM 5.3 Flash** (OpenRouter, nitro) — newer-gen, ~6× cheaper
  than GLM 5.2 and stronger on agent/coding benches; cheap enough to also back the
  complexity classifier (which reuses the lite default).
- **complex (pro) → gpt-5.4** — best ceiling on hard multi-step reasoning
  (GLM 5.3 full is close + cheaper, but gpt-5.4 leads on absolute capability).
- **BYOK fallback, for free:** GLM 5.3 Flash is OpenRouter-only, so with no
  OpenRouter key the lite default falls through to `gpt-5.4-mini`. gpt-5.4 has both
  an OpenAI and an OpenRouter route, so complex resolves for either key.

The resolver already does "first reachable route," so ordering is the only lever —
config-only, no code.

## Changes (`backend/topix/models.yml`)
1. Add `glm-5.3-flash` (tier `lite`) as the **first** llm entry → lite/base
   auto-default. Route: `z-ai/glm-5.3-flash:nitro` via openrouter.
2. Reorder the OpenAI block so `gpt-5.4` is **first** → pro/complex auto-default.
3. Replace `glm-5.2` → `glm-5.3` (tier `pro`, `z-ai/glm-5.3:nitro`) and drop
   `glm-5.1` (superseded by Flash). `glm-5.3` stays a high-value picker / pro
   option (auto pro still prefers gpt-5.4).

No change to `auto_model.py`/`manager.py`/`ai.py`: the classifier and both auto
paths already read `default_resolved("lite"|"pro")`, which now resolve as above.

## Test updates
- `test/unit/config/test_catalog.py`: the three `glm-5.2` example refs → `glm-5.3`
  (absent-when-openai-only; `resolve_code` → `openrouter/z-ai/glm-5.3:nitro`; the
  nitro-suffix tuple).

Structural tests (`test_catalog_integrity.py`) already pass: new models declare a
valid tier, carry `:nitro` (OpenRouter, non-openai/anthropic), unique ids.
`test_default_model_code_by_tier` asserts only tier, not identity.

## Out of scope (follow-up)
- The `auto_model.py` classifier's noisy traceback on non-user-terminated message
  lists (tool-loop continuations) — separate fix, discussed earlier.

## Verify
`uv run ruff check topix test/unit` + `uv run pytest test/unit` (catalog, integrity,
ai router, manager, model-tier policy), then `/code-review high`.
