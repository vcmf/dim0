"""Model catalog: canonical models -> provider routes, resolved against present keys.

The catalog (`models.yml`) declares providers and an ordered list of routes per
model. `resolve()` walks a model's routes and returns the first one whose
provider key is configured, producing a flat `Resolved` object that every
consumer (agents, embeddings, the services endpoint) can use. Static file
parsing is cached; key presence is read live so `ServiceConfig.update()` and
post-startup env changes are picked up.
"""

import logging
import os

from functools import lru_cache
from pathlib import Path

import yaml

from pydantic import BaseModel

logger = logging.getLogger(__name__)

MODELS_FILEPATH = Path(__file__).parent.parent / "models.yml"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
NO_LLM_ERROR = (
    "No LLM API available. Set a provider key (e.g. OPENAI_API_KEY or OPENROUTER_API_KEY)."
)


class Provider(BaseModel):
    """A model provider: its API-key env var and (for LLMs) its call prefix."""

    name: str
    key: str | None = None    # env var name; None => keyless (always available)
    prefix: str | None = None  # prepended to the route model string for the call code


class Route(BaseModel):
    """One way to reach a model: a provider plus that provider's model string."""

    via: str
    model: str


class CatalogModel(BaseModel):
    """A canonical model: stable id, display metadata, and ordered routes."""

    id: str
    label: str
    family: str
    tier: str | None = None    # "pro" | "lite" (llm only)
    dim: int | None = None     # vector size (embedding only)
    routes: list[Route]


class Resolved(BaseModel):
    """A model resolved to a concrete provider route for the current keys."""

    id: str
    label: str
    family: str
    tier: str | None = None
    dim: int | None = None
    provider: str
    model: str    # raw provider model string (e.g. "openai/text-embedding-3-small")
    call: str     # call code for agents/base.py (e.g. "openrouter/anthropic/claude-opus-4.6")

    @property
    def code(self) -> str:
        """Back-compat alias: the call code used as a model identifier."""
        return self.call


@lru_cache(maxsize=1)
def _load() -> tuple[dict[str, Provider], list[CatalogModel], list[CatalogModel]]:
    """Parse and cache models.yml into (providers, llm models, embedding models)."""
    with open(MODELS_FILEPATH) as f:
        cf = yaml.safe_load(f)

    providers = {
        name: Provider(name=name, **(spec or {}))
        for name, spec in (cf.get("providers") or {}).items()
    }
    llm = [CatalogModel.model_validate(m) for m in (cf.get("llm") or [])]
    embedding = [CatalogModel.model_validate(m) for m in (cf.get("embedding") or [])]
    return providers, llm, embedding


def _provider_available(p: Provider) -> bool:
    """Return True if the provider is keyless or its API-key env var is set."""
    return p.key is None or bool(os.getenv(p.key))


def available_providers() -> list[str]:
    """Names of providers whose key is present (or that need no key)."""
    providers, _, _ = _load()
    return [name for name, p in providers.items() if _provider_available(p)]


def _resolve(model: CatalogModel, providers: dict[str, Provider], present: frozenset[str]) -> Resolved | None:
    """Return the first route served by an available provider; None if unreachable."""
    for route in model.routes:
        p = providers.get(route.via)
        if p is None:
            logger.warning("Model '%s' references unknown provider '%s'", model.id, route.via)
            continue
        if p.name in present:
            call = f"{p.prefix}/{route.model}" if p.prefix else route.model
            return Resolved(
                id=model.id,
                label=model.label,
                family=model.family,
                tier=model.tier,
                dim=model.dim,
                provider=p.name,
                model=route.model,
                call=call,
            )
    return None


@lru_cache(maxsize=8)
def _resolved_for(present: frozenset[str]) -> tuple[tuple[Resolved, ...], Resolved | None]:
    """Resolve the whole catalog for a given set of available providers (memoized).

    Keyed on the present-provider snapshot so it recomputes only when configured
    keys change (startup sync, tests); stable env => cache hit on the hot path.
    """
    providers, llm, embedding = _load()
    llms = tuple(r for m in llm if (r := _resolve(m, providers, present)))
    emb = next((r for m in embedding if (r := _resolve(m, providers, present))), None)
    return llms, emb


def available_llms(allowed_tiers: set[str] | None = None) -> list[Resolved]:
    """LLM models reachable with the configured keys, in catalog order.

    When `allowed_tiers` is given, only models whose `tier` is in the set are
    returned (used for per-plan gating); `None` means no tier restriction.
    """
    llms, _ = _resolved_for(frozenset(available_providers()))
    if allowed_tiers is None:
        return list(llms)
    return [r for r in llms if r.tier in allowed_tiers]


def public_llm_catalog() -> list[dict]:
    """All declared LLM models with their per-provider routes.

    Safe to expose unauthenticated — model names/metadata only, no keys. `id` is
    the canonical id a MANAGED call sends; each route's `model` is the string a
    BYOK caller sends to that provider (e.g. openai→"gpt-5.4",
    openrouter→"openai/gpt-5.4"). Lets the client render a picker and translate
    the chosen model to the right string for the user's own provider.
    """
    _, llms, _ = _load()
    return [
        {
            "id": m.id,
            "label": m.label,
            "family": m.family,
            "tier": m.tier,
            "routes": [{"via": r.via, "model": r.model} for r in m.routes],
        }
        for m in llms
    ]


def model_tier(model_id_or_code: str) -> str | None:
    """Return the tier of a reachable model, else None.

    Normalizes the input first (canonical id, full call code, or legacy
    provider-prefixed code) the same way the rest of the catalog resolves
    models, so an entitled model isn't falsely gated when sent in a non-canonical
    form.
    """
    code = normalize_code(model_id_or_code)
    if code is None:
        return None
    for r in available_llms():
        if r.call == code:
            return r.tier
    return None


def is_model_allowed(model_id_or_code: str, allowed_tiers: set[str] | None) -> bool:
    """Return True if the model is reachable and its tier is permitted.

    `allowed_tiers=None` means unrestricted (any reachable model is allowed).
    """
    if allowed_tiers is None:
        return resolve_code(model_id_or_code) is not None
    tier = model_tier(model_id_or_code)
    return tier is not None and tier in allowed_tiers


def available_embedding() -> Resolved | None:
    """First embedding model reachable with the configured keys (preference order)."""
    _, emb = _resolved_for(frozenset(available_providers()))
    return emb


def resolve_code(model_id_or_code: str) -> str | None:
    """Map an incoming model id (or legacy call code) to a concrete call code.

    Accepts either a canonical catalog id ("claude-opus-4.6") or a full call
    code ("openrouter/anthropic/claude-opus-4.6") for backward compatibility.
    Returns None when the model is not reachable with the current keys.
    """
    if not isinstance(model_id_or_code, str):
        return None
    for r in available_llms():
        if model_id_or_code in (r.id, r.call):
            return r.call
    return None


def normalize_code(model: str) -> str | None:
    """Map any model reference to a concrete, reachable call code (or None).

    Handles canonical ids ("gpt-4.1-mini"), already-resolved call codes
    ("openrouter/openai/gpt-4.1-mini"), and legacy provider-prefixed codes
    ("openai/gpt-4.1-mini", "openrouter/openai/gpt-5.2") by progressively
    stripping leading provider segments until a catalog model matches.
    """
    if not isinstance(model, str):
        return None

    direct = resolve_code(model)
    if direct is not None:
        return direct

    providers, _, _ = _load()
    parts = model.split("/")
    i = 0
    while i < len(parts) - 1 and parts[i] in providers:
        i += 1
        hit = resolve_code("/".join(parts[i:]))
        if hit is not None:
            return hit
    return None


def resolved_by_id(model_id: str) -> Resolved | None:
    """Return the reachable model with this canonical id, or None (unknown / no key)."""
    return next((r for r in available_llms() if r.id == model_id), None)


def default_resolved(tier: str | None = None) -> Resolved | None:
    """Best available model, optionally constrained to a tier (falls back to any)."""
    models = available_llms()
    if tier:
        for m in models:
            if m.tier == tier:
                return m
    return models[0] if models else None


def default_model_code(tier: str | None = None) -> str | None:
    """Best available model call code, optionally constrained to a tier.

    Falls back to any available model when no model matches the requested tier.
    """
    r = default_resolved(tier)
    return r.call if r else None


def require_model_code(tier: str | None = None) -> str:
    """Like default_model_code but raise a clear error when no model is reachable."""
    code = default_model_code(tier)
    if code is None:
        raise ValueError(NO_LLM_ERROR)
    return code


def openai_compatible_client(resolved: Resolved):
    """Build an OpenAI-compatible AsyncOpenAI client for a resolved route.

    Supports the OpenAI and OpenRouter providers (both speak the OpenAI API);
    returns None for providers that are not OpenAI-API-compatible.
    """
    from openai import AsyncOpenAI

    if resolved.provider == "openai":
        return AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    if resolved.provider == "openrouter":
        return AsyncOpenAI(api_key=os.getenv("OPENROUTER_API_KEY"), base_url=OPENROUTER_BASE_URL)
    return None
