"""API Request Models."""

from typing import Literal

from pydantic import BaseModel

from topix.agents.datatypes.tools import AgentToolName
from topix.agents.datatypes.web_search import WebSearchOption
from topix.datatypes.note.link import Link
from topix.datatypes.note.note import Note


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
