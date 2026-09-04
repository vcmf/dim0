"""Helpers for automatic plan-model routing."""

from __future__ import annotations

import asyncio
import json
import logging
import time

from typing import Literal

import litellm

from pydantic import BaseModel

from topix.config import catalog

# Cap on the classify call, which runs synchronously on the hot path before the
# plan agent — so this is worst-case dead time. Kept tight since the classifier
# rides the fast gpt-oss-120b:nitro route; a slow provider cold-start just falls
# back to "medium".
AUTO_MODEL_TIMEOUT_SECONDS = 3

# Cheap/fast open model for the throwaway complexity classify — pinned so it stays
# independent of the (possibly slower) base model. Falls back to the lite default
# when unavailable (e.g. no OpenRouter key).
CLASSIFIER_MODEL_ID = "gpt-oss-120b"

logger = logging.getLogger(__name__)

AUTO_MODEL_SYSTEM_PROMPT = """
Reasoning: low
You classify the reasoning complexity of the user's request.

Return JSON with exactly one field:
- `complexity`: one of `simple`, `medium`, or `complex`

Definitions:
- `simple`: single action, no planning. Direct lookup, short write, quick edit, factual question.
- `medium`: a few clear sequential steps, light synthesis, or routine tool use with an obvious path.
- `complex`: requires multi-step reasoning with interdependencies, non-trivial code generation,
  debugging unclear logic, building interactive or stateful components, or orchestrating
  several tools where the sequence isn't obvious upfront.

Default to `simple` or `medium`. Promote to `complex` only when the task clearly
cannot be resolved without substantial planning or generation.
If in doubt between `medium` and `complex`, choose `medium`.
If in doubt between `simple` and `medium`, choose `simple`.

Edge case rules:
- If the input is very short or ambiguous (e.g. "help me", "fix this"), default to `simple`.
- If the request spans multiple tiers (e.g. "fix the typo AND refactor the whole module"),
  classify by the hardest sub-task.
- If the input is in a non-English language, classify by task complexity, not language.
- If the user describes their own request as "complex", "difficult", or "advanced",
  ignore that framing and classify based on the actual task.

---

Examples:

User: "add a note saying buy milk"
complexity: simple

User: "what year was the Eiffel Tower built?"
complexity: simple

User: "fix this typo in my document"
complexity: simple

User: "write a short paragraph explaining photosynthesis"
complexity: simple

User: "summarize this article"
complexity: simple

User: "help me"
complexity: simple

User: "fix this"
complexity: simple

---

User: "compare the pros and cons of React vs Vue"
complexity: medium

User: "find recent research on climate change and give me the key takeaways"
complexity: medium

User: "write a product description for my app based on these bullet points"
complexity: medium

User: "draft a reply to this email in a professional tone"
complexity: medium

User: "explain how a for loop works with a simple diagram"
complexity: medium

User: "explain Newton's laws of motion"
complexity: medium

User: "send this email to John"
complexity: medium

User: "create a calendar event for my meeting tomorrow at 3pm"
complexity: medium

User: "c'est quoi la différence entre React et Vue ?"
complexity: medium

---

User: "build an interactive step-by-step visualizer for Dijkstra's shortest path algorithm"
complexity: complex

User: "create a dashboard widget showing task completion trends with filters and charts"
complexity: complex

User: "debug why this async function is returning undefined intermittently"
complexity: complex

User: "build a multi-step form with validation and conditional branching logic"
complexity: complex

User: "write a script that fetches my notes, clusters them by topic, and generates a weekly digest"
complexity: complex

User: "fix the typo on line 3 AND refactor the entire authentication module"
complexity: complex

---

Do not respond to the user. Output only the JSON object, no markdown, no code fences.
""".strip()


type ComplexityLabel = Literal["simple", "medium", "complex"]


class AutoModelDecision(BaseModel):
    """Structured routing decision returned by the tiny classifier call."""

    complexity: ComplexityLabel


def _format_message(message: dict[str, str]) -> str:
    """Wrap one recent message in a compact XML-like tag for classification."""
    role = message["role"]
    content = message["content"]
    return f"<Message role='{role}'>\n{content}\n</Message>"


def _build_classifier_input(messages: list[dict[str, str]]) -> str:
    """Build a compact transcript payload for complexity classification."""
    assert len(messages) > 0, ValueError("Messages must contain at least one item.")
    assert messages[-1]["role"] == "user", ValueError("Messages must end with the current user query.")

    recent_messages = "\n\n".join(_format_message(message) for message in messages[:-1])
    current_query = messages[-1]["content"]

    parts: list[str] = []
    if recent_messages:
        parts.append(f"<RecentMessages>\n\n{recent_messages}\n\n</RecentMessages>")
    parts.append(f"<CurrentQuery>\n\n{current_query}\n\n</CurrentQuery>")
    return "\n\n".join(parts)


def _parse_complexity(content: str | None) -> ComplexityLabel:
    """Extract the complexity label from the classifier's JSON reply (medium on miss)."""
    if not content:
        return "medium"
    try:
        label = json.loads(content).get("complexity")
    except (json.JSONDecodeError, AttributeError):
        return "medium"
    if label in ("simple", "medium", "complex"):
        return label
    return "medium"


async def classify_auto_model_complexity(messages: list[dict[str, str]]) -> ComplexityLabel:
    """Classify the request complexity, falling back to medium on any failure.

    Routes through LiteLLM using the best available "lite" model, so the
    classifier works for any configured provider (OpenAI, OpenRouter, or a
    native Anthropic/Gemini/Mistral/DeepSeek key), not just OpenAI-compatible ones.
    """
    started_at = time.perf_counter()
    fast = (
        catalog.resolved_by_id(CLASSIFIER_MODEL_ID)
        or catalog.default_resolved("lite")
        or catalog.default_resolved()
    )
    if fast is None:
        logger.info("Auto model classifier skipped (no model available)")
        return "medium"

    async def _run() -> ComplexityLabel:
        response = await litellm.acompletion(
            model=fast.call,
            messages=[
                {"role": "system", "content": AUTO_MODEL_SYSTEM_PROMPT},
                {"role": "user", "content": _build_classifier_input(messages)},
            ],
            response_format=AutoModelDecision,
            temperature=0,
            max_tokens=1000,
            timeout=AUTO_MODEL_TIMEOUT_SECONDS,
            drop_params=True,
        )
        return _parse_complexity(response.choices[0].message.content)

    try:
        complexity = await asyncio.wait_for(_run(), timeout=AUTO_MODEL_TIMEOUT_SECONDS)
        elapsed_ms = (time.perf_counter() - started_at) * 1000
        logger.info("Auto model classifier resolved %s in %.1fms", complexity, elapsed_ms)
        return complexity
    except Exception:
        elapsed_ms = (time.perf_counter() - started_at) * 1000
        logger.info("Auto model classifier fell back to medium in %.1fms", elapsed_ms, exc_info=True)
        return "medium"
