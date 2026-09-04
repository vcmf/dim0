"""Static integrity checks for the model catalog and its consumers.

Unlike test_catalog.py (which exercises resolution against various key states),
these load the catalog as-authored and guard the invariants that hand-edits to
models.yml / model_enum.py / the agent YAML configs can silently break. They are
key-independent: they read the static catalog, not the live environment.
"""

import yaml

from topix.agents.config import CONFIG_DIR
from topix.agents.datatypes.model_enum import ModelEnum, _bare
from topix.config import catalog


def _catalog():
    """Return (providers, llm models, embedding models) as authored in models.yml."""
    return catalog._load()


def test_every_route_references_a_defined_provider():
    """Each route's `via` must exist in the providers registry."""
    providers, llm, embedding = _catalog()
    unknown = [
        (m.id, r.via)
        for m in (*llm, *embedding)
        for r in m.routes
        if r.via not in providers
    ]
    assert unknown == [], f"routes reference undefined providers: {unknown}"


def test_every_llm_has_a_valid_tier():
    """Auto-model selection relies on every LLM declaring a pro/lite tier."""
    _, llm, _ = _catalog()
    bad = [(m.id, m.tier) for m in llm if m.tier not in ("pro", "lite")]
    assert bad == [], f"models with invalid tier: {bad}"


def test_catalog_has_both_tiers():
    """auto-mode needs at least one lite and one pro model to route between."""
    _, llm, _ = _catalog()
    tiers = {m.tier for m in llm}
    assert "pro" in tiers
    assert "lite" in tiers


def test_model_ids_are_unique():
    """Canonical ids must be unique (id is the public handle clients send)."""
    _, llm, embedding = _catalog()
    ids = [m.id for m in (*llm, *embedding)]
    assert len(ids) == len(set(ids)), "duplicate model ids in catalog"


def test_embedding_routes_share_dim_per_id():
    """All routes for one embedding id must share a dim (vectors aren't portable)."""
    _, _, embedding = _catalog()
    for m in embedding:
        assert m.dim is not None, f"embedding {m.id} missing dim"


def test_nitro_only_on_non_openai_anthropic_openrouter_routes():
    """OpenRouter routes carry :nitro except for openai/anthropic single-provider models."""
    _, llm, _ = _catalog()
    violations = []
    for m in llm:
        for r in m.routes:
            if r.via != "openrouter":
                continue
            # Proprietary OpenAI/Anthropic models are single-provider on OpenRouter
            # (no nitro). Open-weight models are multi-provider even when the slug
            # is vendor-branded (e.g. openai/gpt-oss-*), so they keep nitro.
            single_provider = (
                r.model.startswith(("openai/", "anthropic/")) and "gpt-oss" not in r.model
            )
            has_nitro = r.model.endswith(":nitro")
            if single_provider and has_nitro:
                violations.append(("unexpected :nitro", m.id, r.model))
            if not single_provider and not has_nitro:
                violations.append(("missing :nitro", m.id, r.model))
    assert violations == [], f"nitro-rule violations: {violations}"


def test_agent_config_models_exist_in_catalog():
    """Every `model:` in the agent YAML configs must be a catalog id.

    validate_model silently falls back when a model is unreachable, so a typo in
    a config would otherwise go unnoticed; this catches it at the source.
    """
    _, llm, _ = _catalog()
    ids = {m.id for m in llm}

    def collect(node) -> list[str]:
        found: list[str] = []
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "model" and isinstance(value, str):
                    found.append(value)
                else:
                    found.extend(collect(value))
        elif isinstance(node, list):
            for item in node:
                found.extend(collect(item))
        return found

    for name in ("assistant.yml", "deep_research.yml"):
        cf = yaml.safe_load((CONFIG_DIR / name).read_text())
        for model_id in collect(cf):
            assert model_id in ids, f"{name} references unknown model '{model_id}'"


def test_model_enum_handles_resolve_to_catalog():
    """ModelEnum convenience handles (agent defaults) must map to catalog ids.

    Guards the bulk-renamed sub-agent defaults from drifting off the catalog and
    silently falling back. Perplexity is excluded (its Sonar handle is a search
    summarizer, not a chat-catalog model).
    """
    _, llm, _ = _catalog()
    ids = {m.id for m in llm}
    for family in (ModelEnum.OpenAI, ModelEnum.OpenRouter):
        for member in family:
            assert _bare(member.value) in ids, f"{member} not in catalog"
