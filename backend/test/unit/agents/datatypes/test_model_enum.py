"""Unit tests for model capability detection (agents/datatypes/model_enum.py).

These cover `_bare` (route/variant-agnostic name extraction) and the `support_*`
capability checks directly, independent of the agent that consumes them.
"""

import pytest

from agents.extensions.models.litellm_model import LitellmModel

from topix.agents.datatypes.model_enum import (
    ModelEnum,
    _bare,
    support_penalties,
    support_reasoning,
    support_reasoning_effort_none,
    support_temperature,
)


@pytest.mark.parametrize(
    "given, expected",
    [
        ("gpt-5.4", "gpt-5.4"),                          # bare id
        ("openai/gpt-5.4", "gpt-5.4"),                   # native route prefix
        ("openrouter/openai/gpt-5.4", "gpt-5.4"),        # double route prefix
        ("openrouter/z-ai/glm-5.3:nitro", "glm-5.3"),    # prefix + :nitro variant
        ("moonshotai/kimi-k2.6:nitro", "kimi-k2.6"),     # single prefix + variant
        ("gpt-5.4:nitro", "gpt-5.4"),                    # variant only
    ],
)
def test_bare_strips_route_prefix_and_variant(given, expected):
    """_bare reduces any addressing form to the canonical bare model name."""
    assert _bare(given) == expected


def test_bare_unwraps_litellm_model():
    """A LitellmModel wrapper resolves to its inner model's bare name."""
    assert _bare(LitellmModel("openrouter/z-ai/glm-5.3:nitro")) == "glm-5.3"


def test_bare_uses_enum_value_not_repr():
    """Enum members resolve via their value, not str(EnumMember)."""
    assert _bare(ModelEnum.OpenAI.GPT_5_4) == "gpt-5.4"
    assert _bare(ModelEnum.OpenRouter.CLAUDE_OPUS) == "claude-opus-4.8"


@pytest.mark.parametrize(
    "model",
    [
        "openai/gpt-5.4",
        "openrouter/openai/gpt-5.4",                    # routed, no :nitro
        LitellmModel("openrouter/openai/gpt-5.4"),
    ],
)
def test_current_openai_models_are_reasoning_no_temperature(model):
    """The current OpenAI lineup is reasoning-capable and rejects temperature.

    Holds across native, OpenRouter-routed, and LitellmModel addressing so the
    capability never silently flips based on which key is configured.
    """
    assert support_reasoning(model) is True
    assert support_temperature(model) is False
    assert support_reasoning_effort_none(model) is True
    assert support_penalties(model) is False


def test_nitro_variant_does_not_change_capabilities():
    """The :nitro throughput suffix must not affect capability detection."""
    plain = "openrouter/z-ai/glm-5.3"
    nitro = "openrouter/z-ai/glm-5.3:nitro"
    assert support_reasoning(plain) == support_reasoning(nitro)
    assert support_temperature(plain) == support_temperature(nitro)


def test_non_lineup_models_default_to_permissive_capabilities():
    """Models outside the curated sets allow temperature/penalties, no reasoning."""
    glm = "openrouter/z-ai/glm-5.3:nitro"
    assert support_reasoning(glm) is False
    assert support_temperature(glm) is True
    assert support_penalties(glm) is True


def test_perplexity_sonar_is_reasoning_capable():
    """Sonar stays reasoning-capable via its bare name."""
    assert support_reasoning(ModelEnum.Perplexity.PERPLEXITY_SONAR) is True
