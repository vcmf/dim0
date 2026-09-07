# Auto base → DeepSeek V4 Flash; classifier → gpt-oss-120b

Alternative to the GLM base (#268), which regressed: GLM 5.3 Flash via OpenRouter
didn't emit real `tool_calls` (agent hallucinated the tool loop as text) and was
too slow for the 2s classifier timeout. DeepSeek V4 Flash tests clean for tool
calling; gpt-oss-120b is a cheap, fast, tool/structured-output-capable classifier.

## Desired routing
- **normal (lite) → DeepSeek V4 Flash** (`deepseek/deepseek-v4-flash:nitro`, OpenRouter)
  when an OpenRouter key is present; falls through to `gpt-5.4-mini` with no key.
- **complex (pro) → gpt-5.5** (unchanged — 5.5 > 5.4).
- **classifier → gpt-oss-120b** (`openai/gpt-oss-120b`, OpenRouter): $0.03/$0.17,
  native structured output; decoupled from the base so it stays cheap/fast.
- **no-tier fallback** stays a strong pro (`gpt-5.5`, the first entry) — the lesson
  from #268's review (don't let a lite model become `default_resolved(None)`).

## Changes

### `backend/topix/models.yml`
- Move `deepseek-v4-flash` up to be the **first lite** entry (right after the OpenAI
  pro block, before `gpt-5.4-mini`) → the normal/base auto-default.
- Add `gpt-oss-120b` (tier `lite`, route `openai/gpt-oss-120b:nitro`) right after it.
  gpt-oss is OpenAI-branded but open-weight and multi-provider on OpenRouter, so it
  **keeps `:nitro`** (the nitro-rule test is amended to exempt gpt-oss from the
  single-provider rule). Position doesn't affect the base (classifier resolves it by
  id), but it must come after deepseek so deepseek stays first-lite.
- Remove `deepseek-v4-flash` from the DeepSeek section (keep `deepseek-v4-pro`).
- `gpt-5.5` stays first overall/first pro (no-tier + complex default unchanged).

### `backend/topix/config/catalog.py`
- Add `resolved_by_id(model_id) -> Resolved | None` (first reachable model with that id).

### `backend/topix/agents/assistant/auto_model.py`
- Pin the classifier: `fast = catalog.resolved_by_id("gpt-oss-120b") or
  default_resolved("lite") or default_resolved()`.
- Bump `AUTO_MODEL_TIMEOUT_SECONDS` 2 → 3 (OpenRouter first-token latency headroom;
  kept tight since the classifier rides the fast gpt-oss-120b:nitro route).

## Tests
- `test_catalog`: add a `resolved_by_id` test; the existing tier-default/openrouter
  tests still hold (deepseek/gpt-oss are OpenRouter-only; `glm-5.2` untouched here).
- Integrity: gpt-oss-120b has a valid tier, keeps `:nitro` (rule exempts open-weight
  gpt-oss from the single-provider case),
  unique id.

## Out of scope
- The BYOK signed-out default (handled separately in #268). This PR is the managed
  auto base + classifier only.
- GLM base (#268) stays open for the user's own testing; this is the alternative.

## Verify
`ruff check topix test/unit` + `pytest test/unit`, then `/code-review high`.
