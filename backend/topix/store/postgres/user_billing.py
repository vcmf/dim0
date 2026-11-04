"""User billing Postgres store."""

from datetime import datetime

import asyncpg

from topix.datatypes.user_billing import UserBilling
from topix.store.postgres.columns import ensure_allowed_columns

# Columns a billing update/upsert may touch. Keys are interpolated into SQL,
# so this allowlist is the only thing keeping identifiers safe; extend it deliberately.
BILLING_UPDATABLE_COLUMNS = frozenset({
    "plan",
    "status",
    "stripe_customer_id",
    "stripe_subscription_id",
    "current_period_start",
    "current_period_end",
    "cancel_at_period_end",
})


async def create_user_billing(
    conn: asyncpg.Connection,
    billing: UserBilling
) -> UserBilling:
    """Create a new user billing record."""
    query = (
        "INSERT INTO user_billing ("
        "user_uid, plan, status, stripe_customer_id, stripe_subscription_id, "
        "current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at"
        ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)"
    )
    await conn.execute(
        query,
        billing.user_uid,
        billing.plan,
        billing.status,
        billing.stripe_customer_id,
        billing.stripe_subscription_id,
        billing.current_period_start,
        billing.current_period_end,
        billing.cancel_at_period_end,
        billing.created_at,
        billing.updated_at,
    )
    return billing


async def get_user_billing_by_uid(
    conn: asyncpg.Connection,
    user_uid: str
) -> UserBilling | None:
    """Fetch a user billing record by user UID."""
    query = (
        "SELECT user_uid, plan, status, stripe_customer_id, stripe_subscription_id, "
        "current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at "
        "FROM user_billing WHERE user_uid = $1"
    )
    row = await conn.fetchrow(query, user_uid)
    if not row:
        return None
    return UserBilling(
        user_uid=row["user_uid"],
        plan=row["plan"],
        status=row["status"],
        stripe_customer_id=row["stripe_customer_id"],
        stripe_subscription_id=row["stripe_subscription_id"],
        current_period_start=row["current_period_start"].isoformat() if row["current_period_start"] else None,
        current_period_end=row["current_period_end"].isoformat() if row["current_period_end"] else None,
        cancel_at_period_end=row["cancel_at_period_end"],
        created_at=row["created_at"].isoformat() if row["created_at"] else None,
        updated_at=row["updated_at"].isoformat() if row["updated_at"] else None,
    )


async def get_user_billing_by_customer_id(
    conn: asyncpg.Connection,
    stripe_customer_id: str,
) -> UserBilling | None:
    """Fetch a user billing record by Stripe customer ID."""
    query = (
        "SELECT user_uid, plan, status, stripe_customer_id, stripe_subscription_id, "
        "current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at "
        "FROM user_billing WHERE stripe_customer_id = $1"
    )
    row = await conn.fetchrow(query, stripe_customer_id)
    if not row:
        return None
    return UserBilling(
        user_uid=row["user_uid"],
        plan=row["plan"],
        status=row["status"],
        stripe_customer_id=row["stripe_customer_id"],
        stripe_subscription_id=row["stripe_subscription_id"],
        current_period_start=row["current_period_start"].isoformat() if row["current_period_start"] else None,
        current_period_end=row["current_period_end"].isoformat() if row["current_period_end"] else None,
        cancel_at_period_end=row["cancel_at_period_end"],
        created_at=row["created_at"].isoformat() if row["created_at"] else None,
        updated_at=row["updated_at"].isoformat() if row["updated_at"] else None,
    )


async def get_user_billing_by_subscription_id(
    conn: asyncpg.Connection,
    stripe_subscription_id: str,
) -> UserBilling | None:
    """Fetch a user billing record by Stripe subscription ID."""
    query = (
        "SELECT user_uid, plan, status, stripe_customer_id, stripe_subscription_id, "
        "current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at "
        "FROM user_billing WHERE stripe_subscription_id = $1"
    )
    row = await conn.fetchrow(query, stripe_subscription_id)
    if not row:
        return None
    return UserBilling(
        user_uid=row["user_uid"],
        plan=row["plan"],
        status=row["status"],
        stripe_customer_id=row["stripe_customer_id"],
        stripe_subscription_id=row["stripe_subscription_id"],
        current_period_start=row["current_period_start"].isoformat() if row["current_period_start"] else None,
        current_period_end=row["current_period_end"].isoformat() if row["current_period_end"] else None,
        cancel_at_period_end=row["cancel_at_period_end"],
        created_at=row["created_at"].isoformat() if row["created_at"] else None,
        updated_at=row["updated_at"].isoformat() if row["updated_at"] else None,
    )


async def update_user_billing_by_uid(
    conn: asyncpg.Connection,
    user_uid: str,
    updated_data: dict
):
    """Update user billing information by user UID.

    Raises ValueError if any key is outside BILLING_UPDATABLE_COLUMNS.
    """
    ensure_allowed_columns(updated_data, BILLING_UPDATABLE_COLUMNS, "user_billing")
    if not updated_data:
        return

    set_clauses = [f"{k} = ${i + 1}" for i, k in enumerate(updated_data.keys())]
    values = list(updated_data.values())

    set_clauses.append(f"updated_at = ${len(values) + 1}")
    values.append(datetime.now())

    values.append(user_uid)
    query = f"UPDATE user_billing SET {', '.join(set_clauses)} WHERE user_uid = ${len(values)}"
    await conn.execute(query, *values)


async def upsert_user_billing_by_uid(
    conn: asyncpg.Connection,
    user_uid: str,
    data: dict
):
    """Upsert user billing data by user UID.

    Raises ValueError if any key is outside BILLING_UPDATABLE_COLUMNS.
    """
    ensure_allowed_columns(data, BILLING_UPDATABLE_COLUMNS, "user_billing")
    if not data:
        return

    columns = ["user_uid", *data.keys()]
    values = [user_uid, *data.values()]
    placeholders = [f"${idx}" for idx in range(1, len(values) + 1)]

    update_assignments = ", ".join(
        [f"{key} = EXCLUDED.{key}" for key in data.keys()] + ["updated_at = NOW()"]
    )

    query = (
        f"INSERT INTO user_billing ({', '.join(columns)}) "
        f"VALUES ({', '.join(placeholders)}) "
        f"ON CONFLICT (user_uid) DO UPDATE SET {update_assignments}"
    )
    await conn.execute(query, *values)


async def delete_user_billing_by_uid(
    conn: asyncpg.Connection,
    user_uid: str
):
    """Delete a user billing record by user UID."""
    query = "DELETE FROM user_billing WHERE user_uid = $1"
    await conn.execute(query, user_uid)
