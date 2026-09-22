"""Collaboration router — ticket mint endpoint + WebSocket session.

Per-board WebSocket session:

  1. Ticket exchange validates `(user_id, board_id)` and looks up the
     user's effective role on the board (owner / member / viewer).
     The role is stamped on the ticket and propagated to the WS
     handler via the consumed payload.
  2. On accept, a capacity check looks up the owner's plan and rejects
     joiners that would push the room over its plan-tier cap (close
     code 4429).
  3. `welcome { seq, snapshot }` is sent inside the room's lock so a
     racing `peer-op` cannot precede it on this socket.
  4. Incoming `{ kind: "op" }` from a viewer is rejected with
     `op-rejected { client_seq, reason: "read-only" }`. From an owner
     or member, the op is sequenced under the lock, applied to the
     GraphStore, broadcast as `peer-op` to other clients, and acked
     to the sender with `op-applied`.
  5. Other message kinds (presence, hello, presence-leave) still relay
     verbatim — those graduate to `peer-*` shapes in Phase 3.
"""

import json
import logging

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response, WebSocket, WebSocketDisconnect, status

from topix.api.utils.decorators import with_standard_response
from topix.api.utils.security import get_current_user_uid
from topix.collab.apply_ops import apply_batch, batch_had_persist_failure, should_reject_batch
from topix.collab.capacity import get_room_cap_for_board
from topix.collab.room import MAX_PRESENCE_PAYLOAD_BYTES, Client, Room, RoomRegistry
from topix.collab.snapshot import read_snapshot_payload
from topix.collab.tickets import consume_ticket, mint_ticket
from topix.store.collab_oplog import CollabOplogStore
from topix.store.graph import GraphStore

logger = logging.getLogger(__name__)


router = APIRouter(
    prefix="/boards",
    tags=["collab"],
    responses={404: {"description": "Not found"}},
)


# Close codes — 4000-4999 range is reserved for app-defined per RFC 6455.
WS_INVALID_TICKET = 4401
WS_BOARD_MISMATCH = 4403
WS_ROOM_FULL = 4429

_ACCESS_ROLES = frozenset({"owner", "member", "viewer"})
_EDIT_ROLES = frozenset({"owner", "member"})


@router.post("/{graph_id}/collab/ticket/", include_in_schema=False)
@router.post("/{graph_id}/collab/ticket")
@with_standard_response
async def mint_collab_ticket(
    response: Response,
    request: Request,
    graph_id: Annotated[str, Path(description="Graph ID")],
    user_id: Annotated[str, Depends(get_current_user_uid)],
):
    """Mint a short-lived single-use ticket the client exchanges on WS upgrade.

    Resolves the user's effective role on the board inline (replaces
    the previous `verify_board_member` dep — we need the role anyway,
    and viewers must be allowed through). 404 for users with no role
    so we don't leak board existence.
    """
    graph_store: GraphStore = request.app.graph_store
    role = await graph_store.get_graph_role(graph_uid=graph_id, user_uid=user_id)
    if role not in _ACCESS_ROLES:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Board not found")
    token = await mint_ticket(
        request.app.redis_store, user_id=user_id, board_id=graph_id, role=role,
    )
    return {"ticket": token, "expires_in": 30, "role": role}


@router.websocket("/{graph_id}/collab")
async def collab_ws(  # noqa: C901 — accept/auth/join/welcome/loop is a single state machine, splitting hurts readability
    websocket: WebSocket,
    graph_id: Annotated[str, Path(description="Graph ID")],
    ticket: Annotated[str | None, Query(description="One-shot auth ticket")] = None,
    since_seq: Annotated[
        int | None,
        Query(
            description="Highest seq the client has previously observed; "
            "set on reconnect for catch-up mode. Omit on first connect.",
            ge=0,
        ),
    ] = None,
    root_id: Annotated[
        str | None,
        Query(
            description="Folder scope of the client's current view. Mirrors "
            "the REST `getBoard` query: when set, the welcome snapshot is "
            "scoped to nodes under this parent so the WS hand-off doesn't "
            "replace a folder view with the whole-board contents.",
        ),
    ] = None,
    proto: Annotated[
        int,
        Query(
            description="Wire protocol version. v1 (default, the legacy "
            "use-ws-collab client): welcome catch-up sends `batches: OpBatch[]`. "
            "v2 (the offline-first coordinator): sends `batches: {seq, batch}[]` "
            "so each batch carries its relay seq for serverSeq-ordered replay.",
            ge=1,
        ),
    ] = 1,
):
    """Per-board relay socket.

    Authenticates via a one-shot Redis-backed ticket, then forwards
    every text frame to other clients in the room. Self-echo
    suppression is handled by excluding the sender from broadcast.
    """
    if not ticket:
        await websocket.close(code=WS_INVALID_TICKET, reason="missing ticket")
        return

    payload = await consume_ticket(websocket.app.redis_store, ticket)
    if not payload:
        await websocket.close(code=WS_INVALID_TICKET, reason="invalid or expired ticket")
        return
    if payload.get("board_id") != graph_id:
        await websocket.close(code=WS_BOARD_MISMATCH, reason="ticket board mismatch")
        return

    user_id: str = payload["user_id"]
    role: str = payload.get("role", "member")

    graph_store = websocket.app.graph_store
    user_billing_store = websocket.app.user_billing_store
    registry: RoomRegistry = websocket.app.collab_rooms
    oplog: CollabOplogStore = websocket.app.collab_oplog

    # Owner's plan caps the room. Done BEFORE accept() so the rejected
    # joiner sees an HTTP 403 on the upgrade rather than an immediate
    # WS close (cleaner UX for the "room full" error).
    try:
        max_size = await get_room_cap_for_board(
            graph_store=graph_store,
            user_billing_store=user_billing_store,
            board_uid=graph_id,
        )
    except Exception:
        logger.exception("collab capacity lookup failed board=%s", graph_id)
        max_size = None  # fail open — log + allow rather than block on infra hiccup

    await websocket.accept()

    room, client = await registry.join(
        graph_id, websocket, user_id, role=role, max_size=max_size,
    )
    if client is None:
        logger.info(
            "collab room-full board=%s user=%s (cap=%s)",
            graph_id, user_id, max_size,
        )
        await websocket.close(code=WS_ROOM_FULL, reason="room-full")
        return
    logger.info(
        "collab join board=%s user=%s role=%s client=%s",
        graph_id, user_id, role, client.client_id,
    )

    # Welcome handshake — dispatch under the room lock so a racing
    # op-handler can't queue a `peer-op` on this socket before the
    # welcome lands. Phase 1c.2: three modes based on `since_seq`:
    #
    #   - `None` (first connect)              → snapshot
    #   - >= room.seq (already current)       → live (no payload)
    #   - in buffer range (`since_seq < seq`) → catch-up batches
    #   - past buffer floor (drifted)         → snapshot fallback
    try:
        await _send_welcome(
            websocket=websocket,
            room=room,
            client_id=client.client_id,
            graph_store=graph_store,
            oplog=oplog,
            board_id=graph_id,
            root_id=root_id,
            since_seq=since_seq,
            proto=proto,
        )
    except Exception:
        logger.exception("collab welcome send failed board=%s", graph_id)
        await registry.leave(room, client)
        return

    try:
        while True:
            raw = await websocket.receive_text()
            await _handle_message(
                websocket=websocket,
                raw=raw,
                graph_store=graph_store,
                oplog=oplog,
                room=room,
                client=client,
                board_id=graph_id,
                user_id=user_id,
            )
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("collab socket error board=%s client=%s", graph_id, client.client_id)
    finally:
        # 3.2: emit a synthetic `peer-presence-leave` to remaining peers
        # so cursors / chip entries don't ghost when a socket dies
        # without an explicit leave frame. The client itself sends one
        # on `pagehide` for clean shutdowns; this covers crashes,
        # network drops, and tab kills. Skipped when this socket never
        # announced its `app_client_id` (it never showed up in the
        # presence registry).
        if client.app_client_id is not None:
            async with room.lock:
                had_presence = client.app_client_id in room.presence
                room.clear_presence_unlocked(client.app_client_id)
            if had_presence:
                leave_frame = json.dumps({
                    "kind": "presence-leave",
                    "clientId": client.app_client_id,
                })
                await room.broadcast(leave_frame, exclude=client)
        await registry.leave(room, client)
        logger.info("collab leave board=%s client=%s", graph_id, client.client_id)


async def _send_welcome(
    *,
    websocket: WebSocket,
    room: Room,
    client_id: str,
    graph_store,
    oplog: CollabOplogStore,
    board_id: str,
    root_id: str | None,
    since_seq: int | None,
    proto: int = 1,
) -> None:
    """Send the welcome frame appropriate to the client's `since_seq`.

    Acquires `room.lock` for the duration so a peer-op broadcast can't
    interleave between the seq read and the welcome send — the joining
    client never observes a seq earlier than its welcome's seq. The head
    seq and catch-up batches come from the DURABLE op-log, not the volatile
    in-memory ring, so a client that reconnects after a server restart is
    caught up correctly instead of being told it's live at seq 0.

    Snapshot mode carries the current `presence` map so a freshly-
    joining peer (or one rebuilding after a long drift) sees existing
    peers immediately, instead of waiting for them to re-broadcast.
    Catch-up + live skip it — those peers still have their local
    presence state untouched.
    """
    async with room.lock:
        seq = await oplog.max_seq(board_id)  # durable head, survives restart
        # First connect → full snapshot.
        if since_seq is None:
            snapshot = await read_snapshot_payload(
                graph_store=graph_store, board_id=board_id, root_id=root_id,
            )
            await websocket.send_json({
                "kind": "welcome",
                "mode": "snapshot",
                "seq": seq,
                "snapshot": snapshot,
                "presence": room.presence_snapshot_unlocked(
                    exclude_client_id=client_id,
                ),
            })
            return

        # Already up-to-date — no payload needed.
        if since_seq >= seq:
            await websocket.send_json({
                "kind": "welcome",
                "mode": "live",
                "seq": seq,
            })
            return

        # Behind the head → catch up from the durable log. v2 clients get each
        # batch tagged with its relay seq (serverSeq-ordered replay); v1 clients
        # get the legacy plain-batch list.
        entries = await oplog.batches_since(board_id, since_seq)
        if entries:
            batches = (
                [{"seq": s, "batch": b} for (s, b) in entries]
                if proto >= 2
                else [b for (_s, b) in entries]
            )
            await websocket.send_json({
                "kind": "welcome",
                "mode": "catch-up",
                "seq": seq,
                "batches": batches,
            })
            return

        # No entries in range (e.g. the log was compacted below `since_seq`) →
        # fall back to a full snapshot. Scope it to `root_id` like the
        # first-connect path, or a folder-scoped client gets the whole board.
        snapshot = await read_snapshot_payload(
            graph_store=graph_store, board_id=board_id, root_id=root_id,
        )
        await websocket.send_json({
            "kind": "welcome",
            "mode": "snapshot",
            "seq": seq,
            "snapshot": snapshot,
            "presence": room.presence_snapshot_unlocked(
                exclude_client_id=client_id,
            ),
        })


async def _handle_message(  # noqa: C901 — flat kind-dispatch reads better than further nesting
    *,
    websocket: WebSocket,
    raw: str,
    graph_store,
    oplog: CollabOplogStore,
    room: Room,
    client: Client,
    board_id: str,
    user_id: str,
) -> None:
    """Dispatch one inbound frame.

    `op` frames go through the sequencer+applier+broadcaster under the
    room lock; everything else still relays verbatim for Phase 1b. The
    presence path will become a structured `peer-presence` in Phase 3.
    """
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        return

    kind = msg.get("kind") if isinstance(msg, dict) else None

    if kind == "op":
        batch = msg.get("batch") or {}
        client_seq = msg.get("client_seq")
        # Read-only clients (viewers) can't mutate. Reject the op
        # outright; nothing applies, nothing broadcasts. The client
        # surfaces this via a toast / read-only banner.
        if client.role not in _EDIT_ROLES:
            try:
                await websocket.send_json({
                    "kind": "op-rejected",
                    "client_seq": client_seq,
                    "reason": "read-only",
                })
            except Exception:
                logger.debug("collab op-rejected send failed", exc_info=True)
            return
        ops = batch.get("ops") or []
        batch_id = batch.get("id")
        async with room.lock:
            # Idempotent replay: a reconnecting client re-sends its outbox. If we
            # already applied this batch, re-ack at its original seq and stop —
            # never apply, append, or broadcast it twice. (The check + append run
            # under the room lock, so same-batch races on one worker serialize.)
            if batch_id:
                seen_seq = await oplog.seq_for_batch(board_id, batch_id)
                if seen_seq is not None:
                    try:
                        await websocket.send_json({
                            "kind": "op-applied",
                            "seq": seen_seq,
                            "client_seq": client_seq,
                        })
                    except Exception:
                        logger.debug("collab op-applied (dedup) send failed", exc_info=True)
                    return
            results = await apply_batch(
                graph_store=graph_store,
                board_id=board_id,
                user_id=user_id,
                ops=ops,
            )
            # Surface lost writes instead of silently acking them. A single-op
            # batch that wholly failed to persist is rejected so the sender rolls
            # it back (rather than the edit reappearing empty on the next reload),
            # and is not oplogged/broadcast. Multi-op batches are never rejected —
            # client batches are coalesced (a debounce window / paste is one batch
            # of independent ops) and op-rejected rolls back the whole client
            # batch, so it would destroy the sibling ops that DID persist — so a
            # failure there is logged loudly for triage and the batch proceeds.
            if should_reject_batch(results):
                logger.warning(
                    "collab op rejected board=%s client_seq=%s reason=%s",
                    board_id, client_seq, results[0].reason,
                )
                try:
                    await websocket.send_json({
                        "kind": "op-rejected",
                        "client_seq": client_seq,
                        "reason": "persist failed",
                    })
                except Exception:
                    logger.debug("collab op-rejected send failed", exc_info=True)
                return
            if batch_had_persist_failure(results):
                logger.error(
                    "collab persist failure not surfaced to client (multi-op batch) board=%s client_seq=%s reasons=%s",
                    board_id, client_seq, [r.reason for r in results if r.persist_failure],
                )
            seq = await oplog.next_seq(board_id)
            room.seq = seq  # keep the in-memory head in sync for snapshot reads
            # Durable log: the source of truth for reconnect catch-up and a
            # restart-safe seq. Idempotent by (board_id, seq). A durable-log
            # hiccup must not fail the op — the factory already has it and peers
            # still need the broadcast — so log and carry on (the missed entry
            # self-heals on the next full snapshot).
            try:
                await oplog.append(board_id, seq, batch)
            except Exception:
                logger.exception("collab oplog append failed board=%s seq=%s", board_id, seq)
            # Also keep the in-memory ring warm (fast-path; not authoritative).
            room.remember_batch_unlocked(seq, batch)
            peer_op = json.dumps({"kind": "peer-op", "seq": seq, "batch": batch})
            # Send under the lock so peer-op ordering across peers
            # matches the seq order. Head-of-line latency to one peer
            # blocks the room briefly; per-peer outbox queues are a
            # Phase 3 optimization.
            for c in list(room.clients.values()):
                if c is client:
                    try:
                        await c.socket.send_json({
                            "kind": "op-applied",
                            "seq": seq,
                            "client_seq": client_seq,
                        })
                    except Exception:
                        logger.debug("collab op-applied send failed", exc_info=True)
                else:
                    try:
                        await c.socket.send_text(peer_op)
                    except Exception:
                        logger.debug("collab peer-op send failed", exc_info=True)
        return

    # Presence frames: validate, update the per-room registry, then relay.
    # Storing presence server-side means a freshly-joining peer can see
    # existing peers immediately via the welcome handshake instead of
    # waiting for those peers to re-broadcast. Rejecting malformed frames
    # before relay also keeps the protocol surface defensive (size cap +
    # required fields).
    if kind == "presence":
        state = msg.get("state") if isinstance(msg, dict) else None
        app_client_id = msg.get("clientId") if isinstance(msg, dict) else None
        if not _is_valid_presence(app_client_id, state, raw):
            logger.debug(
                "collab presence rejected board=%s client=%s",
                board_id, client.client_id,
            )
            return
        async with room.lock:
            room.update_presence_unlocked(str(app_client_id), state)
        # Remember the peer's app-level clientId so the disconnect-side
        # cleanup can clear the matching registry entry + emit a leave
        # frame keyed correctly. Last-wins if a peer rebrands mid-session
        # (no observed cases, but harmless).
        client.app_client_id = str(app_client_id)
        await room.broadcast(raw, exclude=client)
        return

    if kind == "presence-leave":
        client_id = msg.get("clientId") if isinstance(msg, dict) else None
        if isinstance(client_id, str):
            async with room.lock:
                room.clear_presence_unlocked(client_id)
        await room.broadcast(raw, exclude=client)
        return

    # Other non-op kinds (hello, etc.): relay verbatim.
    await room.broadcast(raw, exclude=client)


def _is_valid_presence(client_id, state, raw: str) -> bool:
    """Reject malformed `presence` frames before they touch the registry.

    Enforces a clientId string, a dict state, and a hard size cap so a
    misbehaving client can't fill `Room.presence` with junk.
    """
    if not isinstance(client_id, str) or not client_id:
        return False
    if not isinstance(state, dict):
        return False
    if len(raw.encode("utf-8")) > MAX_PRESENCE_PAYLOAD_BYTES:
        return False
    return True
