"""Note / Link → canvas-harness wire-shape converters.

Inverse of [topix.collab.apply_ops](apply_ops.py) for the subset of fields
the agent path produces. The full faithful conversion (theme adaptation,
image src lifting, document-type override) lives on the client; the
server-side version is intentionally lossy on cosmetic details since
the receiving peer rebuilds the rendered Node from this wire payload
via attachSync's remote-batch path.
"""

import math

from typing import Any

from topix.datatypes.note.link import Link
from topix.datatypes.note.note import Note

DEG_TO_RAD = math.pi / 180.0


# IMPORTANT: keep in sync with webui/src/features/board/harness/convert/
# node-type.ts (`DIM0_TO_CANVAS`). Four Dim0 enum values are renamed for
# canvas-harness's built-in shapes; the remaining 14 entries are 1:1 (built-in
# names or custom `defineNode` registrations on the client). A drift here
# breaks WS rendering for peers — agent-generated rectangles render
# invisible on the receiver because canvas-harness has no built-in
# called "rectangle".
_DIM0_TO_CANVAS_TYPE: dict[str, str] = {
    # Four renames — Dim0 vs canvas-harness shape vocabulary.
    "rectangle": "rect",
    "layered-rectangle": "layered-rect",
    "layered-circle": "layered-ellipse",
    "slide": "frame",
    # Identity — canvas-harness built-ins with the same string.
    "ellipse": "ellipse",
    "diamond": "diamond",
    "tag": "tag",
    "capsule": "capsule",
    "thought-cloud": "thought-cloud",
    "layered-diamond": "layered-diamond",
    "soft-diamond": "soft-diamond",
    "text": "text",
    "image": "image",
    "icon": "icon",
    # Identity — client-registered custom types via `defineNode`.
    "folder": "folder",
    "sheet": "sheet",
    "code-sandbox": "code-sandbox",
    "widget": "widget",
    "mini-app": "mini-app",
    "ink": "ink",
}

# Inverse map for the inbound persistence fallback (apply_ops.py). Auto-
# generated so it can't drift from `_DIM0_TO_CANVAS_TYPE`.
_CANVAS_TO_DIM0_TYPE: dict[str, str] = {v: k for k, v in _DIM0_TO_CANVAS_TYPE.items()}


# Canvas types whose lib height-autoFit must be off. These render only a
# preview of `node.content` (full sheet markdown, code source, etc.), so
# the lib's grow-to-fit would snap the node tall enough for the unseen
# body, with no cap. Without setting this on the wire, an agent-created
# sheet reaches peers with autoFit unset (→ on) and grows unbounded.
# IMPORTANT: keep in sync with webui/.../convert/note-to-node.ts
# (`AUTOFIT_DISABLED_TYPES`).
_AUTOFIT_DISABLED_CANVAS_TYPES: frozenset[str] = frozenset({
    "folder", "sheet", "code-sandbox", "widget", "mini-app", "document", "ink",
})


# Lifted / dropped Dim0 style keys — handled out-of-band before the
# remaining fields auto-translate snake_case → camelCase for the wire.
#   - `type`: discriminator; goes onto wire `data.styleType` instead.
#   - `angle`: lifted to `Node.angle` / not carried on EdgeStyle.
#   - `group_ids`: lifted to `Node.groups` / `Edge.groups`.
#   - `fill_style`: canvas-harness's Style has no `fillStyle` field
#     (solid-only per migration-canvas-harness §3.3).
#   - `path_style`: lifted to `Edge.pathStyle` (LinkStyle only).
_LIFTED_OR_DROPPED_STYLE_KEYS: frozenset[str] = frozenset({
    "type", "angle", "group_ids", "fill_style", "path_style",
})


def _snake_to_camel(s: str) -> str:
    """Convert `stroke_color` → `strokeColor`.

    Symmetric with `_camel_to_snake` for the closed-set Dim0 style
    vocabulary (single underscore-separated lowercase words). Used to
    bridge Dim0 LinkStyle / Style (snake_case) ↔ canvas-harness Style /
    EdgeStyle (camelCase) without maintaining a hand-written map.
    """
    head, *tail = s.split("_")
    return head + "".join(p[:1].upper() + p[1:] for p in tail if p)


def _camel_to_snake(s: str) -> str:
    """Convert `strokeColor` → `stroke_color`. Inverse of `_snake_to_camel`."""
    out: list[str] = []
    for i, ch in enumerate(s):
        if ch.isupper() and i > 0:
            out.append("_")
        out.append(ch.lower())
    return "".join(out)


def note_to_wire_node(note: Note) -> dict[str, Any]:
    """Build a canvas-harness `Node`-shaped dict from a Dim0 Note.

    Carries enough for `attachSync`'s remote-batch apply to add the
    node to the receiving client's store; remaining cosmetic
    differences (theme-adapted colors) are reconciled on the next
    snapshot load.
    """
    props = note.properties
    pos = props.node_position.position
    size = props.node_size.size

    style_dict: dict[str, Any] = note.style.model_dump(exclude_none=True)
    angle_deg = style_dict.pop("angle", 0) or 0
    style_type = style_dict.pop("type", None)
    group_ids = style_dict.pop("group_ids", []) or []
    # canvas-harness's `Style` has no `fillStyle` — Dim0 ships solid-only
    # per migration-canvas-harness §3.3. Drop the rest of the lifted /
    # dropped fields, then auto-convert remaining snake_case keys.
    for key in _LIFTED_OR_DROPPED_STYLE_KEYS:
        style_dict.pop(key, None)
    wire_style = {_snake_to_camel(k): v for k, v in style_dict.items()}

    # Disable the lib's grow-to-fit for preview-rendered custom types so
    # agent-created sheets don't auto-grow unbounded on the receiver.
    canvas_type = _canvas_type_for(note)
    if canvas_type in _AUTOFIT_DISABLED_CANVAS_TYPES:
        wire_style["autoFit"] = False

    data: dict[str, Any] = {
        "noteType": note.type,
        "styleType": style_type or note.style.type,
        "version": note.version,
        "graphUid": note.graph_uid,
        "parentId": note.parent_id,
        "label": note.label.model_dump(exclude_none=True) if note.label else None,
        # All non-lifted properties go on data.properties so the client
        # round-trips them via nodeToNote.
        "properties": _properties_minus_lifted(props),
    }
    stored = _note_stored_colors(note)
    if stored:
        data["_storedColors"] = stored

    return {
        "id": note.id,
        "type": canvas_type,
        "x": float(pos.x),
        "y": float(pos.y),
        "w": float(size.width),
        "h": float(size.height),
        "z": float(props.node_z_index.number),
        "angle": float(angle_deg) * DEG_TO_RAD,
        "groups": list(group_ids),
        "content": note.content.markdown if note.content else "",
        "style": wire_style,
        "data": {k: v for k, v in data.items() if v is not None},
    }


def link_to_wire_edge(
    link: Link,
    *,
    node_sizes: dict[str, tuple[float, float]] | None = None,
) -> dict[str, Any]:
    """Build a canvas-harness `Edge`-shaped dict from a Dim0 Link.

    Ships the full Edge contract so the receiver renders the agent's /
    peer's intent without waiting for a snapshot reload. Mirrors the
    client's `linkToEdge` in `webui/.../convert/link-to-edge.ts`.

    `pathStyle` is non-optional in canvas-harness's `Edge` type — the
    geometry cache (`samplesFor`) returns `undefined` without it and
    `edgeAABBFromSamples` then crashes on `.length`. We fall back to
    `"bezier"` matching Dim0's `LinkStyle.path_style` default.

    `localOffset` on attached endpoints also must exist — defaults to
    node center `(w/2, h/2)` when `node_sizes` provides the size, or
    `(0, 0)` as a last-resort fallback.

    The control midpoint is shipped as `_midpoint` (world coords); the
    receiver runs `midpointToCubicControls` to get the curve. Keeps the
    server stateless on geometry.
    """
    style_dict: dict[str, Any] = (
        link.style.model_dump(exclude_none=True) if link.style else {}
    )
    path_style = style_dict.pop("path_style", "bezier") or "bezier"
    group_ids = style_dict.pop("group_ids", []) or []
    for key in _LIFTED_OR_DROPPED_STYLE_KEYS:
        style_dict.pop(key, None)
    wire_style = {_snake_to_camel(k): v for k, v in style_dict.items()}

    # `Link.properties` is typed as the parent `ResourceProperties`; the
    # endpoint fields live on the `LinkProperties` subclass. Use getattr
    # so a Link constructed without going through `model_validate` (e.g.
    # in tests, or any pre-LinkProperties row) doesn't blow up here.
    start_point = getattr(link.properties, "start_point", None)
    end_point = getattr(link.properties, "end_point", None)
    edge: dict[str, Any] = {
        "id": link.id,
        "source": _link_end_to_wire(link.source, start_point, node_sizes),
        "target": _link_end_to_wire(link.target, end_point, node_sizes),
        "pathStyle": path_style,
        "z": 0,
        "groups": list(group_ids),
    }
    if wire_style:
        edge["style"] = wire_style
    if link.label and link.label.markdown:
        edge["content"] = link.label.markdown

    midpoint = _link_midpoint(link)
    if midpoint is not None:
        # Sent under `_midpoint` (not `control`) so the receiver can
        # build cubic controls with its own endpoint world coords.
        edge["_midpoint"] = midpoint

    stored = _style_stored_colors(link.style)
    if stored:
        edge["data"] = {"_storedColors": stored}

    return edge


def _link_end_to_wire(
    node_id: str,
    stored_point,
    node_sizes: dict[str, tuple[float, float]] | None,
) -> dict[str, Any]:
    """Translate one Dim0 Link endpoint to a canvas-harness EdgeEnd.

    Mirrors the inverse `_wire_end_to_endpoint` in `apply_ops.py`.
    Three cases on the outbound path:

      1. Empty `node_id` (free-floating) — emit `{worldPoint}`. Reads
         the world coords off `stored_point.position`.
      2. Attached + `stored_point.position` present — emit
         `{nodeId, localOffset}` using the stored offset, regardless
         of `is_local_offset` (the flag is a hint about interpretation,
         not the source of truth for the position).
      3. Attached + no stored position — fall back to node center via
         `node_sizes`, then to `(0, 0)`. Without this, canvas-harness
         crashes in `projectEndToWorld` on `undefined.x`.
    """
    pos = getattr(stored_point, "position", None) if stored_point else None
    if not node_id:
        # Free-floating — world coords. Default to origin if we have
        # neither a saved world point nor a falsy node id; the peer
        # will still render something (free edge at world (0, 0)).
        if pos is not None:
            return {"worldPoint": {"x": float(pos.x), "y": float(pos.y)}}
        return {"worldPoint": {"x": 0.0, "y": 0.0}}

    if pos is not None:
        return {
            "nodeId": node_id,
            "localOffset": {"x": float(pos.x), "y": float(pos.y)},
        }

    if node_sizes is not None:
        size = node_sizes.get(node_id)
        if size is not None:
            w, h = size
            return {
                "nodeId": node_id,
                "localOffset": {"x": w / 2.0, "y": h / 2.0},
            }
    return {"nodeId": node_id, "localOffset": {"x": 0.0, "y": 0.0}}


def _link_midpoint(link: Link) -> dict[str, float] | None:
    """Pull the world-coord midpoint off Link.properties.edge_control_point."""
    cp = getattr(link.properties, "edge_control_point", None)
    if cp is None:
        return None
    pos = getattr(cp, "position", None)
    if pos is None:
        return None
    try:
        return {"x": float(pos.x), "y": float(pos.y)}
    except (AttributeError, TypeError, ValueError):
        return None


def _style_stored_colors(style) -> dict[str, str] | None:
    """Build the `_storedColors` payload from a Dim0 Style / LinkStyle.

    Mirrors the client's `pickStoredColors / pickStoredEdgeColors`:
    canonical light-theme `backgroundColor / strokeColor / textColor`
    in camelCase, used by the receiver's `adaptNodeColors /
    adaptEdgeColors` to project for the local theme.
    """
    if style is None:
        return None
    out: dict[str, str] = {}
    if getattr(style, "stroke_color", None):
        out["strokeColor"] = style.stroke_color
    if getattr(style, "background_color", None):
        out["backgroundColor"] = style.background_color
    if getattr(style, "text_color", None):
        out["textColor"] = style.text_color
    return out or None


def _note_stored_colors(note: Note) -> dict[str, str] | None:
    """Build the `_storedColors` payload for a Note's style."""
    return _style_stored_colors(note.style)


def patch_data_to_wire_patch(data: dict[str, Any]) -> dict[str, Any]:  # noqa: C901 — wide field-by-field translator
    """Translate a Dim0 patch_note `data` dict into a `Partial<Node>` wire patch.

    Inverse of `_node_patch_to_note_data` in apply_ops.py. Only handles
    the scene-graph primitives shipped in Phase 1b — style / data depth
    follow as needed.
    """
    patch: dict[str, Any] = {}
    properties = data.get("properties") or {}

    node_position = properties.get("node_position")
    if node_position and "position" in node_position:
        pos = node_position["position"]
        if "x" in pos:
            patch["x"] = float(pos["x"])
        if "y" in pos:
            patch["y"] = float(pos["y"])

    node_size = properties.get("node_size")
    if node_size and "size" in node_size:
        size = node_size["size"]
        if "width" in size:
            patch["w"] = float(size["width"])
        if "height" in size:
            patch["h"] = float(size["height"])

    node_z = properties.get("node_z_index")
    if node_z and "number" in node_z:
        patch["z"] = float(node_z["number"])

    style = data.get("style")
    if isinstance(style, dict):
        angle = style.get("angle")
        if angle is not None:
            patch["angle"] = float(angle) * DEG_TO_RAD

    if "content" in data and isinstance(data["content"], dict):
        markdown = data["content"].get("markdown")
        if markdown is not None:
            patch["content"] = str(markdown)

    return patch


def _properties_minus_lifted(props) -> dict[str, Any]:
    """Strip the three lifted properties before serializing to wire.

    Removes position/size/z so they don't shadow `node.x/y/w/h/z` in
    the wire payload.
    """
    dumped = props.model_dump(exclude_none=True)
    dumped.pop("node_position", None)
    dumped.pop("node_size", None)
    dumped.pop("node_z_index", None)
    return dumped


def _canvas_type_for(note: Note) -> str:
    """Mirror the client's `dim0TypeToCanvas` mapping.

    Documents get the `'document'` canvas type; every other Dim0 style
    type is translated through `_DIM0_TO_CANVAS_TYPE`. Unknown values
    pass through unchanged so future Dim0 additions don't blow up the
    wire — they'll render as unregistered custom types on the receiver
    until the client-side map catches up.
    """
    if note.type == "document":
        return "document"
    if note.style and note.style.type:
        raw = str(note.style.type)
        return _DIM0_TO_CANVAS_TYPE.get(raw, raw)
    return "rect"
