"""Router tests for PATCH /chats/{chat_id} request validation.

Only `label` and `graph_uid` may be changed by clients; any other key must be
rejected with 422 before the store is called.
"""

import pytest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from topix.api.datatypes.requests import ChatUpdateData
from topix.api.router.chats import router
from topix.api.utils.security import get_current_user_uid
from topix.datatypes.chat.chat import Chat
from topix.store.postgres.chat import CHAT_UPDATABLE_COLUMNS


class _FakeChatStore:
    """In-memory ChatStore exposing what the update route and its auth dep use."""

    def __init__(self):
        """Init with one chat owned by u1."""
        self.chats = {"c1": Chat(uid="c1", user_uid="u1", label="old")}
        self.updates: list[tuple[str, dict]] = []

    async def get_chat(self, chat_uid: str) -> Chat | None:
        """Return the chat used by verify_chat_user."""
        return self.chats.get(chat_uid)

    async def update_chat(self, chat_uid: str, data: dict):
        """Record the update payload."""
        self.updates.append((chat_uid, data))


def _build_client(user_uid: str = "u1") -> tuple[TestClient, _FakeChatStore]:
    """Wire the chats router with a fake store and a fixed authenticated user."""
    app = FastAPI()
    app.include_router(router)
    store = _FakeChatStore()
    app.chat_store = store

    async def _fake_current_user_uid():
        """Fake current user uid."""
        return user_uid

    app.dependency_overrides[get_current_user_uid] = _fake_current_user_uid
    return TestClient(app), store


def test_label_update_is_forwarded():
    """A plain label rename reaches the store unchanged."""
    client, store = _build_client()
    response = client.patch("/chats/c1", json={"data": {"label": "new"}})

    assert response.status_code == 200
    assert store.updates == [("c1", {"label": "new"})]


def test_graph_uid_can_be_set_and_cleared():
    """graph_uid is allowed, and an explicit null is forwarded."""
    client, store = _build_client()
    assert client.patch("/chats/c1", json={"data": {"graph_uid": "g1"}}).status_code == 200
    assert client.patch("/chats/c1", json={"data": {"graph_uid": None}}).status_code == 200

    assert store.updates == [("c1", {"graph_uid": "g1"}), ("c1", {"graph_uid": None})]


@pytest.mark.parametrize(
    "key",
    [
        "user_uid",
        "created_at",
        "deleted_at",
        "unknown_field",
        "label = label, user_uid",
    ],
)
def test_keys_outside_the_model_are_rejected(key):
    """Only label/graph_uid are accepted; anything else is a 422 and never reaches the store."""
    client, store = _build_client()
    response = client.patch("/chats/c1", json={"data": {key: "x"}})

    assert response.status_code == 422
    assert store.updates == []


def test_non_owner_is_still_forbidden():
    """Ownership check still runs for valid payloads."""
    client, store = _build_client(user_uid="someone-else")
    response = client.patch("/chats/c1", json={"data": {"label": "x"}})

    assert response.status_code == 403
    assert store.updates == []


def test_request_model_matches_store_allowlist():
    """Every field the API accepts must be writable by the store (else a valid PATCH would 500)."""
    assert set(ChatUpdateData.model_fields) == CHAT_UPDATABLE_COLUMNS
