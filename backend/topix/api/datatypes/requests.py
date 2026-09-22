"""API Request Models."""

import logging

from typing import Literal

from pydantic import BaseModel, field_validator

from topix.agents.datatypes.tools import AgentToolName
from topix.agents.datatypes.web_search import WebSearchOption
from topix.datatypes.note.link import Link
from topix.datatypes.note.note import Note

logger = logging.getLogger(__name__)

# The tool names this backend agent implements. Built once (the enum is
# immutable) and used to drop tool names the browser-agent frontend sends that
# this legacy agent has no member for, instead of 422ing the whole request.
_VALID_TOOL_NAMES = frozenset(t.value for t in AgentToolName)


class UserSignupRequest(BaseModel):
    """Request model for user signup."""

    email: str
    password: str
    name: str
    username: str


class GoogleSigninRequest(BaseModel):
    """Request model for Google sign-in token exchange."""

    id_token: str


class GoogleDesktopSigninRequest(BaseModel):
    """Desktop loopback Google sign-in: auth code + PKCE verifier + the redirect URI."""

    code: str
    code_verifier: str
    redirect_uri: str


class GoogleWebRedirectSigninRequest(BaseModel):
    """Web redirect Google sign-in: auth code + PKCE verifier + the redirect URI."""

    code: str
    code_verifier: str
    redirect_uri: str


class RefreshRequest(BaseModel):
    """Refresh token request model."""

    refresh_token: str


class EmailVerificationRequest(BaseModel):
    """Request model for email verification token checks."""

    token: str


class ForgotPasswordRequest(BaseModel):
    """Request model for initiating a password reset."""

    email: str


class ResetPasswordRequest(BaseModel):
    """Request model for completing a password reset with a token."""

    token: str
    new_password: str


class BillingCheckoutRequest(BaseModel):
    """Request model for creating a Stripe checkout session."""

    plan: Literal["basic", "plus"] = "plus"
    success_url: str | None = None
    cancel_url: str | None = None


class BillingPortalRequest(BaseModel):
    """Request model for creating a Stripe customer portal session."""

    return_url: str | None = None


class SendMessageRequest(BaseModel):
    """Request model for sending a message to a chat."""

    message_id: str | None = None
    query: str
    root_id: str | None = None
    model: str = "auto"
    web_search_engine: WebSearchOption = WebSearchOption.PERPLEXITY
    force_tool: AgentToolName | None = None

    enabled_tools: list[AgentToolName] = [
        AgentToolName.WEB_SEARCH,
        AgentToolName.MEMORY_SEARCH,
        AgentToolName.CODE_INTERPRETER,
        AgentToolName.WRITE_NOTE,
        AgentToolName.EDIT_NOTE,
        AgentToolName.GET_NOTE,
        AgentToolName.NAVIGATE,
        AgentToolName.IMAGE_GENERATION,
        AgentToolName.DISPLAY_STOCK_WIDGET,
        AgentToolName.DISPLAY_WEATHER_WIDGET,
        AgentToolName.DISPLAY_IMAGE_SEARCH_WIDGET,
    ]
    reasoning_effort: Literal["low", "medium", "high"] | None = None
    use_deep_research: bool = False

    message_context: str | None = None

    @field_validator("enabled_tools", mode="before")
    @classmethod
    def _drop_unknown_tools(cls, v: object) -> object:
        """Ignore tool names this agent doesn't implement instead of rejecting the request.

        The browser-agent frontend sends its own toolset (e.g. `learn_generate_applet`,
        which this legacy agent has no `AgentToolName` member for). Without this, one
        unknown name 422s the whole message. Drop unknown strings (keeping non-strings
        and known names); the agent runs with the tools it does support.
        """
        if not isinstance(v, (list, tuple)):
            return v
        kept = [t for t in v if not isinstance(t, str) or t in _VALID_TOOL_NAMES]
        if len(kept) != len(v):
            dropped = [t for t in v if isinstance(t, str) and t not in _VALID_TOOL_NAMES]
            # Routine (the frontend always sends a couple of browser-agent-only tools)
            # → debug. Only the degenerate all-dropped case, where the agent would run
            # with no tools at all, is worth a warning.
            if kept:
                logger.debug("send_message dropped unknown enabled_tools: %s", dropped)
            else:
                logger.warning("send_message: all enabled_tools unknown, agent runs tool-less; dropped %s", dropped)
        return kept

    @field_validator("force_tool", mode="before")
    @classmethod
    def _drop_unknown_force_tool(cls, v: object) -> object:
        """Map a forced tool this agent doesn't implement to None (no force) rather than 422.

        Same tolerance as `enabled_tools` for the same reason — the frontend toolset can
        name tools absent from this legacy agent's enum.
        """
        if isinstance(v, str) and v not in _VALID_TOOL_NAMES:
            logger.warning("send_message dropped unknown force_tool: %s", v)
            return None
        return v


class ChatUpdateRequest(BaseModel):
    """Request model for updating a chat."""

    data: dict


class MessageUpdateRequest(BaseModel):
    """Request model for updating a message."""

    data: dict


class StoreTranscriptRequest(BaseModel):
    """Request model for storing a browser-agent chat transcript.

    ``transcript`` is the client's message array, stored verbatim as opaque
    JSON (no server-side chat model). ``board_id``/``label`` are metadata used
    for cross-device seed and the chat list.
    """

    transcript: list[dict]
    board_id: str | None = None
    label: str | None = None


class GraphUpdateRequest(BaseModel):
    """Request model for updating a graph."""

    data: dict


class BoardVisibilityUpdateRequest(BaseModel):
    """Request model for updating board visibility."""

    visibility: Literal["private", "public"]


class AdoptGraphRequest(BaseModel):
    """Body for adopting a local board into a synced graph (local → synced).

    `ops` is a batch of wire ops (node.add / edge.add …) describing the board's
    full current content — the same wire shape the collab relay applies — so the
    server rebuilds the graph via the existing apply_batch path. `label` seeds
    the board title.
    """

    ops: list[dict] = []
    label: str | None = None


class NoteUpdateRequest(BaseModel):
    """Request model for updating a note."""

    data: dict


class LinkUpdateRequest(BaseModel):
    """Request model for updating a link."""

    data: dict


class DocumentUpdateRequest(BaseModel):
    """Request model for updating a document."""

    data: dict


class SubscriptionUpdateRequest(BaseModel):
    """Request model for updating a subscription."""

    data: dict


class AddSubscriptionRequest(BaseModel):
    """Request model for adding a subscription."""

    topic: str
    raw_description: str | None = None
    uid: str | None = None


class NewsfeedUpdateRequest(BaseModel):
    """Request model for updating a newsfeed."""

    data: dict


class AddNotesRequest(BaseModel):
    """Request model for adding notes to a graph."""

    notes: list[Note]


class AddLinksRequest(BaseModel):
    """Request model for adding links to a graph."""

    links: list[Link]


class ConvertToMindMapRequest(BaseModel):
    """Request model for converting a graph to a mind map."""

    answer: str


class TranslateTextRequest(BaseModel):
    """Request model for translating text."""

    text: str
    target_language: str


class WebPagePreviewRequest(BaseModel):
    """Request model for fetching a preview of a webpage."""

    url: str
