"""Unit tests for the column allowlists guarding dynamic Postgres UPDATEs.

The chat / user / user_billing update helpers interpolate dict keys into the
SQL as column names, so only allowlisted columns may ever reach the query.
A fake connection records the SQL instead of hitting a database.
"""

import pytest

from topix.store.postgres.chat import CHAT_UPDATABLE_COLUMNS, update_chat_by_uid
from topix.store.postgres.user import USER_UPDATABLE_COLUMNS, update_user_by_uid
from topix.store.postgres.user_billing import (
    BILLING_UPDATABLE_COLUMNS,
    update_user_billing_by_uid,
    upsert_user_billing_by_uid,
)


class _RecordingConn:
    """Stand-in for asyncpg.Connection that records executed statements."""

    def __init__(self):
        """Init."""
        self.calls: list[tuple[str, tuple]] = []

    async def execute(self, query: str, *args):
        """Record the query and its bound parameters."""
        self.calls.append((query, args))


_NON_COLUMN_KEYS = [
    "label = label, user_uid",
    "name, username",
    "plan = plan, status",
    "not a column",
]

_UPDATERS = [
    (update_chat_by_uid, "label"),
    (update_user_by_uid, "name"),
    (update_user_billing_by_uid, "plan"),
]


@pytest.mark.parametrize("updater,_allowed", _UPDATERS)
@pytest.mark.parametrize("key", _NON_COLUMN_KEYS)
async def test_non_column_keys_are_rejected_before_any_query(updater, _allowed, key):
    """A key that is not an allowlisted column must raise and never produce a SQL statement."""
    conn = _RecordingConn()
    with pytest.raises(ValueError):
        await updater(conn, "uid-1", {key: "x"})
    assert conn.calls == []


@pytest.mark.parametrize("updater,allowed", _UPDATERS)
async def test_unknown_key_is_rejected_even_alongside_allowed_ones(updater, allowed):
    """Mixing a valid column with an unknown one must not partially apply."""
    conn = _RecordingConn()
    with pytest.raises(ValueError):
        await updater(conn, "uid-1", {allowed: "ok", "not_a_column": "x"})
    assert conn.calls == []


@pytest.mark.parametrize(
    "updater,key",
    [
        (update_chat_by_uid, "user_uid"),
        (update_chat_by_uid, "deleted_at"),
        (update_user_by_uid, "uid"),
        (update_user_by_uid, "created_at"),
        (update_user_by_uid, "email_verified_at"),
        (update_user_by_uid, "google_sub"),
        (update_user_billing_by_uid, "user_uid"),
    ],
)
async def test_real_but_protected_columns_are_rejected(updater, key):
    """Existing columns outside the allowlist (ownership, ids, timestamps) are refused."""
    conn = _RecordingConn()
    with pytest.raises(ValueError):
        await updater(conn, "uid-1", {key: "x"})
    assert conn.calls == []


async def test_chat_update_builds_parameterized_query():
    """Allowed chat columns produce a fully parameterized UPDATE."""
    conn = _RecordingConn()
    await update_chat_by_uid(conn, "chat-1", {"label": "hello", "graph_uid": None})

    [(query, args)] = conn.calls
    assert query == "UPDATE chats SET label = $1, graph_uid = $2, updated_at = $3 WHERE uid = $4"
    assert args[0] == "hello"
    assert args[1] is None
    assert args[3] == "chat-1"


async def test_chat_update_with_no_fields_only_touches_updated_at():
    """An empty update (used to bump a chat) still works."""
    conn = _RecordingConn()
    await update_chat_by_uid(conn, "chat-1", {})

    [(query, args)] = conn.calls
    assert query == "UPDATE chats SET updated_at = $1 WHERE uid = $2"
    assert args[1] == "chat-1"


async def test_user_password_reset_update_is_allowed():
    """The password-reset write path keeps working."""
    conn = _RecordingConn()
    await update_user_by_uid(conn, "user-1", {"password_hash": "h", "password_changed_at": None})

    [(query, args)] = conn.calls
    assert query == "UPDATE users SET password_hash = $1, password_changed_at = $2, updated_at = $3 WHERE uid = $4"
    assert args[-1] == "user-1"


async def test_billing_upsert_rejects_unknown_keys():
    """The upsert fails closed like the update, instead of silently dropping keys."""
    conn = _RecordingConn()
    with pytest.raises(ValueError):
        await upsert_user_billing_by_uid(conn, "user-1", {"plan": "plus", "trial_end": "x"})
    assert conn.calls == []


async def test_billing_upsert_builds_parameterized_query():
    """Allowed billing columns produce a parameterized upsert."""
    conn = _RecordingConn()
    await upsert_user_billing_by_uid(conn, "user-1", {"plan": "plus", "status": "active"})

    [(query, args)] = conn.calls
    assert query.startswith("INSERT INTO user_billing (user_uid, plan, status) VALUES ($1, $2, $3)")
    assert args == ("user-1", "plus", "active")


def test_allowlists_contain_only_plain_identifiers():
    """Every allowlisted name must be a bare lowercase identifier."""
    for name in CHAT_UPDATABLE_COLUMNS | USER_UPDATABLE_COLUMNS | BILLING_UPDATABLE_COLUMNS:
        assert name.isidentifier() and name == name.lower()
