"""AI provider proxy — managed-keys LLM turn for the client agent (G2).

The client agent orchestrates locally; this endpoint forwards ONE model turn to
the provider with OUR keys, resolved through the shared catalog (multi-provider,
per-plan tier gating, and `"auto"` routing). It is deliberately NOT the full
agent — just a metered egress for a single completion (streaming or not).
Per-run metering lands in a later slice.

Wire shape is OpenAI-compatible on purpose: the client already maps our messages
to OpenAI form (`toOpenAiMessages`/`toOpenAiTools`) and back (`fromOpenAiMessage`),
so a managed turn reuses the exact BYOK mapping — only the transport differs.
"""

import json
import os
import tempfile

from collections.abc import Iterator
from typing import Annotated, Any, Literal

import litellm

from fastapi import APIRouter, Depends, File, Header, HTTPException, Request, Response, UploadFile, status
from fastapi.responses import StreamingResponse
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel

from topix.agents.assistant.auto_model import classify_auto_model_complexity
from topix.agents.assistant.code import execute_code
from topix.agents.websearch.tools import (
    fetch_content,
    search_exa,
    search_linkup,
    search_perplexity,
    search_tavily,
)
from topix.api.utils.decorators import with_standard_response
from topix.api.utils.rate_limit.entitlements import resolve_entitlement_context
from topix.api.utils.rate_limit.policy import resolve_allowed_model_tiers
from topix.api.utils.rate_limit.service import enforce_rate_limit
from topix.api.utils.security import decode_and_validate_token, get_current_user_uid
from topix.config import catalog
from topix.nlp.parser import MistralParser

router = APIRouter(prefix="/ai", tags=["ai"])

# A run's managed calls share one metered unit for up to this long.
RUN_TTL_SECONDS = 3600
# Light abuse guard for the unauthenticated BYOK relay (per client IP, per minute).
BYOK_IP_PER_MINUTE = 120
# Upload limits for /ai/parse (mirror the client's pre-checks in doc-attach.tsx).
MAX_PDF_BYTES = 5 * 1024 * 1024
MAX_PDF_PAGES = 50

# Token is OPTIONAL here: a BYOK relay call (X-Provider-Key) may be tokenless.
_oauth2_optional = OAuth2PasswordBearer(tokenUrl="/users/signin", auto_error=False)


async def optional_user_uid(
    token: Annotated[str | None, Depends(_oauth2_optional)] = None,
) -> str | None:
    """Resolve the user uid from a bearer token, or None when absent/invalid.

    Unlike `get_current_user_uid` this never raises — it lets a BYOK relay call
    proceed tokenless while a managed call is rejected downstream (see
    `meter_run`).
    """
    if not token:
        return None
    try:
        return decode_and_validate_token(token, expected_type="access").get("sub")
    except HTTPException:
        return None


def _client_ip(request: Request) -> str:
    """Best-effort client IP for rate-limiting (first X-Forwarded-For hop, else peer)."""
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


async def _meter_run(
    request: Request,
    user_id: str | None,
    x_run_id: str | None,
    x_provider_key: str | None,
    *,
    allow_byok_relay: bool,
) -> None:
    """Meter one whole agent run against the plan's AI quota.

    - When `allow_byok_relay` is set (the external-tool endpoints that relay the
      caller's key to the provider), a call carrying `X-Provider-Key` runs on the
      user's own key: never charged against our quota, only guarded by a light
      per-IP cap (it may be tokenless for a local user). The managed LLM proxy
      passes `allow_byok_relay=False` — it always runs on OUR keys, so a stray
      provider-key header must NOT skip metering.
    - A managed call requires auth. The FIRST managed call of a run (deduped by
      `X-Run-Id`) enforces the quota (429 when over); later calls in the run are
      free; a call with no run id is metered on its own ("one run = one unit").
      The dedup slot is released if enforcement rejects, so a rejected first call
      isn't recorded as already-metered (which would let a retry ride free).
    """
    if allow_byok_relay and x_provider_key:
        redis = getattr(request.app, "redis_store", None)
        if redis is not None:
            ok, _ = await redis.check_fixed_window_quota(
                _client_ip(request), BYOK_IP_PER_MINUTE, "minute", scope="byok_relay"
            )
            if not ok:
                raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Slow down")
        return
    if user_id is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if x_run_id:
        redis = request.app.redis_store
        key = f"airun:{user_id}:{x_run_id}"
        first = await redis.set_if_absent(key, RUN_TTL_SECONDS)
        if not first:
            return
        try:
            await enforce_rate_limit(request, user_id)
        except Exception:
            # Rejected (e.g. over quota): release the dedup slot so this run isn't
            # marked metered — otherwise a retry with the same id would skip the
            # charge and ride free until the key's TTL expires. Best-effort, so a
            # delete failure never masks the original rejection (the 429).
            try:
                await redis.delete(key)
            except Exception:
                pass
            raise
    else:
        await enforce_rate_limit(request, user_id)


async def meter_run(
    request: Request,
    user_id: Annotated[str | None, Depends(optional_user_uid)] = None,
    x_run_id: Annotated[str | None, Header()] = None,
    x_provider_key: Annotated[str | None, Header()] = None,
) -> None:
    """Meter a managed-or-BYOK-relay call (`/ai/search|code|fetch|parse`).

    A relayed `X-Provider-Key` runs on the user's own key and skips our quota.
    """
    await _meter_run(request, user_id, x_run_id, x_provider_key, allow_byok_relay=True)


async def meter_run_managed(
    request: Request,
    user_id: Annotated[str | None, Depends(optional_user_uid)] = None,
    x_run_id: Annotated[str | None, Header()] = None,
) -> None:
    """Meter a managed-only call (`/ai/llm[/stream]`, which runs on OUR keys).

    Unlike `meter_run` there is no `X-Provider-Key` escape hatch: these endpoints
    never relay a caller key, so the run is always charged.
    """
    await _meter_run(request, user_id, x_run_id, None, allow_byok_relay=False)


class AiLlmRequest(BaseModel):
    """One model turn (OpenAI-shaped `messages`/`tools`; `model` is a catalog id or "auto")."""

    model: str = "auto"
    messages: list[dict[str, Any]] = []
    tools: list[dict[str, Any]] = []
    reasoning_effort: Literal["low", "medium", "high"] | None = None


@router.get("/models/", include_in_schema=False)
@router.get("/models")
@with_standard_response
async def ai_models(response: Response):
    """Public model catalog for the client picker (no auth, no plan filter).

    Returns every declared model with its per-provider routes so a signed-out /
    BYOK user can pick a model too; plan tiers are enforced at call time on the
    managed path.
    """
    return {"llm": catalog.public_llm_catalog()}


def _content_text(content: Any) -> str:
    """Flatten OpenAI message content to plain text for the complexity classifier.

    Content is either a string or a list of content-parts (multimodal). Image parts
    carry a base64 data URL that must NOT be stringified into the classifier input
    (megabytes of garbage to a text model), so only `text` parts are kept.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            (part.get("text") or "")
            for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        )
    return ""


async def _resolve_managed_model(
    model: str, messages: list[dict[str, Any]], allowed_tiers: set[str]
) -> str:
    """Resolve `model` to a concrete provider call code the plan may use.

    `"auto"` runs the shared complexity classifier and clamps to the plan's
    tiers; an explicit out-of-tier model is 403; an unconfigured model is 503.
    """
    if model == "auto":
        classifier_input = [
            {"role": str(m.get("role", "")), "content": _content_text(m.get("content"))}
            for m in messages
        ]
        complexity = await classify_auto_model_complexity(classifier_input)
        pro_ok = "pro" in allowed_tiers
        tier = "pro" if (complexity == "complex" and pro_ok) else "lite"
        resolved = catalog.default_resolved(tier) or catalog.default_resolved()
        if resolved is None:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "No model available")
        return resolved.call

    if not catalog.is_model_allowed(model, allowed_tiers):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, f"Model '{model}' is not available on your plan"
        )
    code = catalog.resolve_code(model)
    if code is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, f"Model '{model}' is not configured"
        )
    return code


def _message_to_dict(message: Any) -> dict[str, Any]:
    """LiteLLM assistant message → the minimal ChatCompletion message (content + tool_calls)."""
    tool_calls: list[dict[str, Any]] = []
    for tc in getattr(message, "tool_calls", None) or []:
        fn = getattr(tc, "function", None)
        tool_calls.append({
            "id": getattr(tc, "id", None),
            "type": "function",
            "function": {
                "name": getattr(fn, "name", None),
                "arguments": getattr(fn, "arguments", "") or "",
            },
        })
    out: dict[str, Any] = {"role": "assistant", "content": getattr(message, "content", None)}
    if tool_calls:
        out["tool_calls"] = tool_calls
    return out


@router.post("/llm/", include_in_schema=False)
@router.post("/llm")
@with_standard_response
async def ai_llm(
    response: Response,
    request: Request,
    body: AiLlmRequest,
    user_id: Annotated[str, Depends(get_current_user_uid)],
    _meter: Annotated[None, Depends(meter_run_managed)],
):
    """Forward one model turn with our keys. Returns `{choices:[{message}]}`."""
    entitlement = await resolve_entitlement_context(request, user_id)
    allowed_tiers = resolve_allowed_model_tiers(entitlement.plan)
    model_code = await _resolve_managed_model(body.model, body.messages, allowed_tiers)

    kwargs: dict[str, Any] = {"model": model_code, "messages": body.messages, "drop_params": True}
    if body.tools:
        kwargs["tools"] = body.tools
        kwargs["tool_choice"] = "auto"
    if body.reasoning_effort:
        kwargs["reasoning_effort"] = body.reasoning_effort

    result = await litellm.acompletion(**kwargs)
    return {"choices": [{"message": _message_to_dict(result.choices[0].message)}]}


def _accumulate_tool_call(slots: dict[int, dict[str, Any]], tc: Any) -> None:
    """Fold one streamed tool-call fragment (by index) into the assembling slots."""
    slot = slots.setdefault(getattr(tc, "index", 0), {"id": None, "name": None, "arguments": ""})
    if getattr(tc, "id", None):
        slot["id"] = tc.id
    fn = getattr(tc, "function", None)
    if fn and getattr(fn, "name", None):
        slot["name"] = fn.name
    if fn and getattr(fn, "arguments", None):
        slot["arguments"] += fn.arguments


def _delta_lines(delta: Any, slots: dict[int, dict[str, Any]], announced: set[int]) -> Iterator[str]:
    """Yield the NDJSON line(s) one streamed delta produces (content, reasoning, tool_start).

    A tool_start is emitted the instant a tool's name is first known. Reasoning is
    read via getattr: LiteLLM normalizes every provider's reasoning into
    `reasoning_content` (mapping `delta.reasoning` too) but DELETES the attribute
    when absent, so attribute access would raise on ordinary deltas. Display-only —
    reasoning is kept out of the assembled answer content.
    """
    piece = getattr(delta, "content", None)
    if piece:
        yield json.dumps({"type": "delta", "text": piece}) + "\n"
    reasoning = getattr(delta, "reasoning_content", None)
    if reasoning:
        yield json.dumps({"type": "reasoning", "text": reasoning}) + "\n"
    for tc in getattr(delta, "tool_calls", None) or []:
        idx = getattr(tc, "index", 0)
        _accumulate_tool_call(slots, tc)
        # Announce the tool the instant its name is known — before its (possibly
        # long) arguments finish — so the client shows it now.
        slot = slots.get(idx)
        if slot and slot.get("name") and idx not in announced:
            announced.add(idx)
            yield json.dumps({"type": "tool_start", "id": slot["id"], "name": slot["name"]}) + "\n"


@router.post("/llm/stream/", include_in_schema=False)
@router.post("/llm/stream")
async def ai_llm_stream(
    request: Request,
    body: AiLlmRequest,
    user_id: Annotated[str, Depends(get_current_user_uid)],
    _meter: Annotated[None, Depends(meter_run_managed)],
):
    """Stream one model turn as NDJSON lines.

    `{type:"delta",text}` per token, `{type:"reasoning",text}` per reasoning token
    (thinking models), `{type:"tool_start",id,name}` the moment a tool call's name
    is known (before its args finish), then `{type:"final",message}`. Tier/model
    resolution (and any 403/503) runs before streaming, so errors are plain HTTP.
    """
    entitlement = await resolve_entitlement_context(request, user_id)
    allowed_tiers = resolve_allowed_model_tiers(entitlement.plan)
    model_code = await _resolve_managed_model(body.model, body.messages, allowed_tiers)

    kwargs: dict[str, Any] = {
        "model": model_code,
        "messages": body.messages,
        "drop_params": True,
        "stream": True,
    }
    if body.tools:
        kwargs["tools"] = body.tools
        kwargs["tool_choice"] = "auto"
    if body.reasoning_effort:
        kwargs["reasoning_effort"] = body.reasoning_effort

    async def generate():
        content = ""
        slots: dict[int, dict[str, Any]] = {}
        announced: set[int] = set()
        stream = await litellm.acompletion(**kwargs)
        async for chunk in stream:
            choices = getattr(chunk, "choices", None) or []
            delta = choices[0].delta if choices else None
            if delta is None:
                continue
            content += getattr(delta, "content", None) or ""
            for line in _delta_lines(delta, slots, announced):
                yield line

        message: dict[str, Any] = {"role": "assistant", "content": content or None}
        if slots:
            message["tool_calls"] = [
                {"id": s["id"], "type": "function",
                 "function": {"name": s["name"], "arguments": s["arguments"]}}
                for s in slots.values()
            ]
        yield json.dumps({"type": "final", "message": message}) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


_SEARCH_FNS = {
    "perplexity": search_perplexity,
    "tavily": search_tavily,
    "linkup": search_linkup,
    "exa": search_exa,
}


class AiSearchRequest(BaseModel):
    """A managed web search: a query + which engine (our keys)."""

    query: str
    engine: str = "perplexity"
    max_results: int = 10


@router.post("/search/", include_in_schema=False)
@router.post("/search")
@with_standard_response
async def ai_search(
    response: Response,
    request: Request,
    body: AiSearchRequest,
    user_id: Annotated[str | None, Depends(optional_user_uid)],
    _meter: Annotated[None, Depends(meter_run)],
    x_provider_key: Annotated[str | None, Header()] = None,
):
    """Run one web search; returns `{answer, results}`.

    Uses our provider key by default, or relays the user's `X-Provider-Key`
    (BYOK) for this call only — never stored.
    """
    fn = _SEARCH_FNS.get(body.engine)
    if fn is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"Unsupported search engine '{body.engine}'"
        )
    output = await fn(body.query, max_results=body.max_results, api_key=x_provider_key)
    return {
        "answer": output.answer,
        "results": [
            {
                "url": r.url,
                "title": r.title,
                "content": r.content,
                "source_domain": r.source_domain,
            }
            for r in output.search_results
        ],
    }


class AiCodeRequest(BaseModel):
    """A managed code-interpreter run: source + language (executed on our Daytona)."""

    code: str
    language: str = "python"


@router.post("/code/", include_in_schema=False)
@router.post("/code")
@with_standard_response
async def ai_code(
    response: Response,
    request: Request,
    body: AiCodeRequest,
    user_id: Annotated[str | None, Depends(optional_user_uid)],
    _meter: Annotated[None, Depends(meter_run)],
    x_provider_key: Annotated[str | None, Header()] = None,
):
    """Run code in an isolated sandbox; returns the result.

    Uses our Daytona account by default, or relays the user's `X-Provider-Key`
    (BYOK) for this run only — never stored. `execute_code` self-handles an
    unrunnable language + unconfigured Daytona (returns an error result rather
    than raising), so this stays a thin proxy.
    """
    output = await execute_code(body.code, body.language, api_key=x_provider_key)
    return {
        "status": output.status,
        "stdout": output.stdout,
        "stderr": output.stderr,
        "duration_ms": output.duration_ms,
    }


class AiFetchRequest(BaseModel):
    """A managed URL fetch: read one page's content (our keys)."""

    url: str


@router.post("/fetch/", include_in_schema=False)
@router.post("/fetch")
@with_standard_response
async def ai_fetch(
    response: Response,
    request: Request,
    body: AiFetchRequest,
    user_id: Annotated[str | None, Depends(optional_user_uid)],
    _meter: Annotated[None, Depends(meter_run)],
    x_provider_key: Annotated[str | None, Header()] = None,
):
    """Read one URL's content; returns `{url, title, text}`.

    Uses our key by default, or relays the user's `X-Provider-Key` (BYOK, a
    Tavily key) for this call only — never stored.
    """
    output = await fetch_content(body.url, api_key=x_provider_key)
    first = output.search_results[0] if output.search_results else None
    return {
        "url": body.url,
        "title": first.title if first else None,
        "text": (first.content if first else "") or output.answer or "",
    }


@router.post("/parse/", include_in_schema=False)
@router.post("/parse")
@with_standard_response
async def ai_parse(
    response: Response,
    request: Request,
    user_id: Annotated[str | None, Depends(optional_user_uid)],
    _meter: Annotated[None, Depends(meter_run)],
    file: UploadFile = File(..., description="PDF to OCR into markdown"),
    x_provider_key: Annotated[str | None, Header()] = None,
):
    """OCR an uploaded PDF into markdown via Mistral; returns `{markdown, pages}`.

    Uses our Mistral key by default, or relays the user's `X-Provider-Key` (a
    Mistral key) for this call only — never stored. Only PDFs are supported; the
    bytes are OCR'd from a short-lived temp file and never persisted server-side
    (the client owns the resulting markdown, offline-first).
    """
    filename = file.filename or ""
    if not (file.content_type == "application/pdf" or filename.lower().endswith(".pdf")):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Only PDF files are supported")

    # Bounded read: pull at most MAX_PDF_BYTES + 1 so an oversized upload can't be
    # buffered whole in memory — one extra byte is enough to know it's over. (The
    # multipart body is already spooled to disk by Starlette before we get here;
    # capping the in-memory copy is the part we control. A hard receive ceiling
    # belongs at the ingress/ASGI layer.)
    file_bytes = await file.read(MAX_PDF_BYTES + 1)
    if len(file_bytes) > MAX_PDF_BYTES:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"PDF must be under {MAX_PDF_BYTES // (1024 * 1024)} MB",
        )

    parser = MistralParser(api_key=x_provider_key) if x_provider_key else MistralParser.from_config()

    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    try:
        tmp.write(file_bytes)
        tmp.close()
        # Page-count gate BEFORE OCR (get_num_pages reads pypdf locally, no spend).
        # -1 = unreadable; let parse() surface the real error rather than gate on it.
        page_count = parser.get_num_pages(tmp.name)
        if page_count > MAX_PDF_PAGES:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"PDF must be under {MAX_PDF_PAGES} pages"
            )
        pages = await parser.parse(tmp.name)
    finally:
        os.unlink(tmp.name)

    markdown = "\n\n".join(str(page.get("markdown", "")) for page in pages)
    return {"markdown": markdown, "pages": len(pages)}
