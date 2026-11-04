"""Column allowlist guard for Postgres helpers that build SQL from dict keys."""

from collections.abc import Iterable


def ensure_allowed_columns(keys: Iterable[str], allowed: frozenset[str], table: str) -> None:
    """Raise ValueError if any key is not an allowlisted column of `table`.

    Dynamic UPDATE/UPSERT helpers interpolate keys into SQL as identifiers, so
    they must restrict keys to a hard-coded allowlist before building the
    query: either by calling this (fail closed) or by filtering against one
    (as update_graph_by_uid does for PATCH /boards payloads).
    """
    unknown = set(keys) - allowed
    if unknown:
        raise ValueError(f"Cannot write {table} columns: {sorted(unknown)}")
