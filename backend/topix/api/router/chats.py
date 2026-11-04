"""Chat API Router."""

import logging

from typing import Annotated, Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response, status
from fastapi.params import Path, Query

from topix.agents.assistant.manager import AssistantManager
from topix.agents.config import AssistantManagerConfig, DeepResearchConfig
from topix.agents.datatypes.context import Context, ReasoningContext
from topix.agents.deep_research import DeepResearch
from topix.agents.describe_chat import DescribeChat
from topix.agents.run import AgentRunner
from topix.agents.sessions import AssistantSession
from topix.api.datatypes.requests import (
    ChatUpdateRequest,
    MessageUpdateRequest,
    SendMessageRequest,
    StoreTranscriptRequest,
)
from topix.api.utils.decorators import with_standard_response
from topix.api.utils.rate_limit.dependency import rate_limiter
from topix.api.utils.rate_limit.entitlements import resolve_entitlement_context
from topix.api.utils.rate_limit.policy import resolve_allowed_model_tiers
from topix.api.utils.resilient_streaming import with_streaming_resilient_ndjson
from topix.api.utils.security import get_current_user_uid, verify_chat_user
from topix.config import catalog
from topix.datatypes.chat.chat import Chat
from topix.store.chat import ChatStore
from topix.store.graph import GraphStore
from topix.utils.common import gen_uid

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/chats",
    tags=["chats"],
    responses={404: {"description": "Not found"}},
)


@router.put("/", include_in_schema=False)
@router.put("")
@with_standard_response
async def create_chat(
    response: Response,
    request: Request,
    user_id: Annotated[str, Depends(get_current_user_uid)],
    board_id: Annotated[str, Query(description="Board Unique ID")] = None,
    chat_id: Annotated[str | None, Query(description="Optional Chat ID")] = None,
):
    """Create a new chat for the user."""
    uid = chat_id or gen_uid()
    new_chat = Chat(uid=uid, user_uid=user_id, graph_uid=board_id)

    store: ChatStore = request.app.chat_store
    await store.create_chat(new_chat)
    return {"chat_id": new_chat.uid}


# --- Browser-agent transcript storage (Phase 2) ------------------------------
# Additive, owner-scoped by the authenticated user. The browser engine is the
# source of truth; these routes back up its transcript verbatim and seed it on
# another device. No agent, no streaming, no embedding — distinct from the
# server-agent `POST /{chat_id}/messages` path below. Declared before the
# `/{chat_id}` routes so `GET /transcripts` isn't captured as a chat id.


@router.get("/transcripts/", include_in_schema=False)
@router.get("/transcripts")
@with_standard_response
async def list_transcripts(
    response: Response,
    request: Request,
    user_id: Annotated[str, Depends(get_current_user_uid)],
    board_id: Annotated[str, Query(description="Board UID to list transcripts for")],
):
    """List the caller's browser-agent transcripts for a board (seed source)."""
    store: ChatStore = request.app.chat_store
    transcripts = await store.list_transcripts_by_board(user_id, board_id)
    return {"transcripts": transcripts}


@router.put("/{chat_id}/transcript/", include_in_schema=False)
@router.put("/{chat_id}/transcript")
@with_standard_response
async def store_transcript(
    response: Response,
    request: Request,
    chat_id: Annotated[str, Path(description="Chat ID")],
    body: Annotated[StoreTranscriptRequest, Body(description="Transcript payload")],
    user_id: Annotated[str, Depends(get_current_user_uid)],
):
    """Store a browser-agent chat transcript verbatim (owner-scoped upsert)."""
    store: ChatStore = request.app.chat_store
    await store.upsert_transcript(
        chat_uid=chat_id,
        user_uid=user_id,
        board_id=body.board_id,
        label=body.label,
        transcript=body.transcript,
    )
    return {"chat_id": chat_id, "stored": len(body.transcript)}


@router.post("/{chat_id}:describe/", include_in_schema=False)
@router.post("/{chat_id}:describe")
@with_standard_response
async def describe_chat(
    response: Response,
    request: Request,
    chat_id: Annotated[str, Path(description="Chat ID")],
    _: Annotated[None, Depends(verify_chat_user)],
):
    """Describe a chat by its ID."""
    context = Context()
    store: ChatStore = request.app.chat_store
    session = AssistantSession(session_id=chat_id, chat_store=store)

    chat_describer = DescribeChat()
    label = await AgentRunner.run(chat_describer, await session.get_items(), context=context)

    await store.update_chat(chat_id, {"label": label})
    return {"label": label}


@router.patch("/{chat_id}/", include_in_schema=False)
@router.patch("/{chat_id}")
@with_standard_response
async def update_chat(
    response: Response,
    request: Request,
    chat_id: Annotated[str, Path(description="Chat ID")],
    body: Annotated[ChatUpdateRequest, Body(description="Chat update data")],
    _: Annotated[None, Depends(verify_chat_user)]
):
    """Update an existing chat by its ID."""
    store: ChatStore = request.app.chat_store
    return await store.update_chat(chat_id, body.data.model_dump(exclude_unset=True))


@router.get("/{chat_id}/", include_in_schema=False)
@router.get("/{chat_id}")
@with_standard_response
async def get_chat(
    response: Response,
    request: Request,
    chat_id: Annotated[str, Path(description="Chat ID")],
    _: Annotated[None, Depends(verify_chat_user)],
):
    """Get a chat by its ID."""
    store: ChatStore = request.app.chat_store
    chat = await store.get_chat(chat_id)
    return {"chat": chat.model_dump(exclude_none=True)}


@router.get("/", include_in_schema=False)
@router.get("")
@with_standard_response
async def list_chats(
    response: Response,
    request: Request,
    user_id: Annotated[str, Depends(get_current_user_uid)],
    offset: Annotated[int, Query(description="Pagination offset")] = 0,
    limit: Annotated[int, Query(description="Pagination limit")] = 100,
    graph_uid: Annotated[
        str | Literal["none", "any"] | None,
        Query(description="Optional Graph UID. 'none' = orphan chats; 'any' = chats with any board.")
    ] = None,
):
    """List all chats for the user."""
    store: ChatStore = request.app.chat_store
    chats = await store.list_chats(
        user_uid=user_id,
        offset=offset,
        limit=limit,
        graph_uid=graph_uid
    )

    return {"chats": [chat.model_dump(exclude_none=True) for chat in chats]}


@router.delete("/{chat_id}/", include_in_schema=False)
@router.delete("/{chat_id}")
@with_standard_response
async def delete_chat(
    response: Response,
    request: Request,
    chat_id: Annotated[str, Path(description="Chat ID")],
    _: Annotated[None, Depends(verify_chat_user)],
):
    """Delete a chat by its ID."""
    return await request.app.chat_store.delete_chat(chat_id, hard_delete=True)


@router.post("/{chat_id}/messages/", include_in_schema=False)
@router.post("/{chat_id}/messages")
@with_streaming_resilient_ndjson(
    media_type="application/x-ndjson",
    queue_maxsize=128,
    continue_on_disconnect=True,
)
async def send_message(
    request: Request,
    chat_id: Annotated[str, Path(description="Chat ID")],
    body: Annotated[SendMessageRequest, Body(description="Message content")],
    user_id: Annotated[str, Depends(get_current_user_uid)],
    _: Annotated[None, Depends(verify_chat_user)],
    __: Annotated[None, Depends(rate_limiter)],
):
    """Send a message to a chat."""
    chat_store: ChatStore = request.app.chat_store
    graph_store: GraphStore = request.app.graph_store
    session = AssistantSession(session_id=chat_id, chat_store=chat_store)

    # Resolve the model tiers this user's plan may use. Auto mode is clamped to
    # these tiers downstream; an explicit out-of-tier model is rejected here.
    entitlement = await resolve_entitlement_context(request, user_id)
    allowed_tiers = resolve_allowed_model_tiers(entitlement.plan)
    if body.model != "auto" and not catalog.is_model_allowed(body.model, allowed_tiers):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Model '{body.model}' is not available on your plan",
        )

    if body.use_deep_research:
        deepsearch_config = DeepResearchConfig.from_yaml()
        deepsearch_model = body.model if body.model != "auto" else catalog.require_model_code("lite")
        deepsearch_config.set_model(deepsearch_model)

        deepsearch = DeepResearch.from_config(deepsearch_config)

        run_streamed = deepsearch.run_streamed
    else:
        assistant_config = AssistantManagerConfig.from_yaml()
        auto_mode = body.model == "auto"
        if not auto_mode:
            assistant_config.set_model(body.model)
        assistant_config.set_web_engine(body.web_search_engine)
        assistant_config.set_reasoning(body.reasoning_effort)

        # retrieve chat to get graph_uid for memory filters
        chat = await chat_store.get_chat(chat_id)
        memory_filters = {"graph_uid": chat.graph_uid} if chat.graph_uid else None
        logger.info("Memory filters for chat %s: %s", chat_id, memory_filters)

        enabled_tools = body.enabled_tools or []
        if memory_filters is None:
            # if no graph_uid, disable tools that require a board scope
            enabled_tools = [
                tool
                for tool in enabled_tools
                if tool not in {
                    "memory_search",
                    "get_note",
                    "write_note",
                    "edit_note",
                    "link_notes",
                    "learn_generate_html_widget",
                    "learn_generate_mini_app",
                    "learn_generate_diagram",
                }
            ]

        assistant: AssistantManager = AssistantManager.from_config(
            content_store=chat_store._content_store,
            config=assistant_config,
            memory_filters=memory_filters,
            graph_store=graph_store if chat.graph_uid else None,
            graph_uid=chat.graph_uid,
            root_id=body.root_id,
            auto_mode=auto_mode,
            allowed_tiers=allowed_tiers,
            agent_bridge=request.app.agent_board_bridge if chat.graph_uid else None,
        )

        assistant.plan_agent.set_enabled_tools(enabled_tools)

        if body.force_tool:
            assistant.plan_agent.force_tool(body.force_tool)
        run_streamed = assistant.run_streamed

    try:
        logger.info("Sending LLM request in chat %s", chat_id)
        async for data in run_streamed(
            query=body.query,
            context=ReasoningContext(),
            session=session,
            message_id=body.message_id,
            message_context=body.message_context
        ):
            yield data

        # After streaming, update the chat's updated_at timestamp
        await chat_store.update_chat(chat_id, {})
    except Exception as e:
        # Handle any exceptions that occur during streaming
        logger.error(
            "Error while sending message in chat %s: %s",
            chat_id,
            str(e),
            exc_info=True
        )
        return


@router.patch("/{chat_id}/messages/{message_id}/", include_in_schema=False)
@router.patch("/{chat_id}/messages/{message_id}")
@with_standard_response
async def update_message(
    response: Response,
    request: Request,
    chat_id: Annotated[str, Path(description="Chat ID")],
    message_id: Annotated[str, Path(description="Message ID")],
    body: Annotated[MessageUpdateRequest, Body(description="Message update data")],
    _: Annotated[None, Depends(verify_chat_user)],
):
    """Update a message in a chat."""
    chat_store: ChatStore = request.app.chat_store
    await chat_store.update_message(message_id, body.data)
    return {"message": "Message updated successfully"}


@router.get("/{chat_id}/messages/", include_in_schema=False)
@router.get("/{chat_id}/messages")
@with_standard_response
async def list_messages(
    response: Response,
    request: Request,
    chat_id: Annotated[str, Path(description="Chat ID")],
    _: Annotated[None, Depends(verify_chat_user)],
):
    """List all messages in a chat."""
    chat_store: ChatStore = request.app.chat_store
    try:
        messages = await chat_store.get_messages(chat_uid=chat_id)
    except Exception as e:
        logger.error(
            "Error while listing messages in chat %s: %s",
            chat_id,
            str(e),
            exc_info=True
        )
        messages = []
    return {"messages": [msg.model_dump(exclude_none=True) for msg in messages]}
