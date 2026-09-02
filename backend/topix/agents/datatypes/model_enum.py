"""Model Enum.

Convenience handles for the current models, plus capability checks. Capability
sets are keyed on bare model names (final path segment, no route prefix or
OpenRouter `:variant`) so they hold no matter how a model is addressed.
"""
from enum import Enum


class OpenAIModel(str, Enum):
    """OpenAI Models."""

    GPT_5_5 = "openai/gpt-5.5"
    GPT_5_5_PRO = "openai/gpt-5.5-pro"
    GPT_5_4 = "openai/gpt-5.4"
    GPT_5_4_MINI = "openai/gpt-5.4-mini"
    GPT_5_4_NANO = "openai/gpt-5.4-nano"


class OpenRouterModel(str, Enum):
    """OpenRouter-routed convenience handles."""

    CLAUDE_OPUS = "openrouter/anthropic/claude-opus-4.8"
    CLAUDE_SONNET = "openrouter/anthropic/claude-sonnet-4.6"
    CLAUDE_HAIKU = "openrouter/anthropic/claude-haiku-4.5"


class PerplexityModel(str, Enum):
    """Perplexity Models."""

    PERPLEXITY_SONAR = "perplexity/sonar"


class ModelEnum:
    """Model Enum."""

    OpenAI = OpenAIModel
    Perplexity = PerplexityModel
    OpenRouter = OpenRouterModel


def _bare(model: object) -> str:
    """Return a model's bare name, ignoring any route prefix or OpenRouter variant.

    Capability checks must hold whether a model is addressed natively
    ("openai/gpt-5.4"), routed through OpenRouter ("openrouter/openai/gpt-5.4"),
    carries a throughput variant ("z-ai/glm-5.3:nitro"), or is wrapped in a
    LitellmModel — all collapse to the same bare name (e.g. "gpt-5.4", "glm-5.3").
    """
    name = model.model if hasattr(model, "model") else model
    if isinstance(name, Enum):
        name = name.value  # str(Enum) yields "OpenAIModel.X", not the model string
    return str(name).rsplit("/", 1)[-1].split(":", 1)[0]


# The current OpenAI lineup: reasoning-capable, no temperature, no penalties,
# and supports the "none" reasoning-effort. Capability sets are bare names so
# they match native and OpenRouter-routed forms alike.
_CURRENT_OPENAI_MODELS = frozenset({
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
})

# Additional reasoning-capable models served through other providers.
_OTHER_REASONING_MODELS = frozenset({
    "sonar",  # perplexity/sonar
})

_NO_TEMPERATURE_MODELS = _CURRENT_OPENAI_MODELS
_REASONING_MODELS = _CURRENT_OPENAI_MODELS | _OTHER_REASONING_MODELS
_REASONING_EFFORT_NONE_MODELS = _CURRENT_OPENAI_MODELS
_REASONING_EFFORT_INSTANT_MODELS: frozenset[str] = frozenset()
_NO_PENALTIES_MODELS = _CURRENT_OPENAI_MODELS


def support_temperature(model: object) -> bool:
    """Check if the model supports temperature.

    Temperature is possibly not supported in reasoning models due to
    introduced newer parameters like `verbosity` or `reasoning_effort`.
    """
    return _bare(model) not in _NO_TEMPERATURE_MODELS


def support_reasoning(model: object) -> bool:
    """Check if the model supports reasoning."""
    return _bare(model) in _REASONING_MODELS


def support_reasoning_effort_instant_mode(model: object) -> bool:
    """Check if the model supports instant reasoning effort."""
    return _bare(model) in _REASONING_EFFORT_INSTANT_MODELS


def support_reasoning_effort_none(model: object) -> bool:
    """Check if the model supports 'none' reasoning effort."""
    return _bare(model) in _REASONING_EFFORT_NONE_MODELS


def support_penalties(model: object) -> bool:
    """Check if the model supports frequency and presence penalty."""
    return _bare(model) not in _NO_PENALTIES_MODELS
