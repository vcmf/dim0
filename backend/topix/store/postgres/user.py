"""User Base Postgres Store."""
from datetime import datetime

import asyncpg

from topix.datatypes.user import User
from topix.store.postgres.columns import ensure_allowed_columns

# Columns the generic user update may touch. Keys are interpolated into SQL,
# so this allowlist is the only thing keeping identifiers safe. Identity/auth columns (email,
# google_*, auth_provider, email_verified_at) have dedicated helpers and are
# deliberately excluded; extend only when a caller needs it.
USER_UPDATABLE_COLUMNS = frozenset({
    "name",
    "username",
    "password_hash",
    "password_changed_at",
})


def _build_user_from_row(row: asyncpg.Record) -> User:
    """Hydrate a User model from a Postgres result row."""
    return User(
        id=row["id"],
        uid=row["uid"],
        email=row["email"],
        username=row["username"],
        name=row["name"],
        password_hash=row["password_hash"] if row["password_hash"] else None,
        auth_provider=row["auth_provider"],
        google_sub=row["google_sub"],
        google_email=row["google_email"],
        google_picture_url=row["google_picture_url"],
        google_linked_at=row["google_linked_at"].isoformat() if row["google_linked_at"] else None,
        email_verified_at=row["email_verified_at"].isoformat() if row["email_verified_at"] else None,
        password_changed_at=row["password_changed_at"].isoformat() if row["password_changed_at"] else None,
        created_at=row["created_at"].isoformat() if row["created_at"] else None,
        updated_at=row["updated_at"].isoformat() if row["updated_at"] else None,
        deleted_at=row["deleted_at"].isoformat() if row["deleted_at"] else None,
    )


def _raise_user_constraint_error(error: asyncpg.exceptions.UniqueViolationError) -> None:
    """Translate unique constraint failures to stable domain errors."""
    msg = str(error)
    if "uid" in msg:
        raise ValueError("UID already exists")
    if "email" in msg:
        raise ValueError("Email already exists")
    if "username" in msg:
        raise ValueError("Username already exists")
    if "google_sub" in msg:
        raise ValueError("Google account already linked")
    raise ValueError("User already exists")


async def create_user(conn: asyncpg.Connection, user: User) -> User:
    """Create a new user in the database."""
    query = (
        "INSERT INTO users ("
        "uid, email, username, name, created_at, password_hash, auth_provider, "
        "google_sub, google_email, google_picture_url, google_linked_at, email_verified_at"
        ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id"
    )
    try:
        user_id = await conn.fetchval(
            query,
            user.uid,
            user.email,
            user.username,
            user.name,
            user.created_at,
            user.password_hash,
            user.auth_provider,
            user.google_sub,
            user.google_email,
            user.google_picture_url,
            user.google_linked_at,
            user.email_verified_at,
        )
        user.id = user_id
        return user
    except asyncpg.exceptions.UniqueViolationError as e:
        _raise_user_constraint_error(e)


async def get_user_by_uid(conn: asyncpg.Connection, uid: str) -> User | None:
    """Fetch a user by their unique identifier (UID)."""
    query = (
        "SELECT id, uid, email, username, name, password_hash, auth_provider, google_sub, "
        "google_email, google_picture_url, google_linked_at, email_verified_at, "
        "password_changed_at, created_at, updated_at, deleted_at "
        "FROM users WHERE uid = $1"
    )
    row = await conn.fetchrow(query, uid)
    if not row:
        return None
    return _build_user_from_row(row)


async def get_user_by_email(conn: asyncpg.Connection, email: str) -> User | None:
    """Fetch a user by their email."""
    query = (
        "SELECT id, uid, email, username, name, password_hash, auth_provider, google_sub, "
        "google_email, google_picture_url, google_linked_at, email_verified_at, "
        "password_changed_at, created_at, updated_at, deleted_at "
        "FROM users WHERE email = $1"
    )
    row = await conn.fetchrow(query, email)
    if not row:
        return None
    return _build_user_from_row(row)


async def get_user_by_google_sub(conn: asyncpg.Connection, google_sub: str) -> User | None:
    """Fetch a user by their linked Google subject identifier."""
    query = (
        "SELECT id, uid, email, username, name, password_hash, auth_provider, google_sub, "
        "google_email, google_picture_url, google_linked_at, email_verified_at, "
        "password_changed_at, created_at, updated_at, deleted_at "
        "FROM users WHERE google_sub = $1"
    )
    row = await conn.fetchrow(query, google_sub)
    if not row:
        return None
    return _build_user_from_row(row)


async def update_user_by_uid(conn: asyncpg.Connection, uid: str, updated_data: dict):
    """Update user information by UID.

    Raises ValueError if any key is outside USER_UPDATABLE_COLUMNS.
    """
    ensure_allowed_columns(updated_data, USER_UPDATABLE_COLUMNS, "users")
    if not updated_data:
        return

    # Build dynamic query with positional parameters
    set_clauses = [f"{k} = ${i + 1}" for i, k in enumerate(updated_data.keys())]
    set_clause = ', '.join(set_clauses)
    values = list(updated_data.values())

    # Always set updated_at to now
    set_clause += f", updated_at = ${len(values) + 1}"
    values.append(datetime.now())

    # Add uid as the last parameter
    values.append(uid)
    query = f"UPDATE users SET {set_clause} WHERE uid = ${len(values)}"

    try:
        await conn.execute(query, *values)
    except asyncpg.exceptions.UniqueViolationError as e:
        _raise_user_constraint_error(e)


async def link_google_account_by_uid(
    conn: asyncpg.Connection,
    uid: str,
    google_sub: str,
    google_email: str,
    google_picture_url: str | None,
    linked_at: datetime | None = None,
) -> None:
    """Attach a Google identity to an existing user and update provider state."""
    effective_linked_at = linked_at or datetime.now()
    query = (
        "UPDATE users "
        "SET google_sub = $1, "
        "google_email = $2, "
        "google_picture_url = $3, "
        "google_linked_at = $4, "
        "auth_provider = CASE "
        "    WHEN password_hash IS NOT NULL THEN 'local_google' "
        "    ELSE 'google' "
        "END, "
        "updated_at = NOW() "
        "WHERE uid = $5"
    )
    try:
        await conn.execute(
            query,
            google_sub,
            google_email,
            google_picture_url,
            effective_linked_at,
            uid,
        )
    except asyncpg.exceptions.UniqueViolationError as e:
        _raise_user_constraint_error(e)


async def delete_user_by_uid(conn: asyncpg.Connection, uid: str):
    """Soft delete a user by setting deleted_at to now."""
    query = "UPDATE users SET deleted_at = NOW() WHERE uid = $1"
    await conn.execute(query, uid)


async def mark_user_email_verified_by_uid(
    conn: asyncpg.Connection,
    uid: str,
) -> None:
    """Set email_verified_at for a user if not already set."""
    query = (
        "UPDATE users "
        "SET email_verified_at = COALESCE(email_verified_at, NOW()), updated_at = NOW() "
        "WHERE uid = $1"
    )
    await conn.execute(query, uid)


async def get_user_id_by_uid(conn: asyncpg.Connection, user_uid: str) -> int | None:
    """Fetch user integer ID from their UID."""
    query = "SELECT id FROM users WHERE uid = $1"
    return await conn.fetchval(query, user_uid)


async def _dangerous_hard_delete_user_by_uid(
    conn: asyncpg.Connection,
    uid: str
) -> None:
    """Hard delete a user by UID (use with caution!)."""
    query = "DELETE FROM users WHERE uid = $1"
    await conn.execute(query, uid)
