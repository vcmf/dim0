"""Server-side op applier.

Translates canvas-harness wire ops into existing `GraphStore`
mutations.

Supported (persisted to the graph):
  - node.add / node.update — scene primitives (x, y, w, h, z, angle,
    content), full `style` (every camelCase field → snake_case, except the
    theme-adapted display colors, which come via `data._storedColors`), and
    `data.properties` (imageUrl, iconData, emoji, pinned, listOrder, slide*,
    …) + scope (`parentId` / `graphUid`) + `label`. See
    `_node_patch_to_note_data` / `_wire_node_to_note`. Covers drag, resize,
    z-order, rotate, text-edit, restyle, image/icon — the bulk of traffic.
  - node.remove — id-only delete.
  - edge.add / edge.update / edge.remove — the Link analogues (incl. the
    curve `_midpoint` → `edge_control_point`).

Deferred (still log + return `unsupported`; relayed to peers but not persisted):
  - `group.upsert` / `group.remove` — Dim0 doesn't surface groups yet.
  - `frame.reorder` — a bulk multi-id z-shuffle op (per-node `z` IS persisted
    via node.update, so the effect is reachable without it).
"""

import logging
import math

from typing import Any, Literal

from pydantic import BaseModel

from topix.collab.note_to_wire import _CANVAS_TO_DIM0_TYPE, _camel_to_snake
from topix.datatypes.note.link import Link
from topix.datatypes.note.note import Note
from topix.store.graph import GraphStore

logger = logging.getLogger(__name__)


RAD_TO_DEG = 180.0 / math.pi


class WireOpResult(BaseModel):
    """Outcome of applying one op.

    `applied=True` means the DB write happened; `applied=False` means
    the op was unsupported but the relay should still broadcast it to
    peers (best-effort).
    """

    applied: bool
    op_type: str
    reason: str | None = None


async def apply_batch(  # noqa: C901 — flat dispatch by op-kind reads better than further nesting
    *,
    graph_store: GraphStore,
    board_id: str,
    user_id: str,
    ops: list[dict[str, Any]],
) -> list[WireOpResult]:
    """Apply a batch of wire ops, grouping by kind so each kind hits the GraphStore in a single bulk call.

    For homogeneous batches (e.g. a paste of 1000 nodes, or a select-all
    delete), the work collapses to ONE `add_notes`/`patch_notes`/
    `delete_nodes` call rather than N per-op store calls — which itself
    used to fan out to N OpenAI embed calls + N Qdrant upserts (each
    `add_notes([1])` etc.). The single-call versions in `GraphStore`
    batch the embedding and Qdrant work under the hood.

    Cross-kind execution order is deterministic: adds → updates →
    removes, nodes before edges. Adds-before-updates means an
    in-batch update on a just-added node still sees it; updates-
    before-removes means a removed node's history is preserved.

    Per-op results stay 1:1 with input ops so tests can still assert
    `results[i].applied` on a specific op. A failure during a bulk
    dispatch fails every op in that bucket (logged once); per-op
    validation failures (e.g. missing id, malformed wire shape) are
    captured before bucketing so they don't poison the rest of the
    bucket.
    """
    # Per-op slots in input order. None means "still needs dispatching";
    # a real WireOpResult means "already decided" (e.g. early validation
    # failure or unsupported op type).
    results: list[WireOpResult | None] = [None] * len(ops)
    node_adds: list[tuple[int, Note]] = []
    node_updates: list[tuple[int, str, dict[str, Any]]] = []
    node_removes: list[tuple[int, str]] = []
    edge_adds: list[tuple[int, Link]] = []
    edge_updates: list[tuple[int, str, dict[str, Any]]] = []
    edge_removes: list[tuple[int, str]] = []

    # Pass 1 — validate + bucket each op. Records early-failure results
    # for ops that can't make it into a bucket.
    for idx, op in enumerate(ops):
        op_type = op.get("type", "")

        if op_type == "node.add":
            note = _wire_node_to_note(op.get("node") or {}, board_id=board_id)
            if note is None:
                results[idx] = WireOpResult(applied=False, op_type=op_type, reason="could not construct Note")
            else:
                node_adds.append((idx, note))
            continue

        if op_type == "node.update":
            node_id = op.get("id")
            if not isinstance(node_id, str):
                results[idx] = WireOpResult(applied=False, op_type=op_type, reason="missing id")
                continue
            data = _node_patch_to_note_data(op.get("patch") or {})
            if not data:
                results[idx] = WireOpResult(applied=False, op_type=op_type, reason="no supported fields in patch")
                continue
            node_updates.append((idx, node_id, data))
            continue

        if op_type == "node.remove":
            node = op.get("node") or {}
            node_id = node.get("id") or op.get("id")
            if not isinstance(node_id, str):
                results[idx] = WireOpResult(applied=False, op_type=op_type, reason="missing id")
            else:
                node_removes.append((idx, node_id))
            continue

        if op_type == "edge.add":
            link = _wire_edge_to_link(op.get("edge") or {}, board_id=board_id)
            if link is None:
                results[idx] = WireOpResult(applied=False, op_type=op_type, reason="could not construct Link")
            else:
                edge_adds.append((idx, link))
            continue

        if op_type == "edge.update":
            link_id = op.get("id")
            if not isinstance(link_id, str):
                results[idx] = WireOpResult(applied=False, op_type=op_type, reason="missing id")
                continue
            data = _edge_patch_to_link_data(op.get("patch") or {})
            if not data:
                results[idx] = WireOpResult(applied=False, op_type=op_type, reason="no supported fields in patch")
                continue
            edge_updates.append((idx, link_id, data))
            continue

        if op_type == "edge.remove":
            edge = op.get("edge") or {}
            link_id = edge.get("id") or op.get("id")
            if not isinstance(link_id, str):
                results[idx] = WireOpResult(applied=False, op_type=op_type, reason="missing id")
            else:
                edge_removes.append((idx, link_id))
            continue

        # Deferred kinds (group.*, frame.reorder) — relayed by the WS
        # handler regardless, but not persisted.
        logger.info("collab unsupported op type=%s — relayed but not persisted", op_type)
        results[idx] = WireOpResult(applied=False, op_type=op_type, reason="unsupported op type")

    # Pass 2 — dispatch each non-empty bucket in dependency order.
    await _dispatch_bucket(
        results, "node.add", node_adds,
        lambda items: graph_store.add_notes(nodes=[n for _, n in items]),
    )
    await _dispatch_bucket(
        results, "node.update", node_updates,
        lambda items: graph_store.patch_notes(
            updates=[(node_id, data) for _, node_id, data in items],
            user_uid=user_id,
        ),
    )
    await _dispatch_bucket(
        results, "edge.add", edge_adds,
        lambda items: graph_store.add_links(links=[link for _, link in items]),
    )
    await _dispatch_bucket(
        results, "edge.update", edge_updates,
        lambda items: graph_store.update_links(
            updates=[(link_id, data) for _, link_id, data in items],
        ),
    )
    await _dispatch_bucket(
        results, "edge.remove", edge_removes,
        lambda items: graph_store.delete_links(link_ids=[link_id for _, link_id in items]),
    )
    await _dispatch_bucket(
        results, "node.remove", node_removes,
        lambda items: graph_store.delete_nodes(
            node_ids=[node_id for _, node_id in items],
            user_uid=user_id,
        ),
    )

    return [r or WireOpResult(applied=True, op_type="") for r in results]


async def _dispatch_bucket(
    results: list[WireOpResult | None],
    op_type: str,
    items: list[tuple[int, Any, ...]],  # type: ignore[misc]
    dispatch,
) -> None:
    """Run a bulk dispatcher and write success/failure into the result slots.

    On exception, every op in this bucket fails with the same reason
    (the bulk call is atomic from our perspective — we can't tell which
    op caused the failure without falling back to per-op apply, which
    would defeat the bulk optimization).
    """
    if not items:
        return
    try:
        await dispatch(items)
    except Exception as exc:
        logger.exception("collab apply error bucket=%s n=%d err=%s", op_type, len(items), exc)
        reason = str(exc)
        for idx, *_ in items:
            results[idx] = WireOpResult(applied=False, op_type=op_type, reason=reason)
        return
    for idx, *_ in items:
        results[idx] = WireOpResult(applied=True, op_type=op_type)




# ---------------------------------------------------------------------------
# Wire → DB translation helpers
# ---------------------------------------------------------------------------


def _node_patch_to_note_data(patch: dict[str, Any]) -> dict[str, Any]:  # noqa: C901 — wide field-by-field translator
    """Convert a canvas-harness `Partial<Node>` patch into a Note patch dict.

    Handles:
      - Scene primitives: `x, y, w, h, z, angle, content`.
      - Style: every camelCase field in `patch.style` translated to
        snake_case Dim0, EXCEPT the display color fields
        (`strokeColor / backgroundColor / textColor`) — those carry a
        theme-adapted display value we deliberately ignore. The
        canonical light-theme colors come in via `patch.data._storedColors`.
        Without this style translation, picking `roundness: 0` (or
        any other non-color style) on the panel sends an op the
        server treats as "no supported fields" → DB never updates →
        refresh shows the old value.
    """
    properties: dict[str, Any] = {}
    # Only emit the dimension fields actually in the patch. Defaulting
    # the missing one to 0 corrupts the DB on partial updates — e.g.
    # `commitEdit` ships `{ content, h }` after autofit, and
    # `patch_notes`'s deep-merge would replace `width=<correct>` with
    # `width=0` because the patched `node_size.size` carried both
    # fields with `w` defaulted.
    if "x" in patch or "y" in patch:
        position: dict[str, float] = {}
        if "x" in patch:
            position["x"] = float(patch["x"])
        if "y" in patch:
            position["y"] = float(patch["y"])
        properties["node_position"] = {
            "type": "position",
            "position": position,
        }
    if "w" in patch or "h" in patch:
        size: dict[str, float] = {}
        if "w" in patch:
            size["width"] = float(patch["w"])
        if "h" in patch:
            size["height"] = float(patch["h"])
        properties["node_size"] = {
            "type": "size",
            "size": size,
        }
    if "z" in patch:
        properties["node_z_index"] = {
            "type": "number",
            "number": float(patch["z"]),
        }

    # Lift extra NoteProperty sub-fields stashed in `data.properties`
    # by the client convert layer. `note-to-node.ts` strips
    # nodePosition/nodeSize/nodeZIndex from `note.properties` and dumps
    # the rest onto `data.properties` so the wire shape stays flat at
    # the top level. Without this lift, `imageUrl` / `iconData` /
    # `emoji` / `pinned` / `listOrder` / `slide*` / etc. are silently
    # dropped on every wire op and refresh reveals the pydantic-default
    # empty values (blank image, missing icon, etc.).
    wire_data_for_props = patch.get("data")
    if isinstance(wire_data_for_props, dict):
        wire_properties = wire_data_for_props.get("properties")
        if isinstance(wire_properties, dict):
            for camel_key, value in wire_properties.items():
                snake_key = _camel_to_snake(camel_key)
                # Top-level x/y/w/h/z are authoritative for position /
                # size / zindex. Skip any echo of them in
                # `data.properties` so a malformed peer can't clobber
                # the explicit lift.
                if snake_key in {"node_position", "node_size", "node_z_index"}:
                    continue
                properties[snake_key] = value
        # Ink geometry rides at top-level `data.ink` (InkStrokeData), where the
        # engine writes it on a freshly-drawn stroke — never under
        # `data.properties`. Lift it onto `ink_data` so the Note persists it;
        # its camelCase inner keys validate against InkProperty's aliases.
        # Gated on the ink type (node.add carries `type`; a restyle carries
        # `data.styleType`) so a stray `data.ink` never attaches geometry to a
        # non-ink note — symmetric with the client convert layer's gate.
        wire_ink = wire_data_for_props.get("ink")
        is_ink = patch.get("type") == "ink" or wire_data_for_props.get("styleType") == "ink"
        if isinstance(wire_ink, dict) and is_ink:
            properties["ink_data"] = wire_ink

    data: dict[str, Any] = {}
    if properties:
        data["properties"] = properties
    if "angle" in patch:
        data.setdefault("style", {})["angle"] = float(patch["angle"]) * RAD_TO_DEG
    if "content" in patch:
        data["content"] = {"markdown": str(patch["content"] or "")}

    wire_style = patch.get("style")
    if isinstance(wire_style, dict):
        style = data.setdefault("style", {})
        for camel, value in wire_style.items():
            # Skip display color fields — `_storedColors` carries the
            # canonical light-theme value. Skip `angle` too since the
            # explicit branch above already handles its degree conversion.
            if camel in _DISPLAY_COLOR_KEYS or camel == "angle":
                continue
            style[_camel_to_snake(camel)] = value

    style_color = _extract_canonical_colors(patch.get("data"))
    if style_color:
        style = data.setdefault("style", {})
        for k, v in style_color.items():
            style[k] = v

    # `parentId` / `graphUid` on `patch.data` reflect a scope move
    # (e.g. paste rewrites them via `use-stamp-new-nodes` when the
    # source folder/board differs from the user's current scope).
    # Surface them at the top of the patch dict so `patch_notes`'s
    # deep-merge overwrites the Note's `parent_id` / `graph_uid` —
    # otherwise the move would only live in the client store and
    # the note would snap back to its original location on refresh.
    wire_data = patch.get("data")
    if isinstance(wire_data, dict):
        if "parentId" in wire_data:
            data["parent_id"] = wire_data["parentId"]
        if "graphUid" in wire_data:
            data["graph_uid"] = wire_data["graphUid"]
        # `data.label = {markdown: "..."}` carries title renames done via
        # the local-store path (sheet-panel `persistTitle` and the canvas
        # `NodeTitleCaption` both write `data.label`). Without this lift
        # the wire op reaches the server but `patch_notes`'s deep-merge
        # never sees the field — DB title stays at the old value and
        # refresh reverts the rename. Explicit `None` clears the title
        # so a "clear name" op works symmetrically.
        if "label" in wire_data:
            label_value = wire_data["label"]
            if isinstance(label_value, dict):
                markdown = label_value.get("markdown")
                if isinstance(markdown, str):
                    data["label"] = {"markdown": markdown}
            elif label_value is None:
                data["label"] = None

    return data


# Display-color keys arrive theme-adapted on the wire; the canonical
# light-theme value comes via `data._storedColors`. Listed here so the
# style translator can skip them without dropping other style fields.
_DISPLAY_COLOR_KEYS = frozenset({"strokeColor", "backgroundColor", "textColor"})


def _extract_canonical_colors(node_data: Any) -> dict[str, str]:
    """Pull canonical (light-theme) colors out of a wire Node's data.

    Source of truth lives at `data._storedColors` — see
    [webui color-adapter.ts] for the contract. Returns a Dim0-shaped
    (snake_case) subset suitable for merging into `style`. Missing
    fields are simply omitted so the deep-merge on the server side
    leaves untouched colors alone.
    """
    if not isinstance(node_data, dict):
        return {}
    stored = node_data.get("_storedColors")
    if not isinstance(stored, dict):
        return {}
    out: dict[str, str] = {}
    if isinstance(stored.get("backgroundColor"), str):
        out["background_color"] = stored["backgroundColor"]
    if isinstance(stored.get("strokeColor"), str):
        out["stroke_color"] = stored["strokeColor"]
    if isinstance(stored.get("textColor"), str):
        out["text_color"] = stored["textColor"]
    return out


def _wire_node_to_note(node: dict[str, Any], *, board_id: str) -> Note | None:  # noqa: C901 — wide field-by-field translator
    """Construct a server-side `Note` from a wire `Node` payload.

    Lossy on first pass: style / data are mostly defaulted by the Note
    model. Position + size + content + the discriminator carry through.
    """
    node_id = node.get("id")
    if not isinstance(node_id, str):
        return None

    data_field = node.get("data") or {}
    properties = _node_patch_to_note_data(node).get("properties", {})

    note_dict: dict[str, Any] = {
        "id": node_id,
        "graph_uid": board_id,
        "type": data_field.get("noteType", "note"),
        "version": data_field.get("version", 1),
        "parent_id": data_field.get("parentId"),
        "properties": properties,
    }
    if "content" in node:
        note_dict["content"] = {"markdown": str(node["content"] or "")}

    # `data.label` carries the title for newly-created notes. Same lift
    # as `_node_patch_to_note_data` (which handles renames); without it
    # an add op never persists the title and refresh shows "Untitled".
    label_value = data_field.get("label")
    if isinstance(label_value, dict):
        markdown = label_value.get("markdown")
        if isinstance(markdown, str):
            note_dict["label"] = {"markdown": markdown}

    # Prefer `data.styleType` (the Dim0 enum value the client embeds for
    # round-trip fidelity). Fall back to translating the wire `type`
    # (canvas-harness vocabulary) back to Dim0 via the inverse map — keeps
    # `LinkStyle.type` schema-valid if a future op omits styleType.
    style_type = data_field.get("styleType") or _CANVAS_TO_DIM0_TYPE.get(
        str(node.get("type", "")),
    )
    if style_type:
        note_dict["style"] = {"type": style_type}
    angle = node.get("angle")
    if angle is not None:
        note_dict.setdefault("style", {})["angle"] = float(angle) * RAD_TO_DEG

    # Translate the wire `style` block (camelCase) to snake_case Dim0
    # style fields. Without this, a paste of a node with `roundness: 0`
    # would lose the explicit value — `_wire_node_to_note` used to read
    # only `styleType`, `angle`, and canonical colors, so `Note.model_validate`
    # filled `roundness` from the pydantic default (3). Mirrors the
    # `_node_patch_to_note_data` logic for `node.update`.
    wire_style = node.get("style")
    if isinstance(wire_style, dict):
        style = note_dict.setdefault("style", {})
        for camel, value in wire_style.items():
            if camel in _DISPLAY_COLOR_KEYS or camel == "angle":
                continue
            style[_camel_to_snake(camel)] = value

    # Canonical colors from data._storedColors (set by the picker). The
    # wire's `style.*` carries the sender's display-adapted value which
    # we deliberately ignore — see use-ws-collab.ts for the inbound
    # theme normalization on the client side.
    canonical_colors = _extract_canonical_colors(data_field)
    if canonical_colors:
        style = note_dict.setdefault("style", {})
        for k, v in canonical_colors.items():
            style[k] = v

    try:
        return Note.model_validate(note_dict)
    except Exception:
        logger.exception("collab failed to build Note id=%s", node_id)
        return None


def _wire_end_to_endpoint(
    wire_end: dict[str, Any] | None,
) -> tuple[str | None, dict[str, Any] | None]:
    """Translate one wire EdgeEnd to a Dim0 `(source_id, position_property)` pair.

    canvas-harness's `EdgeEnd` is a discriminated union:
      - Attached:    `{ nodeId, localOffset: {x, y} }` → `(nodeId, {position, is_local_offset=True})`
      - Free:        `{ worldPoint: {x, y} }`           → `("", {position, is_local_offset=False})`

    Dim0 flattens this to `Link.source: str` (empty-string sentinel for
    free) plus `Link.properties.start_point: PositionProperty | None`.
    Without this translation, the inbound WS path keeps only `nodeId`
    and drops `localOffset` on the floor — every interactively-drawn
    edge then renders at the node's center after the next reload.

    Returns `(None, None)` when the wire shape is unrecognized so the
    caller can decide whether to skip the field or reject the op.
    """
    if not isinstance(wire_end, dict):
        return None, None

    if "nodeId" in wire_end:
        node_id = wire_end["nodeId"]
        if not isinstance(node_id, str):
            return None, None
        offset = wire_end.get("localOffset")
        if isinstance(offset, dict) and "x" in offset and "y" in offset:
            return node_id, {
                "type": "position",
                "position": {"x": float(offset["x"]), "y": float(offset["y"])},
                "is_local_offset": True,
            }
        # Attached endpoint without localOffset — keep the link
        # buildable but defer to the client's fallback (node center).
        return node_id, None

    if "worldPoint" in wire_end:
        world = wire_end["worldPoint"]
        if isinstance(world, dict) and "x" in world and "y" in world:
            return "", {
                "type": "position",
                "position": {"x": float(world["x"]), "y": float(world["y"])},
                "is_local_offset": False,
            }

    return None, None


def _wire_edge_to_link(edge: dict[str, Any], *, board_id: str) -> Link | None:  # noqa: C901 — wide field-by-field translator
    """Construct a `Link` from a wire `Edge` payload (best-effort).

    canvas-harness Edges carry endpoints as a discriminated union of
    attached (`{nodeId, localOffset}`) and free (`{worldPoint}`). We
    flatten both to Dim0's schema: `Link.source/target` (with the
    empty-string sentinel for free) plus
    `Link.properties.start_point/end_point` (the position with the
    right `is_local_offset` flag).
    """
    link_id = edge.get("id")
    if not isinstance(link_id, str):
        return None

    source_id, start_point = _wire_end_to_endpoint(edge.get("source"))
    target_id, end_point = _wire_end_to_endpoint(edge.get("target"))
    # Fall back to the legacy flat-id wire shape (`sourceId`/`targetId`)
    # before rejecting — keeps any stragglers building.
    if source_id is None:
        source_id = edge.get("sourceId") if isinstance(edge.get("sourceId"), str) else None
    if target_id is None:
        target_id = edge.get("targetId") if isinstance(edge.get("targetId"), str) else None
    if source_id is None or target_id is None:
        return None

    link_dict: dict[str, Any] = {
        "id": link_id,
        "graph_uid": board_id,
        "source": source_id,
        "target": target_id,
    }
    # Lift Dim0 scope from wire `data`. `parentId` is set by the
    # mindmap drain and by `useStampNewEdges` follow-up updates; without
    # it edges drawn inside a sub-folder would persist with parent_id
    # NULL and appear at the root on refresh.
    data_field = edge.get("data") or {}
    if isinstance(data_field, dict) and "parentId" in data_field:
        link_dict["parent_id"] = data_field["parentId"]
    properties: dict[str, Any] = {}
    if start_point is not None:
        properties["start_point"] = start_point
    if end_point is not None:
        properties["end_point"] = end_point
    midpoint = _extract_midpoint(edge)
    if midpoint is not None:
        properties["edge_control_point"] = midpoint
    if properties:
        link_dict["properties"] = properties

    style = _edge_wire_to_link_style(edge)
    if style:
        link_dict["style"] = style
    label_markdown = edge.get("content")
    if isinstance(label_markdown, str) and label_markdown:
        link_dict["label"] = {"markdown": label_markdown}

    try:
        return Link.model_validate(link_dict)
    except Exception:
        logger.exception("collab failed to build Link id=%s", link_id)
        return None


def _edge_patch_to_link_data(patch: dict[str, Any]) -> dict[str, Any]:  # noqa: C901 — wide field-by-field translator
    """Translate `Partial<Edge>` to an `update_link` data dict.

    Handles endpoint changes (both branches of the EdgeEnd union — see
    `_wire_end_to_endpoint`), the curve control midpoint (`_midpoint`,
    computed client-side from the cubic-bezier control points before
    the op is sent — keeps the server stateless, no node-position
    lookup needed), `pathStyle`, edge label (`content` → `label.markdown`),
    and the camelCase EdgeStyle subset.
    """
    data: dict[str, Any] = {}
    properties: dict[str, Any] = {}

    if "source" in patch:
        source_id, start_point = _wire_end_to_endpoint(patch.get("source"))
        if source_id is not None:
            data["source"] = source_id
        if start_point is not None:
            properties["start_point"] = start_point
    if "target" in patch:
        target_id, end_point = _wire_end_to_endpoint(patch.get("target"))
        if target_id is not None:
            data["target"] = target_id
        if end_point is not None:
            properties["end_point"] = end_point

    style = _edge_wire_to_link_style(patch)
    if style:
        data["style"] = style

    if "content" in patch:
        markdown = patch.get("content")
        data["label"] = (
            {"markdown": str(markdown)} if isinstance(markdown, str) and markdown else None
        )

    midpoint = _extract_midpoint(patch)
    if midpoint is not None:
        properties["edge_control_point"] = midpoint
    if properties:
        data["properties"] = properties

    # Same scope-on-update story as `_node_patch_to_note_data` — see
    # the matching block there. Pasted edges and `useStampNewEdges`
    # rescope updates carry `parentId`/`graphUid` on `data`; surface
    # them so the deep-merge writes `parent_id` / `graph_uid` to the DB.
    wire_data = patch.get("data")
    if isinstance(wire_data, dict):
        if "parentId" in wire_data:
            data["parent_id"] = wire_data["parentId"]
        if "graphUid" in wire_data:
            data["graph_uid"] = wire_data["graphUid"]

    return data


def _edge_wire_to_link_style(payload: dict[str, Any]) -> dict[str, Any]:
    """Build a Dim0 LinkStyle patch dict from a wire `Edge` / `Partial<Edge>`.

    Pulls `pathStyle` off the top level (lifted on canvas-harness's
    `Edge`), the camelCase EdgeStyle fields off `style`, and canonical
    colors off `data._storedColors`. Returns an empty dict when nothing
    is set so callers can decide whether to skip the style key.
    """
    out: dict[str, Any] = {}

    path_style = payload.get("pathStyle")
    if isinstance(path_style, str):
        out["path_style"] = path_style

    wire_style = payload.get("style")
    if isinstance(wire_style, dict):
        for camel, value in wire_style.items():
            out[_camel_to_snake(camel)] = value

    canonical = _extract_canonical_colors(payload.get("data"))
    for k, v in canonical.items():
        out[k] = v

    return out


def _extract_midpoint(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Read the precomputed midpoint off a wire `Edge` / `Partial<Edge>`.

    The client computes the midpoint world coords from
    `cubicControlToMidpoint(source, target, control)` and attaches it
    here so the server doesn't have to look up node positions to
    rebuild it. Returns the PositionProperty-shaped dict ready to
    drop onto `properties.edge_control_point`, or None if absent.
    """
    m = payload.get("_midpoint")
    if not isinstance(m, dict):
        return None
    x = m.get("x")
    y = m.get("y")
    if x is None or y is None:
        return None
    try:
        return {
            "type": "position",
            "position": {"x": float(x), "y": float(y)},
        }
    except (TypeError, ValueError):
        return None


# Type alias for places that want to talk about a single op_type literal.
WireOpType = Literal[
    "node.add",
    "node.update",
    "node.remove",
    "edge.add",
    "edge.update",
    "edge.remove",
    "group.upsert",
    "group.remove",
    "frame.reorder",
]
