"""Snapshot helpers and retention policy for note revisions."""

from __future__ import annotations

import hashlib
import json

from datetime import UTC, datetime, timedelta

import asyncpg
import zstandard as zstd

from topix.datatypes.file.document import Document
from topix.datatypes.note.note import Note
from topix.store.postgres.note_revision import (
    NoteRevisionRecord,
    create_note_revisions_table,
    delete_note_revision,
    get_latest_note_revision,
    insert_note_revision,
    prune_note_revisions,
    replace_note_revision,
)
from topix.store.postgres.note_revision import (
    list_note_revisions as list_note_revision_rows,
)
from topix.utils.common import gen_uid

DEFAULT_MAX_NOTE_SNAPSHOTS = 7
DEFAULT_NOTE_SNAPSHOT_WINDOW = timedelta(hours=6)


def serialize_note_snapshot(note: Note) -> bytes:
    """Serialize a note deterministically for hashing and compression."""
    return json.dumps(
        note.model_dump(exclude_none=True),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def compute_snapshot_hash(snapshot_bytes: bytes) -> str:
    """Return a stable SHA-256 hash for a serialized note snapshot."""
    return hashlib.sha256(snapshot_bytes).hexdigest()


def compress_snapshot(snapshot_bytes: bytes) -> tuple[str, bytes]:
    """Compress a snapshot payload with zstd."""
    compressor = zstd.ZstdCompressor(level=3)
    return "zstd", compressor.compress(snapshot_bytes)


def decompress_snapshot(compression: str, snapshot_compressed: bytes) -> bytes:
    """Decompress a stored snapshot payload."""
    if compression != "zstd":
        raise ValueError(f"Unsupported snapshot compression: {compression}")
    decompressor = zstd.ZstdDecompressor()
    return decompressor.decompress(snapshot_compressed)


def deserialize_note_snapshot(compression: str, snapshot_compressed: bytes) -> Note:
    """Deserialize a compressed snapshot back into its note model.

    Document snapshots (`type: document`, a Note subclass) restore as
    `Document`; validating them as `Note` fails its `type` literal.
    """
    snapshot_bytes = decompress_snapshot(compression, snapshot_compressed)
    snapshot_dict = json.loads(snapshot_bytes.decode("utf-8"))
    model = Document if snapshot_dict.get("type") == "document" else Note
    return model.model_validate(snapshot_dict)


class NoteRevisionStore:
    """Persist and prune note snapshots for later restore workflows."""

    def __init__(
        self,
        pool: asyncpg.Pool,
        max_snapshots_per_note: int = DEFAULT_MAX_NOTE_SNAPSHOTS,
        merge_window: timedelta = DEFAULT_NOTE_SNAPSHOT_WINDOW,
    ):
        """Initialize the note revision store with retention settings."""
        self.pool = pool
        self.max_snapshots_per_note = max_snapshots_per_note
        self.merge_window = merge_window

    async def ensure_table(self) -> None:
        """Create the revision table and index when they do not exist."""
        async with self.pool.acquire() as conn:
            await create_note_revisions_table(conn)

    async def save_note_snapshot(
        self,
        note: Note,
        user_uid: str | None = None,
    ) -> None:
        """Store a snapshot unless it matches the latest or merges into it."""
        snapshot_bytes = serialize_note_snapshot(note)
        snapshot_hash = compute_snapshot_hash(snapshot_bytes)
        compression, snapshot_compressed = compress_snapshot(snapshot_bytes)
        now = datetime.now(UTC)

        async with self.pool.acquire() as conn:
            latest = await get_latest_note_revision(conn, note.id)
            if latest is not None and latest.snapshot_hash == snapshot_hash:
                return

            if latest is not None and (now - latest.created_at) <= self.merge_window:
                await replace_note_revision(
                    conn=conn,
                    revision_id=latest.id,
                    user_uid=user_uid,
                    created_at=now,
                    snapshot_hash=snapshot_hash,
                    compression=compression,
                    snapshot_compressed=snapshot_compressed,
                )
            else:
                await insert_note_revision(
                    conn,
                    NoteRevisionRecord(
                        id=gen_uid(),
                        note_id=note.id,
                        user_uid=user_uid,
                        created_at=now,
                        snapshot_hash=snapshot_hash,
                        compression=compression,
                        snapshot_compressed=snapshot_compressed,
                    ),
                )

            await prune_note_revisions(conn, note.id, self.max_snapshots_per_note)

    async def list_note_revisions(self, note_id: str) -> list[NoteRevisionRecord]:
        """Return note snapshots from newest to oldest."""
        async with self.pool.acquire() as conn:
            return await list_note_revision_rows(conn, note_id)

    async def get_latest_note_revision(self, note_id: str) -> NoteRevisionRecord | None:
        """Return the latest stored revision for a note."""
        async with self.pool.acquire() as conn:
            return await get_latest_note_revision(conn, note_id)

    async def pop_latest_note_revision(self, note_id: str) -> NoteRevisionRecord | None:
        """Return and delete the latest stored revision for a note."""
        async with self.pool.acquire() as conn:
            latest = await get_latest_note_revision(conn, note_id)
            if latest is None:
                return None

            await delete_note_revision(conn, latest.id)
            return latest
