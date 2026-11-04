"""Chat management functions for PostgreSQL backend."""

from datetime import datetime
from typing import Literal

import asyncpg

from topix.datatypes.chat.chat import Chat
from topix.store.postgres.columns import ensure_allowed_columns

# Columns a chat update may touch. Keys are interpolated into SQL, so this
# allowlist is the only thing keeping identifiers safe; extend it deliberately.
CHAT_UPDATABLE_COLUMNS = frozenset({"label", "graph_uid"})


async def create_chat(
    conn: asyncpg.Connection,
    chat: Chat
) -> Chat:
    """Insert a new chat using user_uid as FK and set its id after creation."""
    query = (
        "INSERT INTO chats (uid, label, user_uid, graph_uid, "
        "created_at, updated_at, deleted_at) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7) "
        "RETURNING id"
    )
    chat_id = await conn.fetchval(
        query,
        chat.uid,
        chat.label,
        chat.user_uid,
        chat.graph_uid,
        datetime.fromisoformat(chat.created_at) if chat.created_at else None,
        datetime.fromisoformat(chat.updated_at) if chat.updated_at else None,
        datetime.fromisoformat(chat.deleted_at) if chat.deleted_at else None,
    )
    chat.id = chat_id
    return chat


async def get_chat_by_uid(
    conn: asyncpg.Connection,
    uid: str
) -> Chat | None:
    """Fetch a chat by its UID.

    Returns None if not found.
    """
    query = (
        "SELECT id, uid, label, user_uid, "
        "graph_uid, created_at, updated_at, deleted_at "
        "FROM chats WHERE uid = $1"
    )
    row = await conn.fetchrow(query, uid)
    if not row:
        return None
    return Chat(
        id=row['id'],
        uid=row['uid'],
        label=row['label'],
        user_uid=row['user_uid'],
        graph_uid=row['graph_uid'],
        created_at=row['created_at'].isoformat() if row['created_at'] else None,
        updated_at=row['updated_at'].isoformat() if row['updated_at'] else None,
        deleted_at=row['deleted_at'].isoformat() if row['deleted_at'] else None
    )


async def update_chat_by_uid(
    conn: asyncpg.Connection,
    uid: str,
    updated_data: dict
):
    """Update chat fields by UID; always bumps updated_at.

    Raises ValueError if any key is outside CHAT_UPDATABLE_COLUMNS.
    """
    ensure_allowed_columns(updated_data, CHAT_UPDATABLE_COLUMNS, "chats")
    data = dict(updated_data)

    # Always set updated_at to now
    data['updated_at'] = datetime.now()

    # Build dynamic query with positional parameters
    set_clauses = [f"{k} = ${i + 1}" for i, k in enumerate(data.keys())]
    set_clause = ', '.join(set_clauses)
    values = list(data.values())

    # Add uid as the last parameter
    values.append(uid)
    query = f"UPDATE chats SET {set_clause} WHERE uid = ${len(values)}"

    await conn.execute(query, *values)


async def delete_chat_by_uid(
    conn: asyncpg.Connection,
    uid: str
):
    """Soft-delete a chat by setting deleted_at to now."""
    now = datetime.now()
    query = "UPDATE chats SET deleted_at = $1 WHERE uid = $2"
    await conn.execute(query, now, uid)


async def _dangerous_hard_delete_chat_by_uid(
    conn: asyncpg.Connection,
    uid: str
):
    """Hard delete a chat by UID. Use with caution."""
    query = "DELETE FROM chats WHERE uid = $1"
    await conn.execute(query, uid)


async def list_chats_by_user_uid(
    conn: asyncpg.Connection,
    user_uid: str,
    graph_uid: str | Literal["none", "any"] | None = None,
    offset: int = 0,
    limit: int = 100
) -> list[Chat]:
    """List all chats for a given user UID.

    Args:
        conn: asyncpg.Connection - Active database connection.
        user_uid: str - User UID to filter chats.
        graph_uid: str | Literal["none", "any"] | None - Optional Graph UID to filter chats.
            "none" filters for chats without a graph; "any" for chats with any graph attached.
        offset: int - Pagination offset.
        limit: int - Pagination limit.

    Returns:
        List[Chat]: List of Chat objects.

    """
    if graph_uid == "none":
        query = (
            "SELECT id, uid, label, user_uid, "
            "graph_uid, created_at, updated_at, deleted_at "
            "FROM chats WHERE user_uid = $1 "
            "AND graph_uid IS NULL "
            "AND deleted_at IS NULL "
            "ORDER BY COALESCE(updated_at, created_at) DESC "
            "LIMIT $2 OFFSET $3"
        )
        rows = await conn.fetch(query, user_uid, limit, offset)
    elif graph_uid == "any":
        query = (
            "SELECT id, uid, label, user_uid, "
            "graph_uid, created_at, updated_at, deleted_at "
            "FROM chats WHERE user_uid = $1 "
            "AND graph_uid IS NOT NULL "
            "AND deleted_at IS NULL "
            "ORDER BY COALESCE(updated_at, created_at) DESC "
            "LIMIT $2 OFFSET $3"
        )
        rows = await conn.fetch(query, user_uid, limit, offset)
    elif graph_uid is not None:
        query = (
            "SELECT id, uid, label, user_uid, "
            "graph_uid, created_at, updated_at, deleted_at "
            "FROM chats WHERE user_uid = $1 "
            "AND graph_uid = $2 "
            "AND deleted_at IS NULL "
            "ORDER BY COALESCE(updated_at, created_at) DESC "
            "LIMIT $3 OFFSET $4"
        )
        rows = await conn.fetch(query, user_uid, graph_uid, limit, offset)
    else:
        query = (
            "SELECT id, uid, label, user_uid, "
            "graph_uid, created_at, updated_at, deleted_at "
            "FROM chats WHERE user_uid = $1 "
            "AND deleted_at IS NULL "
            "ORDER BY COALESCE(updated_at, created_at) DESC "
            "LIMIT $2 OFFSET $3"
        )
        rows = await conn.fetch(query, user_uid, limit, offset)
    return [
        Chat(
            id=row['id'],
            uid=row['uid'],
            label=row['label'],
            user_uid=row['user_uid'],
            graph_uid=row['graph_uid'],
            created_at=row['created_at'].isoformat() if row['created_at'] else None,
            updated_at=row['updated_at'].isoformat() if row['updated_at'] else None,
            deleted_at=row['deleted_at'].isoformat() if row['deleted_at'] else None
        ) for row in rows
    ]
