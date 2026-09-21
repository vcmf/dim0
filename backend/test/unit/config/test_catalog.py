"""Unit tests for the model catalog resolver (config/catalog.py).

The catalog reads provider keys live from the environment, so each test clears
all provider keys and sets only the ones under test via monkeypatch.
"""

import pytest

from topix.config import catalog

PROVIDER_KEYS = [
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "MISTRAL_API_KEY",
    "DEEPSEEK_API_KEY",
    "LINKUP_API_KEY",
    "TAVILY_API_KEY",
    "PERPLEXITY_API_KEY",
    "EXA_API_KEY",
]


@pytest.fixture
def clean_keys(monkeypatch):
    """Remove all provider keys so each test starts from a known-empty state."""
    for key in PROVIDER_KEYS:
        monkeypatch.delenv(key, raising=False)
    return monkeypatch


def test_no_keys_yields_nothing(clean_keys):
    """With no keys set, nothing resolves and helpers return empty/None."""
    assert catalog.available_providers() == []
    assert catalog.available_llms() == []
    assert catalog.available_embedding() is None
    assert catalog.default_model_code() is None
    assert catalog.resolve_code("gpt-5.4") is None


def test_openai_only_routes_native(clean_keys):
    """With only OpenAI, every model routes natively and OR-only models vanish."""
    clean_keys.setenv("OPENAI_API_KEY", "sk-x")

    providers = catalog.available_providers()
    assert providers == ["openai"]

    llms = catalog.available_llms()
    # Every reachable model routes through the native OpenAI provider.
    assert llms, "expected OpenAI models to be available"
    assert all(m.provider == "openai" and m.call.startswith("openai/") for m in llms)

    # OpenRouter-only models (z-ai/qwen/deepseek/...) are not reachable.
    ids = {m.id for m in llms}
    assert "glm-5.3-flashx" not in ids
    assert "gpt-5.4" in ids

    assert catalog.resolve_code("gpt-5.4") == "openai/gpt-5.4"
    # A model with no native OpenAI route is unreachable here.
    assert catalog.resolve_code("claude-opus-4.8") is None

    emb = catalog.available_embedding()
    assert emb is not None
    assert emb.provider == "openai"
    assert emb.model == "text-embedding-3-small"
    assert emb.dim == 512


def test_openrouter_only_routes_via_openrouter(clean_keys):
    """With only OpenRouter, all models (incl. embeddings) route through it."""
    clean_keys.setenv("OPENROUTER_API_KEY", "or-x")

    assert catalog.available_providers() == ["openrouter"]

    llms = catalog.available_llms()
    assert all(m.provider == "openrouter" and m.call.startswith("openrouter/") for m in llms)

    # OpenAI models are reachable through OpenRouter (no :nitro for openai/anthropic).
    assert catalog.resolve_code("gpt-5.4") == "openrouter/openai/gpt-5.4"
    # So is Claude, with no native Anthropic key.
    assert catalog.resolve_code("claude-opus-4.8") == "openrouter/anthropic/claude-opus-4.8"
    # Non-OpenAI/Anthropic models carry the :nitro throughput variant.
    assert catalog.resolve_code("glm-5.3-flashx") == "openrouter/z-ai/glm-5.3-flashx:nitro"
    assert catalog.resolve_code("kimi-k3") == "openrouter/moonshotai/kimi-k3:nitro"

    # Embeddings work through OpenRouter (no OpenAI key required).
    emb = catalog.available_embedding()
    assert emb is not None
    assert emb.provider == "openrouter"
    assert emb.model == "openai/text-embedding-3-small"
    assert emb.dim == 512


def test_nitro_only_on_non_openai_anthropic_routes(clean_keys):
    """OpenAI/Anthropic OpenRouter routes omit :nitro; others include it."""
    clean_keys.setenv("OPENROUTER_API_KEY", "or-x")
    by_id = {m.id: m for m in catalog.available_llms()}

    # OpenAI + Anthropic via OpenRouter: no :nitro.
    assert ":nitro" not in by_id["gpt-5.4"].call
    assert ":nitro" not in by_id["claude-opus-4.8"].call
    # Everyone else via OpenRouter: :nitro. (gpt-oss is internal → excluded from
    # available_llms; its :nitro route is asserted via resolved_by_id below.)
    for mid in ("glm-5.3-flashx", "glm-5.3-flash", "gemma-4-31b", "qwen3.6-plus", "kimi-k3"):
        assert by_id[mid].call.endswith(":nitro"), mid


def test_retired_models_are_gone(clean_keys):
    """Models dropped in the revamp no longer resolve."""
    clean_keys.setenv("OPENROUTER_API_KEY", "or-x")
    ids = {m.id for m in catalog.available_llms()}
    for retired in (
        "gpt-4.1", "gpt-4o", "gemini-2.5-pro", "glm-4.7", "kimi-k2.5", "deepseek-v3.2",
        # dropped/renamed in the image-capable catalog refresh (PR S)
        "minimax-m2.7", "deepseek-v4-pro", "mistral-large",
        "glm-5.2", "glm-5.1", "kimi-k2.6", "deepseek-v4-flash",
    ):
        assert retired not in ids


def test_native_route_preferred_over_openrouter(clean_keys):
    """Native routes win over OpenRouter when both keys are present."""
    clean_keys.setenv("OPENAI_API_KEY", "sk-x")
    clean_keys.setenv("OPENROUTER_API_KEY", "or-x")
    clean_keys.setenv("ANTHROPIC_API_KEY", "an-x")

    # Native routes win when both a native key and OpenRouter are present.
    assert catalog.resolve_code("gpt-5.4") == "openai/gpt-5.4"
    assert catalog.resolve_code("claude-opus-4.8") == "anthropic/claude-opus-4-8"
    # A model with no native key still falls back to OpenRouter.
    assert catalog.resolve_code("kimi-k3") == "openrouter/moonshotai/kimi-k3:nitro"


def test_default_model_code_by_tier(clean_keys):
    """default_model_code/default_resolved honor the requested tier."""
    clean_keys.setenv("OPENAI_API_KEY", "sk-x")

    fast = catalog.default_model_code("lite")
    smart = catalog.default_model_code("pro")
    assert fast is not None and smart is not None

    fast_resolved = catalog.default_resolved("lite")
    smart_resolved = catalog.default_resolved("pro")
    assert fast_resolved.tier == "lite"
    assert smart_resolved.tier == "pro"


def test_resolved_by_id(clean_keys):
    """resolved_by_id returns the reachable model for an id, else None."""
    clean_keys.setenv("OPENROUTER_API_KEY", "or-x")
    r = catalog.resolved_by_id("gpt-oss-120b")
    assert r is not None
    assert r.id == "gpt-oss-120b"
    assert r.call == "openrouter/openai/gpt-oss-120b:nitro"
    # Unknown id → None.
    assert catalog.resolved_by_id("no-such-model") is None


def test_resolved_by_id_unreachable_is_none(clean_keys):
    """An OpenRouter-only model is None when only the OpenAI key is present."""
    clean_keys.setenv("OPENAI_API_KEY", "sk-x")
    assert catalog.resolved_by_id("gpt-oss-120b") is None


@pytest.mark.parametrize(
    "given",
    [
        "gpt-5.4-mini",                       # canonical id
        "openai/gpt-5.4-mini",               # legacy provider-prefixed code
        "openrouter/openai/gpt-5.4-mini",    # already-resolved call code
    ],
)
def test_normalize_code_accepts_ids_codes_and_legacy(clean_keys, given):
    """normalize_code maps ids, call codes, and legacy codes to a reachable call."""
    clean_keys.setenv("OPENROUTER_API_KEY", "or-x")
    assert catalog.normalize_code(given) == "openrouter/openai/gpt-5.4-mini"


def test_normalize_code_unknown_returns_none(clean_keys):
    """An unknown model reference normalizes to None."""
    clean_keys.setenv("OPENAI_API_KEY", "sk-x")
    assert catalog.normalize_code("totally-made-up-model") is None


def test_normalize_code_handles_non_str(clean_keys):
    """Non-string input resolves to None instead of raising."""
    clean_keys.setenv("OPENAI_API_KEY", "sk-x")
    assert catalog.normalize_code(None) is None
    assert catalog.resolve_code(None) is None


def test_require_model_code_raises_without_keys(clean_keys):
    """require_model_code raises a clear error when nothing resolves."""
    with pytest.raises(ValueError):
        catalog.require_model_code()

    clean_keys.setenv("OPENAI_API_KEY", "sk-x")
    assert catalog.require_model_code("lite") is not None


def test_openai_compatible_client_only_for_openai_apis(clean_keys):
    """A client is built for openai/openrouter routes, not native others."""
    clean_keys.setenv("OPENROUTER_API_KEY", "or-x")
    emb = catalog.available_embedding()
    assert emb is not None and emb.provider == "openrouter"
    client = catalog.openai_compatible_client(emb)
    assert client is not None
    assert str(client.base_url).rstrip("/").endswith("openrouter.ai/api/v1")


def test_public_catalog_is_all_vision_and_hides_internal():
    """Every user-facing model is image-capable; the classifier is hidden.

    After the refresh the text-only classifier (`gpt-oss-120b`, internal) is
    excluded from the picker, and every remaining model accepts image input.
    """
    by_id = {m["id"]: m for m in catalog.public_llm_catalog()}
    assert by_id  # catalog is non-empty
    # gpt-oss-120b is internal (classifier only) → never in the public picker.
    assert "gpt-oss-120b" not in by_id
    # Every user-facing model accepts image input.
    assert all(m["vision"] is True for m in by_id.values())
    # (gpt-oss-120b stays resolvable by id for the classifier — see
    # test_resolved_by_id — it's just hidden from this public list.)


def test_internal_model_hidden_from_selection_but_resolvable(clean_keys):
    """`internal` models are hidden from every user-facing path but resolvable.

    The classifier (`gpt-oss-120b`) is excluded from listing, selection, and the
    default pick, yet stays resolvable by id.
    """
    clean_keys.setenv("OPENROUTER_API_KEY", "or-x")
    # Not in the user-facing reachable list.
    assert "gpt-oss-120b" not in {m.id for m in catalog.available_llms()}
    # Cannot be selected as a chat model (resolve/allow both flow through available_llms).
    assert catalog.resolve_code("gpt-oss-120b") is None
    assert catalog.is_model_allowed("gpt-oss-120b", {"lite"}) is False
    # Never chosen as a default.
    assert catalog.default_resolved("lite").id != "gpt-oss-120b"
    assert catalog.default_resolved().id != "gpt-oss-120b"
    # But the classifier resolves it directly.
    r = catalog.resolved_by_id("gpt-oss-120b")
    assert r is not None and r.internal is True
