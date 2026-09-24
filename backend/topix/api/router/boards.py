"""Graph API Router."""

from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.params import Body, Path

from topix.agents.assistant.code import DEFAULT_LANGUAGE, RUNNABLE_LANGUAGES, execute_code
from topix.agents.datatypes.context import Context
from topix.agents.describe_board import DescribeBoard
from topix.agents.run import AgentRunner
from topix.agents.sessions import AssistantSession
from topix.api.datatypes.requests import (
    AddLinksRequest,
    AddNotesRequest,
    AdoptGraphRequest,
    BoardVisibilityUpdateRequest,
    GraphUpdateRequest,
    LinkUpdateRequest,
    NoteUpdateRequest,
)
from topix.api.utils.billing.stripe_config import is_billing_active
from topix.api.utils.decorators import with_standard_response
from topix.api.utils.security import (
    get_current_user_uid,
    verify_board_member,
    verify_board_read_access,
)
from topix.api.utils.thumbnail import load_png_as_data_url, save_thumbnail
from topix.collab.apply_ops import apply_batch
from topix.datatypes.graph.graph import Graph
from topix.datatypes.note.style import NodeType
from topix.datatypes.user_billing import effective_plan
from topix.store.chat import ChatStore
from topix.store.graph import GraphStore

# Synced-board cap for the free plan (local boards are unlimited). Mirrors the
# frontend BOARD_LIMITS.free — keep the two in sync until a shared catalog exists.
FREE_SYNCED_BOARD_LIMIT = 5

router = APIRouter(
    prefix="/boards",
    tags=["boards"],
    responses={404: {"description": "Not found"}},
)


@router.put("/", include_in_schema=False)
@router.put("")
@with_standard_response
async def create_graph(
    response: Response,
    request: Request,
    user_id: Annotated[str, Depends(get_current_user_uid)]
):
    """Create a new synced board for the user, enforcing the plan's board cap.

    Shares the atomic, race-free cap primitive with adopt so the free-tier limit
    can't be bypassed by creating boards directly instead of promoting local ones.
    """
    store: GraphStore = request.app.graph_store

    cap = await _synced_board_cap(request, user_id)
    new_graph = Graph(user_uid=user_id)
    outcome = await store.create_graph_within_cap(graph=new_graph, user_uid=user_id, cap=cap)
    if outcome == "at_cap":
        raise HTTPException(status_code=402, detail=_CAP_DETAIL)
    # A fresh server-generated UID can't collide, so "created" is the only other
    # outcome.
    return {"graph_id": new_graph.uid}


_CAP_DETAIL = "Synced-board limit reached for your plan. Upgrade, or delete a synced board."


async def _synced_board_cap(request: Request, user_id: str) -> int | None:
    """Resolve the caller's synced-board cap, or None when unlimited.

    None in OSS mode (billing off) and for paid plans; the free plan's fixed cap
    otherwise. The count of owned boards is done atomically at create time (see
    `create_graph_within_cap`) — this only resolves the limit.
    """
    if not is_billing_active():
        return None
    billing = await request.app.user_billing_store.get_user_billing(user_id)
    plan = effective_plan(billing.plan, billing.status) if billing else "free"
    if plan != "free":
        return None
    return FREE_SYNCED_BOARD_LIMIT


@router.post("/{graph_id}:adopt/", include_in_schema=False)
@router.post("/{graph_id}:adopt")
@with_standard_response
async def adopt_graph(
    response: Response,
    request: Request,
    graph_id: Annotated[str, Path(description="Client-provided board UID to adopt")],
    body: AdoptGraphRequest,
    user_id: Annotated[str, Depends(get_current_user_uid)],
):
    """Adopt a local-only board into a synced graph, preserving its UID.

    Promotes a device-only board (local → synced): creates the graph under the
    caller as owner with the board's existing UID, then rebuilds its content via
    the same `apply_batch` path the collab relay uses. The stored graph is the
    snapshot base a joining v2 client hydrates from, so no oplog seeding is
    needed (seq starts at 0).

    Idempotent: re-adopting a board the caller already owns is a no-op that
    returns the same id, so a retried promotion is safe. A UID owned by someone
    else is rejected (409) rather than overwritten.
    """
    store: GraphStore = request.app.graph_store

    existing = await store.get_graph_metadata(graph_uid=graph_id)
    if existing is not None:
        role = await store.get_graph_role(graph_uid=graph_id, user_uid=user_id)
        if role != "owner":
            raise HTTPException(status_code=409, detail="board id already in use")
        return {"graph_id": graph_id, "adopted": False, "applied": 0}

    # Create the graph row FIRST, atomically enforcing the synced-board cap: a
    # per-user advisory lock inside create_graph_within_cap makes the count+insert
    # race-free (no two concurrent adopts can both slip past the cap) and detects a
    # concurrent duplicate UID instead of hitting the unique constraint. Content is
    # rebuilt only AFTER a successful create, so a rejected/duplicate adopt writes
    # nothing to Qdrant that would need cleaning up.
    cap = await _synced_board_cap(request, user_id)
    graph = Graph(uid=graph_id, label=body.label)
    outcome = await store.create_graph_within_cap(graph=graph, user_uid=user_id, cap=cap)
    if outcome == "at_cap":
        raise HTTPException(status_code=402, detail=_CAP_DETAIL)
    if outcome == "exists":
        # A concurrent adopt of this UID won the race and owns the content rebuild;
        # this call is an idempotent no-op. Confirm ownership though — a UID owned
        # by someone else is a conflict, not a silent success.
        role = await store.get_graph_role(graph_uid=graph_id, user_uid=user_id)
        if role != "owner":
            raise HTTPException(status_code=409, detail="board id already in use")
        return {"graph_id": graph_id, "adopted": False, "applied": 0}

    # Rebuild content on the freshly-created graph (idempotent Qdrant upserts).
    results = await apply_batch(
        graph_store=store,
        board_id=graph_id,
        user_id=user_id,
        ops=body.ops,
    )
    applied = sum(1 for r in results if r.applied)
    return {"graph_id": graph_id, "adopted": True, "applied": applied}


@router.patch("/{graph_id}/", include_in_schema=False)
@router.patch("/{graph_id}")
@with_standard_response
async def update_graph(
    response: Response,
    request: Request,
    graph_id: Annotated[str, Path(description="Graph ID")],
    user_id: Annotated[str, Depends(get_current_user_uid)],
    _: Annotated[None, Depends(verify_board_member)],
    body: Annotated[GraphUpdateRequest, Body(description="Graph update data")]
):
    """Update an existing graph by its ID."""
    store: GraphStore = request.app.graph_store
    return await store.update_graph(graph_uid=graph_id, data=body.data)


# Node kinds listed in the board sidebar tree: the custom surface nodes, minus
# the deprecated widget / mini-app. Keep in sync with `BOARD_CONTENT_KINDS` in
# webui `features/board/api/list-board-contents.ts`.
_BOARD_CONTENT_KINDS: frozenset[NodeType] = frozenset({
    NodeType.SHEET, NodeType.FOLDER, NodeType.CODE_SANDBOX, NodeType.APPLET,
})


@router.get("/{graph_id}/contents/", include_in_schema=False)
@router.get("/{graph_id}/contents")
@with_standard_response
async def list_board_contents(
    response: Response,
    request: Request,
    graph_id: Annotated[str, Path(description="Graph ID")],
    user_id: Annotated[str, Depends(get_current_user_uid)],
    _: Annotated[None, Depends(verify_board_read_access)],
    parent_id: Annotated[str | None, Query(description="Folder ID to list children of; omit for top level")] = None,
):
    """List a board's sidebar-tree nodes (`_BOARD_CONTENT_KINDS`) at one level."""
    store: GraphStore = request.app.graph_store
    graph = await store.get_graph(graph_uid=graph_id, root_id=parent_id)
    if not graph:
        return {"items": []}

    items = []
    for node in graph.nodes:
        kind = node.style.type if node.style else None
        if kind not in _BOARD_CONTENT_KINDS:
            continue
        # Serialize the inner icon value only (drop the IconProperty wrapper)
        # so the response matches the frontend's IconProperty["icon"] shape
        # and stays small for big sidebars.
        icon_property = node.properties.icon_data
        icon_payload = (
            icon_property.icon.model_dump()
            if icon_property and icon_property.icon
            else None
        )
        items.append({
            "id": node.id,
            "label": node.label.markdown if node.label else None,
            "kind": kind,
            "parent_id": node.parent_id,
            "icon_data": icon_payload,
        })
    return {"items": items}


@router.post("/{graph_id}:describe/", include_in_schema=False)
@router.post("/{graph_id}:describe")
@with_standard_response
async def describe_board(
    response: Response,
    request: Request,
    graph_id: Annotated[str, Path(description="Graph ID")],
    user_id: Annotated[str, Depends(get_current_user_uid)],
    _: Annotated[None, Depends(verify_board_member)],
    chat_id: Annotated[str, Query(description="Chat ID to summarize for the board label")],
):
    """Auto-label a board from a chat. No-op if the board already has a non-default label."""
    graph_store: GraphStore = request.app.graph_store
    chat_store: ChatStore = request.app.chat_store

    metadata = await graph_store.get_graph_metadata(graph_uid=graph_id)
    current_label = (metadata.label if metadata else "") or ""
    if current_label.strip() and current_label.strip().lower() != "untitled":
        return {"label": current_label}

    chat = await chat_store.get_chat(chat_id)
    if not chat or chat.user_uid != user_id or chat.graph_uid != graph_id:
        raise HTTPException(status_code=403, detail="Chat does not belong to this board.")

    context = Context()
    session = AssistantSession(session_id=chat_id, chat_store=chat_store)
    board_describer = DescribeBoard()
    label = await AgentRunner.run(board_describer, await session.get_items(), context=context)

    if label:
        await graph_store.update_graph(graph_uid=graph_id, data={"label": label})
    return {"label": label}


@router.delete("/{graph_id}/", include_in_schema=False)
@router.delete("/{graph_id}")
@with_standard_response
async def delete_graph(
    response: Response,
    request: Request,
    graph_id: Annotated[str, Path(description="Graph ID")],
    user_id: Annotated[str, Depends(get_current_user_uid)],
    _: Annotated[None, Depends(verify_board_member)],
):
    """Delete a graph by its ID."""
    store: GraphStore = request.app.graph_store

    await store.delete_graph(graph_uid=graph_id, hard_delete=True)
    return {"message": "Board deleted successfully"}


@router.get("/{graph_id}/", include_in_schema=False)
@router.get("/{graph_id}")
@with_standard_response
async def get_graph(
    response: Response,
    request: Request,
    graph_id: Annotated[str, Path(description="Graph ID")],
    user_id: Annotated[str, Depends(get_current_user_uid)],
    _: Annotated[None, Depends(verify_board_read_access)],
    root_id: Annotated[str | None, Query(description="Root node ID for subgraph (direct children only)")] = None,
    whole: Annotated[bool, Query(description="Return the whole board (all layers), ignoring root_id — for offline materialization")] = False,
):
    """Get a graph by its ID."""
    store: GraphStore = request.app.graph_store

    try:
        graph = await store.get_graph(
            graph_uid=graph_id,
            root_id=None if whole else root_id,
            all_layers=whole,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    if not graph:
        raise HTTPException(status_code=404, detail="Graph not found")

    if graph.thumbnail and graph.thumbnail.startswith("file://"):
        graph.thumbnail = load_png_as_data_url(graph.thumbnail)

    role = await store.get_graph_role(graph_uid=graph_id, user_uid=user_id)
    can_edit = role in {"owner", "member"}

    return {
        "graph": graph.model_dump(exclude_none=True),
        "can_edit": can_edit,
        # `role` is one of "owner" | "member" | "viewer" | None
        # (None for public-visibility boards a non-member is viewing).
        # The frontend uses this to gate the Share button (owner-only).
        "role": role,
    }


@router.get("/", include_in_schema=False)
@router.get("")
@with_standard_response
async def list_graphs(
    response: Response,
    request: Request,
    user_id: Annotated[str, Depends(get_current_user_uid)]
):
    """List all graphs for the user, each annotated with role + owner email."""
    store: GraphStore = request.app.graph_store

    rows = await store.list_graphs(user_uid=user_id)

    items = []
    for graph, role, owner_email in rows:
        # Convert file:// URLs to data URLs (kept here so the model
        # dump below sees the resolved value).
        if graph.thumbnail and graph.thumbnail.startswith("file://"):
            graph.thumbnail = load_png_as_data_url(graph.thumbnail)
        item = graph.model_dump(exclude_none=True)
        item["role"] = role
        # Only attach owner_email for non-owners — saves payload size
        # and matches what the sidebar actually shows ("shared by …").
        if role != "owner":
            item["owner_email"] = owner_email
        items.append(item)

    return {"graphs": items}


@router.post("/{graph_id}/notes/", include_in_schema=False)
@router.post("/{graph_id}/notes")
@with_standard_response
async def add_notes_to_graph(
    response: Response,
    request: Request,
    graph_id: Annotated[str, Path(description="Graph ID")],
    user_id: Annotated[str, Depends(get_current_user_uid)],
    _: Annotated[None, Depends(verify_board_member)],
    body: Annotated[AddNotesRequest, Body(description="Notes to add")]
):
    """Add notes to a graph."""
    store: GraphStore = request.app.graph_store

    notes = body.notes

    for note in notes:
        note.graph_uid = graph_id

    if not notes:
        return {"message": "Received empty note array."}

    await store.add_notes(nodes=notes)
    return {"message": "Notes added to board successfully"}


@router.get("/{graph_id}/notes/{note_id}", include_in_schema=False)
@router.get("/{graph_id}/notes/{note_id}")
@with_standard_response
async def get_note(
    response: Response,
    request: Request,
    graph_id: Annotated[str, Path(description="Graph ID")],
    note_id: Annotated[str, Path(description="Note ID")],
    user_id: Annotated[str, Depends(get_current_user_uid)],
    _: Annotated[None, Depends(verify_board_read_access)],
):
    """Get a note from a graph."""
    store: GraphStore = request.app.graph_store

    notes = await store.get_nodes(node_ids=[note_id])
    if not notes:
        raise HTTPException(status_code=404, detail="Note not found")

    return {"note": notes[0].model_dump(exclude_none=True)}


@router.post("/{graph_id}/notes/{note_id}:execute", include_in_schema=False)
@router.post("/{graph_id}/notes/{note_id}:execute")
@with_standard_response
async def execute_note_code(
    response: Response,
    request: Request,
    graph_id: Annotated[str, Path(description="Graph ID")],
    note_id: Annotated[str, Path(description="Note ID")],
    user_id: Annotated[str, Depends(get_current_user_uid)],
    _: Annotated[None, Depends(verify_board_member)],
):
    """Execute code stored in a code sandbox note, in its declared language."""
    store: GraphStore = request.app.graph_store

    notes = await store.get_nodes(node_ids=[note_id])
    if not notes:
        raise HTTPException(status_code=404, detail="Note not found")

    note = notes[0]
    if note.graph_uid != graph_id:
        raise HTTPException(status_code=404, detail="Note not found")
    if note.style.type != NodeType.CODE_SANDBOX:
        raise HTTPException(status_code=400, detail="Note is not a code sandbox")

    language = note.properties.programming_language.text or DEFAULT_LANGUAGE
    if language not in RUNNABLE_LANGUAGES:
        raise HTTPException(
            status_code=400,
            detail=f"Language '{language}' is not runnable",
        )

    code = note.content.markdown if note.content else ""
    result = await execute_code(code, language)
    return result.model_dump(exclude_none=True)


@router.get("/{graph_id}/notes/{note_id}/path", include_in_schema=False)
@router.get("/{graph_id}/notes/{note_id}/path")
@with_standard_response
async def get_note_path(
    response: Response,
    request: Request,
    graph_id: Annotated[str, Path(description="Graph ID")],
    note_id: Annotated[str, Path(description="Note ID")],
    user_id: Annotated[str, Depends(get_current_user_uid)],
    _: Annotated[None, Depends(verify_board_read_access)],
):
    """Get full path from root to a note."""
    store: GraphStore = request.app.graph_store

    path = await store.get_node_path(graph_uid=graph_id, node_id=note_id)
    if not path:
        raise HTTPException(status_code=404, detail="Note path not found")

    return {"path": [node.model_dump(exclude_none=True) for node in path]}


@router.patch("/{graph_id}/notes/{note_id}/", include_in_schema=False)
@router.patch("/{graph_id}/notes/{note_id}")
@with_standard_response
async def update_note(
    response: Response,
    request: Request,
    graph_id: Annotated[str, Path(description="Graph ID")],
    note_id: Annotated[str, Path(description="Note ID")],
    user_id: Annotated[str, Depends(get_current_user_uid)],
    _: Annotated[None, Depends(verify_board_member)],
    body: Annotated[NoteUpdateRequest, Body(description="Note update data")]
):
    """Update a note or document node in a graph."""
    store: GraphStore = request.app.graph_store

    updated_note = await store.patch_note(node_id=note_id, data=body.data, user_uid=user_id)
    if updated_note is None:
        raise HTTPException(status_code=404, detail="Note not found")
    return {"message": "Note updated successfully"}


@router.delete("/{graph_id}/notes/{note_id}/", include_in_schema=False)
@router.delete("/{graph_id}/notes/{note_id}")
@with_standard_response
async def remove_note_from_graph(
    response: Response,
    request: Request,
    graph_id: Annotated[str, Path(description="Graph ID")],
    note_id: Annotated[str, Path(description="Note ID")],
    user_id: Annotated[str, Depends(get_current_user_uid)],
    _: Annotated[None, Depends(verify_board_member)],
):
    """Remove notes from a graph."""
    store: GraphStore = request.app.graph_store

    await store.delete_node(node_id=note_id, user_uid=user_id)
    return {"message": "Note removed from board successfully"}


@router.post("/{graph_id}/notes/{note_id}:restore-latest", include_in_schema=False)
@router.post("/{graph_id}/notes/{note_id}:restore-latest")
@with_standard_response
async def restore_latest_note_revision(
    response: Response,
    request: Request,
    graph_id: Annotated[str, Path(description="Graph ID")],
    note_id: Annotated[str, Path(description="Note ID")],
    user_id: Annotated[str, Depends(get_current_user_uid)],
    _: Annotated[None, Depends(verify_board_member)],
):
    """Restore the latest saved note revision for a board note."""
    store: GraphStore = request.app.graph_store

    restored_note = await store.restore_latest_note_revision(node_id=note_id, user_uid=user_id)
    if restored_note is None or restored_note.graph_uid != graph_id:
        raise HTTPException(status_code=404, detail="Note revision not found")

    return {"note": restored_note.model_dump(exclude_none=True)}


@router.post("/{graph_id}/links/", include_in_schema=False)
@router.post("/{graph_id}/links")
@with_standard_response
async def add_links_to_graph(
    response: Response,
    request: Request,
    graph_id: Annotated[str, Path(description="Graph ID")],
    user_id: Annotated[str, Depends(get_current_user_uid)],
    _: Annotated[None, Depends(verify_board_member)],
    body: Annotated[AddLinksRequest, Body(description="Links to add")]
):
    """Add links to a graph."""
    store: GraphStore = request.app.graph_store

    links = body.links
    for link in links:
        link.graph_uid = graph_id

    if not links:
        return {"message": "Received empty link array."}

    await store.add_links(links=links)
    return {"message": "Links added to board successfully."}


@router.get("/{graph_id}/links/{link_id}", include_in_schema=False)
@router.get("/{graph_id}/links/{link_id}")
@with_standard_response
async def get_link(
    response: Response,
    request: Request,
    graph_id: Annotated[str, Path(description="Graph ID")],
    link_id: Annotated[str, Path(description="Link ID")],
    user_id: Annotated[str, Depends(get_current_user_uid)],
    _: Annotated[None, Depends(verify_board_read_access)],
):
    """Get a link from a graph."""
    store: GraphStore = request.app.graph_store

    links = await store.get_links(link_ids=[link_id])
    if not links:
        raise HTTPException(status_code=404, detail="Link not found")

    return {"link": links[0].model_dump(exclude_none=True)}


@router.patch("/{graph_id}/links/{link_id}/", include_in_schema=False)
@router.patch("/{graph_id}/links/{link_id}")
@with_standard_response
async def update_link(
    response: Response,
    request: Request,
    graph_id: Annotated[str, Path(description="Graph ID")],
    link_id: Annotated[str, Path(description="Link ID")],
    user_id: Annotated[str, Depends(get_current_user_uid)],
    _: Annotated[None, Depends(verify_board_member)],
    body: Annotated[LinkUpdateRequest, Body(description="Link update data")]
):
    """Update a link in a graph."""
    store: GraphStore = request.app.graph_store

    await store.update_link(link_id=link_id, data=body.data)
    return {"message": "Link updated successfully"}


@router.delete("/{graph_id}/links/{link_id}/", include_in_schema=False)
@router.delete("/{graph_id}/links/{link_id}")
@with_standard_response
async def remove_link_from_graph(
    response: Response,
    request: Request,
    graph_id: Annotated[str, Path(description="Graph ID")],
    link_id: Annotated[str, Path(description="Link ID")],
    user_id: Annotated[str, Depends(get_current_user_uid)],
    _: Annotated[None, Depends(verify_board_member)],
):
    """Remove links from a graph."""
    store: GraphStore = request.app.graph_store

    await store.delete_link(link_id=link_id)
    return {"message": "Link removed from board successfully"}


@router.post("/{graph_id}/thumbnail/", include_in_schema=False)
@router.post("/{graph_id}/thumbnail")
@with_standard_response
async def save_graph_thumbnail(
    request: Request,
    graph_id: Annotated[str, Path(description="Graph ID")],
    user_id: Annotated[str, Depends(get_current_user_uid)],
    _: Annotated[None, Depends(verify_board_member)],
    file: UploadFile = File(...),
):
    """Save a thumbnail image for the graph."""
    file_bytes = await file.read()
    path = save_thumbnail(graph_id, file_bytes)
    store: GraphStore = request.app.graph_store

    await store.update_graph(graph_id, {"thumbnail": path})
    return {"path": path}


@router.patch("/{graph_id}/visibility/", include_in_schema=False)
@router.patch("/{graph_id}/visibility")
@with_standard_response
async def update_graph_visibility(
    response: Response,
    request: Request,
    graph_id: Annotated[str, Path(description="Graph ID")],
    user_id: Annotated[str, Depends(get_current_user_uid)],
    _: Annotated[None, Depends(verify_board_member)],
    body: Annotated[BoardVisibilityUpdateRequest, Body(description="Board visibility update data")],
):
    """Update board visibility."""
    store: GraphStore = request.app.graph_store
    await store.update_graph(graph_uid=graph_id, data={"visibility": body.visibility})
    return {"message": "Board visibility updated successfully"}
