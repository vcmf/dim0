"""Unit tests for the server-side op applier.

Mocks the GraphStore so each canvas-harness Op kind can be exercised
without Postgres/Qdrant.
"""

import math

from topix.collab.apply_ops import RAD_TO_DEG, WireOpResult, apply_batch, batch_had_persist_failure, should_reject_batch


class _RecordingGraphStore:
    """Records the args of each GraphStore call so tests can assert."""

    def __init__(self):
        """Init."""
        self.add_notes_calls: list = []
        self.patch_calls: list = []
        self.delete_node_calls: list = []
        self.add_links_calls: list = []
        self.update_link_calls: list = []
        self.delete_link_calls: list = []
        # Bulk-shape recordings (for tests asserting on grouped dispatch).
        self.patch_notes_bulk_calls: list = []
        self.delete_nodes_bulk_calls: list = []
        self.update_links_bulk_calls: list = []
        self.delete_links_bulk_calls: list = []

    async def add_notes(self, nodes):
        """Add notes."""
        self.add_notes_calls.append(nodes)

    async def patch_note(self, node_id, data, user_uid):
        """Patch note."""
        self.patch_calls.append({"node_id": node_id, "data": data, "user_uid": user_uid})

    async def delete_node(self, node_id, user_uid):
        """Delete node."""
        self.delete_node_calls.append({"node_id": node_id, "user_uid": user_uid})

    async def add_links(self, links):
        """Add links."""
        self.add_links_calls.append(links)

    async def update_link(self, link_id, data):
        """Update link."""
        self.update_link_calls.append({"link_id": link_id, "data": data})

    async def delete_link(self, link_id):
        """Delete link."""
        self.delete_link_calls.append(link_id)

    # ---- bulk methods used by apply_batch's grouped dispatch -----------
    # These mirror the per-op recording so existing assertions on
    # `patch_calls[0]["data"]` etc. keep working. Each (id, data) inside
    # a bulk call lands as one record. Tests that want to assert on bulk
    # shape can read the corresponding `*_bulk_calls` list.

    async def patch_notes(self, updates, user_uid=None):
        """Bulk patch notes — record per-item plus the bulk shape."""
        self.patch_notes_bulk_calls.append({"updates": list(updates), "user_uid": user_uid})
        for node_id, data in updates:
            self.patch_calls.append({"node_id": node_id, "data": data, "user_uid": user_uid})

    async def delete_nodes(self, node_ids, user_uid=None):
        """Bulk delete nodes — record per-item plus the bulk shape."""
        self.delete_nodes_bulk_calls.append({"node_ids": list(node_ids), "user_uid": user_uid})
        for node_id in node_ids:
            self.delete_node_calls.append({"node_id": node_id, "user_uid": user_uid})

    async def update_links(self, updates):
        """Bulk update links — record per-item plus the bulk shape."""
        self.update_links_bulk_calls.append({"updates": list(updates)})
        for link_id, data in updates:
            self.update_link_calls.append({"link_id": link_id, "data": data})

    async def delete_links(self, link_ids):
        """Bulk delete links — record per-item plus the bulk shape."""
        self.delete_links_bulk_calls.append({"link_ids": list(link_ids)})
        for link_id in link_ids:
            self.delete_link_calls.append(link_id)


# ---------------------------------------------------------------------------
# node.update
# ---------------------------------------------------------------------------

async def test_node_update_position_only():
    """Node update position only."""
    store = _RecordingGraphStore()
    op = {"type": "node.update", "id": "n1", "patch": {"x": 200, "y": 150}, "prev": {}}

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    assert store.patch_calls == [{
        "node_id": "n1",
        "user_uid": "u1",
        "data": {
            "properties": {
                "node_position": {
                    "type": "position",
                    "position": {"x": 200.0, "y": 150.0},
                },
            },
        },
    }]


async def test_node_update_resize_emits_node_size():
    """Node update resize emits node size."""
    store = _RecordingGraphStore()
    op = {"type": "node.update", "id": "n1", "patch": {"w": 400, "h": 250}, "prev": {}}

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert store.patch_calls[0]["data"] == {
        "properties": {
            "node_size": {"type": "size", "size": {"width": 400.0, "height": 250.0}},
        },
    }


async def test_node_update_height_only_does_not_zero_width():
    """A `node.update` with only `h` (no `w`) emits height alone.

    Regression: canvas-harness's `commitEdit` runs autofit and emits
    `{ content, h }` with the recomputed height — `w` stays unchanged
    so the patch doesn't include it. The translator used to default
    the missing dimension to 0, producing `node_size.size = {width: 0,
    height: <correct>}`, which then deep-merged over the existing
    note and wiped its width on the DB. On refresh the node came back
    with width=0 and collapsed to invisible.
    """
    store = _RecordingGraphStore()
    op = {"type": "node.update", "id": "n1", "patch": {"content": "abc", "h": 250}, "prev": {}}

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    data = store.patch_calls[0]["data"]
    # Only `height` is in the size patch — width is absent so deep-merge
    # leaves the existing width alone.
    assert data["properties"]["node_size"] == {
        "type": "size",
        "size": {"height": 250.0},
    }
    assert "width" not in data["properties"]["node_size"]["size"]


async def test_node_update_width_only_does_not_zero_height():
    """Symmetric to the height-only case.

    A `w`-only patch must not write `height: 0` and clobber the
    existing height on the DB.
    """
    store = _RecordingGraphStore()
    op = {"type": "node.update", "id": "n1", "patch": {"w": 400}, "prev": {}}

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    data = store.patch_calls[0]["data"]
    assert data["properties"]["node_size"] == {
        "type": "size",
        "size": {"width": 400.0},
    }
    assert "height" not in data["properties"]["node_size"]["size"]


async def test_node_update_x_only_does_not_zero_y():
    """Position patch with only `x` (no `y`) emits `x` alone.

    Defends against the same partial-dimension class of bug as size.
    """
    store = _RecordingGraphStore()
    op = {"type": "node.update", "id": "n1", "patch": {"x": 200}, "prev": {}}

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    data = store.patch_calls[0]["data"]
    assert data["properties"]["node_position"] == {
        "type": "position",
        "position": {"x": 200.0},
    }
    assert "y" not in data["properties"]["node_position"]["position"]


async def test_node_update_z_index():
    """Node update z index."""
    store = _RecordingGraphStore()
    op = {"type": "node.update", "id": "n1", "patch": {"z": 42}, "prev": {}}

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert store.patch_calls[0]["data"] == {
        "properties": {"node_z_index": {"type": "number", "number": 42.0}},
    }


async def test_node_update_angle_converts_radians_to_degrees():
    """Node update angle converts radians to degrees."""
    store = _RecordingGraphStore()
    op = {"type": "node.update", "id": "n1", "patch": {"angle": math.pi / 2}, "prev": {}}

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert store.patch_calls[0]["data"]["style"]["angle"] == (math.pi / 2) * RAD_TO_DEG


async def test_node_update_content_writes_to_content_markdown():
    """Node update content writes to content markdown."""
    store = _RecordingGraphStore()
    op = {"type": "node.update", "id": "n1", "patch": {"content": "# Hi"}, "prev": {}}

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert store.patch_calls[0]["data"]["content"] == {"markdown": "# Hi"}


async def test_node_update_content_null_clears_to_empty_markdown():
    """Undo of a first-time content set arrives as `content: null` over the wire.

    canvas-harness 0.1.8 fixed `slicePrev` to substitute `null` for
    `undefined` so the inverse op survives JSON serialization. The
    server's content path must therefore accept `null` and persist
    it as an explicit clear — empty markdown — instead of dropping
    the field on the floor.
    """
    store = _RecordingGraphStore()
    op = {"type": "node.update", "id": "n1", "patch": {"content": None}, "prev": {}}

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert store.patch_calls[0]["data"]["content"] == {"markdown": ""}


async def test_node_update_style_roundness_persists():
    """A style change like `roundness: 0` round-trips through the inbound path.

    Regression: `_node_patch_to_note_data` used to only handle the
    scene primitives (x/y/w/h/z/angle/content) and canonical colors
    via `_storedColors` — every other style field on `patch.style`
    was silently dropped, so picking "Sharp" (roundness=0) didn't
    persist, and a refresh restored the default `roundness`. The
    translator now camel→snake-translates the full `patch.style`
    block (minus display color keys, which still come via
    `_storedColors`).
    """
    store = _RecordingGraphStore()
    op = {
        "type": "node.update",
        "id": "n1",
        "patch": {"style": {"roundness": 0}},
        "prev": {},
    }

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert store.patch_calls[0]["data"]["style"] == {"roundness": 0}


async def test_node_update_style_strokes_and_fonts_persist():
    """Multiple non-color style fields all translate camel→snake correctly."""
    store = _RecordingGraphStore()
    op = {
        "type": "node.update",
        "id": "n1",
        "patch": {
            "style": {
                "strokeWidth": 4,
                "strokeStyle": "dashed",
                "fontFamily": "serif",
                "fontSize": "L",
                "textAlign": "left",
                "opacity": 80,
            },
        },
        "prev": {},
    }

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert store.patch_calls[0]["data"]["style"] == {
        "stroke_width": 4,
        "stroke_style": "dashed",
        "font_family": "serif",
        "font_size": "L",
        "text_align": "left",
        "opacity": 80,
    }


async def test_node_update_style_display_colors_ignored_in_favor_of_stored():
    """Display color keys on patch.style are dropped — `_storedColors` wins.

    The wire carries theme-adapted display colors on `style.*`; the
    canonical values are on `data._storedColors`. The translator must
    skip the display colors so a dark-mode peer's adapted hex doesn't
    overwrite the canonical record.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "node.update",
        "id": "n1",
        "patch": {
            "style": {
                "strokeColor": "#dadce0",     # dark-adapted, ignore
                "backgroundColor": "#222",    # dark-adapted, ignore
                "textColor": "#fafafa",       # dark-adapted, ignore
                "roundness": 0,               # non-color, keep
            },
            "data": {
                "_storedColors": {
                    "strokeColor": "#000000",     # canonical, win
                    "backgroundColor": "#ffffff", # canonical, win
                    "textColor": "#111111",       # canonical, win
                },
            },
        },
        "prev": {},
    }

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    style = store.patch_calls[0]["data"]["style"]
    assert style["stroke_color"] == "#000000"
    assert style["background_color"] == "#ffffff"
    assert style["text_color"] == "#111111"
    assert style["roundness"] == 0


async def test_node_update_colors_persist_from_stored_colors():
    """Colors persist from data._storedColors, not from `style.*`.

    The picker writes canonical hex into `data._storedColors`; the
    wire's `style.*` carries a (possibly dark-adapted) display value
    we deliberately ignore on the server.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "node.update",
        "id": "n1",
        "patch": {
            # `style` here carries the SENDER's display-adapted hex
            # (could be dark-mode). We deliberately ignore it.
            "style": {"backgroundColor": "#1A2C5C"},
            "data": {
                "_storedColors": {
                    "backgroundColor": "#3b82f6",
                    "strokeColor": "#1e3a8a",
                    "textColor": "#0a0a0a",
                },
            },
        },
        "prev": {},
    }

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    style = store.patch_calls[0]["data"]["style"]
    assert style["background_color"] == "#3b82f6"
    assert style["stroke_color"] == "#1e3a8a"
    assert style["text_color"] == "#0a0a0a"


async def test_node_update_parent_id_from_data_moves_to_top_level():
    """A `data.parentId` patch surfaces as a top-level `parent_id` move.

    Regression: paste into a sub-folder fired a `node.update` with the
    new `parentId` on `data`, but the translator only handed `data` /
    `properties` to `patch_notes` — `parent_id` never reached the
    deep-merge, so the DB kept the source folder. On refresh, the
    pasted note reappeared in the source location.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "node.update",
        "id": "n1",
        "patch": {"data": {"parentId": "folder-2", "graphUid": "b1"}},
        "prev": {},
    }

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    data = store.patch_calls[0]["data"]
    assert data["parent_id"] == "folder-2"
    assert data["graph_uid"] == "b1"


async def test_node_update_parent_id_null_moves_to_root():
    """A `data.parentId: null` patch surfaces as `parent_id: None` (root).

    Pasting a sub-folder note back at the root sends `parentId: null`
    on the wire. Without this, deep-merge wouldn't clear the existing
    `parent_id` and the note would stay in its old folder.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "node.update",
        "id": "n1",
        "patch": {"data": {"parentId": None}},
        "prev": {},
    }

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert store.patch_calls[0]["data"]["parent_id"] is None


async def test_node_update_without_stored_colors_does_not_emit_style_colors():
    """Position-only patches don't emit a style update.

    Without this, the embed-skip fast path in patch_note would
    accidentally see a non-empty style dict and take the slow path.
    """
    store = _RecordingGraphStore()
    op = {"type": "node.update", "id": "n1", "patch": {"x": 1, "y": 2}, "prev": {}}

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert "style" not in store.patch_calls[0]["data"]


async def test_node_add_carries_stored_colors_onto_style():
    """`node.add` mirrors `node.update` for color persistence.

    Canonical colors come from `data._storedColors`, not from the
    (possibly dark-adapted) `node.style` field.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "node.add",
        "node": {
            "id": "n1", "x": 0, "y": 0, "w": 200, "h": 80, "z": 0, "angle": 0,
            "content": "",
            "style": {"backgroundColor": "#1A2C5C"},
            "data": {
                "noteType": "note", "styleType": "rectangle", "version": 1,
                "_storedColors": {"backgroundColor": "#3b82f6"},
            },
        },
    }

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    [note] = store.add_notes_calls[0]
    assert note.style.background_color == "#3b82f6"


async def test_node_update_with_truly_empty_patch_is_not_applied():
    """A wire patch with no extractable fields skips the DB write.

    The "no supported fields" path is for patches that the translator
    can't turn into a Note update (e.g., empty / unrecognized). Style
    fields like `fontFamily` ARE supported now, so this test exercises
    the empty-patch case explicitly.
    """
    store = _RecordingGraphStore()
    op = {"type": "node.update", "id": "n1", "patch": {}, "prev": {}}

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is False
    assert store.patch_calls == []


# ---------------------------------------------------------------------------
# node.remove
# ---------------------------------------------------------------------------

async def test_node_remove_dispatches_to_delete_node():
    """Node remove dispatches to delete node."""
    store = _RecordingGraphStore()
    op = {"type": "node.remove", "node": {"id": "n1"}}

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    assert store.delete_node_calls == [{"node_id": "n1", "user_uid": "u1"}]


async def test_node_remove_missing_id_is_rejected():
    """Node remove missing id is rejected."""
    store = _RecordingGraphStore()
    op = {"type": "node.remove", "node": {}}

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is False
    assert store.delete_node_calls == []


# ---------------------------------------------------------------------------
# node.add
# ---------------------------------------------------------------------------

async def test_node_add_constructs_note_with_board_id_and_position():
    """Node add constructs note with board id and position."""
    store = _RecordingGraphStore()
    op = {
        "type": "node.add",
        "node": {
            "id": "n1",
            "x": 100, "y": 100, "w": 200, "h": 80, "z": 0,
            "angle": 0,
            "content": "hello",
            "data": {"noteType": "note", "styleType": "rectangle", "version": 1},
        },
    }

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    assert len(store.add_notes_calls) == 1
    [note] = store.add_notes_calls[0]
    assert note.id == "n1"
    assert note.graph_uid == "b1"
    assert note.content.markdown == "hello"
    pos = note.properties.node_position.position
    assert (pos.x, pos.y) == (100.0, 100.0)


async def test_node_add_falls_back_to_wire_type_when_style_type_missing():
    """When `data.styleType` is absent, translate the wire `type` back to Dim0.

    Defense-in-depth: a legacy / buggy client could ship a wire `node.add`
    without `data.styleType`. Without this fallback, the persisted Note's
    `style.type` would default to `"rectangle"` (Dim0 default) even when
    the wire said `type="ellipse"` — a silent data corruption that
    breaks REST round-trip on the next snapshot load.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "node.add",
        "node": {
            "id": "n1",
            "x": 0, "y": 0, "w": 200, "h": 80, "z": 0,
            "angle": 0,
            # NB: `type` uses canvas-harness vocabulary; `data.styleType`
            # is intentionally omitted to exercise the fallback.
            "type": "ellipse",
            "data": {"noteType": "note", "version": 1},
        },
    }

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    [note] = store.add_notes_calls[0]
    assert note.style.type == "ellipse"


async def test_node_add_wire_type_rect_maps_back_to_rectangle():
    """`type="rect"` (canvas-harness) → `style.type = "rectangle"` (Dim0).

    Inverse of the four shape renames in `_DIM0_TO_CANVAS_TYPE`.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "node.add",
        "node": {
            "id": "n1",
            "x": 0, "y": 0, "w": 200, "h": 80, "z": 0,
            "angle": 0,
            "type": "rect",
            "data": {"noteType": "note", "version": 1},
        },
    }

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    [note] = store.add_notes_calls[0]
    assert note.style.type == "rectangle"


def _applet_add_op(data: dict) -> dict:
    """Build a toolbar-shaped applet `node.add` op with the given `data` block."""
    return {
        "type": "node.add",
        "node": {
            "id": "a1",
            "type": "applet",
            "x": 0, "y": 0, "w": 300, "h": 220, "z": 0,
            "angle": 0,
            "content": "<Widget state={{ count: 0 }}>{count}</Widget>",
            "data": data,
        },
    }


async def test_node_add_persists_applet():
    """An applet created on a synced board persists as `applet`.

    Regression: `NodeType` had no `applet`, so `Note.model_validate` rejected
    every applet add — the relay refused the op and the node was never stored.
    """
    store = _RecordingGraphStore()
    op = _applet_add_op({"noteType": "note", "styleType": "applet", "version": 1})

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    [note] = store.add_notes_calls[0]
    assert note.style.type == "applet"
    assert note.content.markdown.startswith("<Widget")


async def test_node_add_applet_without_style_type_is_not_a_rectangle():
    """Wire `type="applet"` with no `data.styleType` maps back to `applet`.

    Regression: `applet` was missing from the wire type map, so the fallback
    found nothing and the note silently defaulted to `rectangle`.
    """
    store = _RecordingGraphStore()
    op = _applet_add_op({"noteType": "note", "version": 1})

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    [note] = store.add_notes_calls[0]
    assert note.style.type == "applet"


async def test_node_add_persists_style_roundness_from_wire():
    """A pasted node with `roundness: 0` keeps that value through `node.add`.

    Regression: `_wire_node_to_note` used to only read `styleType` /
    `angle` / canonical colors from the wire — every other style field
    fell to the pydantic default. Cross-board paste of a sharp node
    (roundness=0) then came back rounded (roundness=3) on refresh.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "node.add",
        "node": {
            "id": "n1",
            "x": 0, "y": 0, "w": 200, "h": 80, "z": 0,
            "angle": 0,
            "type": "rect",
            "style": {"roundness": 0, "strokeWidth": 4, "fontFamily": "serif"},
            "data": {"noteType": "note", "styleType": "rectangle", "version": 1},
        },
    }

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    [note] = store.add_notes_calls[0]
    assert note.style.roundness == 0
    assert note.style.stroke_width == 4
    assert note.style.font_family == "serif"


async def test_node_add_persists_image_url_from_data_properties():
    """An image node round-trips its URL via `data.properties.imageUrl`.

    Regression: `_wire_node_to_note` previously only extracted
    position/size/zindex from the wire. `imageUrl` lives on
    `data.properties` (stashed there by `note-to-node.ts`) and was
    silently dropped — refresh loaded a Note with an empty `image_url`
    and the image rendered blank.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "node.add",
        "node": {
            "id": "n1",
            "x": 0, "y": 0, "w": 200, "h": 200, "z": 0,
            "angle": 0,
            "type": "image",
            "data": {
                "noteType": "note",
                "styleType": "image",
                "version": 1,
                "properties": {
                    "imageUrl": {
                        "type": "image",
                        "image": {"url": "https://example.com/cat.png"},
                    },
                },
            },
        },
    }

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    [note] = store.add_notes_calls[0]
    assert note.properties.image_url.image is not None
    assert note.properties.image_url.image.url == "https://example.com/cat.png"


async def test_node_add_persists_icon_name_from_data_properties():
    """An icon node round-trips its identifier via `data.properties.iconData`.

    Same regression as image — without this lift, the icon name was
    lost on save and `use-hydrate-icon-nodes` had nothing to refetch
    on reload, so the icon rendered blank.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "node.add",
        "node": {
            "id": "n1",
            "x": 0, "y": 0, "w": 64, "h": 64, "z": 0,
            "angle": 0,
            "type": "svg-icon",
            "data": {
                "noteType": "note",
                "styleType": "icon",
                "version": 1,
                "properties": {
                    "iconData": {
                        "type": "icon",
                        "icon": {"type": "icon", "icon": "star"},
                    },
                },
            },
        },
    }

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    [note] = store.add_notes_calls[0]
    assert note.properties.icon_data.icon is not None
    assert note.properties.icon_data.icon.icon == "star"


async def test_node_update_lifts_data_properties_to_patch_dict():
    """`patch.data.properties` propagates so partial updates survive deep-merge.

    Companion of the add-path test: `_node_patch_to_note_data` is the
    shared extractor, so the lift applies to both wire paths.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "node.update",
        "id": "n1",
        "patch": {
            "data": {
                "properties": {
                    "imageUrl": {
                        "type": "image",
                        "image": {"url": "https://example.com/v2.png"},
                    },
                },
            },
        },
        "prev": {},
    }

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    data = store.patch_calls[0]["data"]
    assert data["properties"]["image_url"]["image"]["url"] == "https://example.com/v2.png"


async def test_node_update_lifts_phosphor_icon_data_with_color():
    """Lift phosphor-variant iconData through the `data.properties` extractor without dropping name/color.

    Defends the sheet-icon-picker persist path: a client writes
    `data.properties.iconData = {type:'icon', icon:{type:'phosphor', name, color}}`
    and the server must merge it into `properties.icon_data` keeping the
    nested phosphor payload intact (Pydantic discriminator deserializes
    later from the same dict shape).
    """
    store = _RecordingGraphStore()
    op = {
        "type": "node.update",
        "id": "n1",
        "patch": {
            "data": {
                "properties": {
                    "iconData": {
                        "type": "icon",
                        "icon": {"type": "phosphor", "name": "Lightbulb", "color": "#dc2626"},
                    },
                },
            },
        },
        "prev": {},
    }

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    data = store.patch_calls[0]["data"]
    assert data["properties"]["icon_data"] == {
        "type": "icon",
        "icon": {"type": "phosphor", "name": "Lightbulb", "color": "#dc2626"},
    }


async def test_node_update_lifts_label_to_patch_dict():
    """A `node.update` carrying `data.label` lifts to the merged patch.

    Title renames done via the local-store path (sheet-panel.persistTitle
    and NodeTitleCaption.commitTitle) write to `data.label`. Without
    this lift the wire op reaches the server but the title never lands
    in the DB — refresh reverts the rename.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "node.update",
        "id": "n1",
        "patch": {"data": {"label": {"markdown": "Daily standup"}}},
        "prev": {},
    }

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert store.patch_calls[0]["data"]["label"] == {"markdown": "Daily standup"}


async def test_node_update_label_cleared_with_explicit_null():
    """An explicit `data.label: null` clears the title via deep-merge."""
    store = _RecordingGraphStore()
    op = {
        "type": "node.update",
        "id": "n1",
        "patch": {"data": {"label": None}},
        "prev": {},
    }

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert store.patch_calls[0]["data"]["label"] is None


async def test_node_update_label_ignored_when_markdown_missing():
    """A malformed `data.label` (no markdown string) is silently skipped.

    Defensive: a malformed peer could ship `data.label: {}` and we'd
    rather keep the existing title than wipe it with a bad payload.
    The op carries an unrelated field (`x`) so the patch still fires
    and we can assert the absence of `label` in the resulting dict.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "node.update",
        "id": "n1",
        "patch": {"x": 100, "data": {"label": {"foo": "bar"}}},
        "prev": {},
    }

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert "label" not in store.patch_calls[0]["data"]


async def test_node_add_persists_label_from_data():
    """A `node.add` op with `data.label` keeps the title on the new Note.

    Mirror of the icon-name lift on the add path: without this, a newly
    created sheet's title isn't surfaced to the server and reload shows
    "Untitled".
    """
    store = _RecordingGraphStore()
    op = {
        "type": "node.add",
        "node": {
            "id": "n1",
            "x": 0, "y": 0, "w": 320, "h": 200, "z": 0,
            "angle": 0,
            "type": "sheet",
            "data": {
                "noteType": "note",
                "styleType": "sheet",
                "version": 1,
                "label": {"markdown": "Welcome"},
            },
        },
    }

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    [note] = store.add_notes_calls[0]
    assert note.label is not None
    assert note.label.markdown == "Welcome"


async def test_node_update_phosphor_icon_with_css_var_color():
    """The CSS-var color form (`var(--color-foreground)`) round-trips as-is.

    The dark-mode adapter is a render-time concern; the wire should
    never see an adapted color. Bare string, no parsing.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "node.update",
        "id": "n1",
        "patch": {
            "data": {
                "properties": {
                    "iconData": {
                        "type": "icon",
                        "icon": {
                            "type": "phosphor",
                            "name": "Heart",
                            "color": "var(--color-foreground)",
                        },
                    },
                },
            },
        },
        "prev": {},
    }

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    data = store.patch_calls[0]["data"]
    assert data["properties"]["icon_data"]["icon"]["color"] == "var(--color-foreground)"


async def test_node_add_data_properties_cannot_override_top_level_size():
    """A bogus `data.properties.nodeSize` doesn't clobber top-level w/h.

    Defensive: the convert layer strips nodeSize/nodePosition/nodeZIndex
    from `data.properties` before sending, but a malformed peer could
    echo them back. The explicit top-level `w`/`h` lift must win.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "node.add",
        "node": {
            "id": "n1",
            "x": 0, "y": 0, "w": 100, "h": 80, "z": 0,
            "angle": 0,
            "type": "rect",
            "data": {
                "noteType": "note",
                "version": 1,
                "properties": {
                    # Top-level w/h say 100x80; this attempts to override.
                    "nodeSize": {
                        "type": "size",
                        "size": {"width": 999, "height": 999},
                    },
                },
            },
        },
    }

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    [note] = store.add_notes_calls[0]
    assert note.properties.node_size.size is not None
    assert note.properties.node_size.size.width == 100
    assert note.properties.node_size.size.height == 80


# ---------------------------------------------------------------------------
# edge.* — Link round-trip
# ---------------------------------------------------------------------------

async def test_edge_add_constructs_link_with_endpoints():
    """Edge add constructs link with endpoints."""
    store = _RecordingGraphStore()
    op = {
        "type": "edge.add",
        "edge": {
            "id": "e1",
            "source": {"nodeId": "n1"},
            "target": {"nodeId": "n2"},
        },
    }

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    [link] = store.add_links_calls[0]
    assert link.id == "e1"
    assert link.graph_uid == "b1"
    assert link.source == "n1"
    assert link.target == "n2"


async def test_edge_add_carries_parent_id_from_data():
    """An `edge.add` with `data.parentId` lands in `Link.parent_id`.

    Regression: `_wire_edge_to_link` ignored `data.parentId`, so arrows
    drawn inside a sub-folder got persisted with `parent_id` NULL and
    appeared at the root board on refresh. Same shape of bug as
    `_wire_node_to_note` already handled for nodes.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "edge.add",
        "edge": {
            "id": "e1",
            "source": {"nodeId": "n1"},
            "target": {"nodeId": "n2"},
            "data": {"parentId": "folder-1", "version": 1},
        },
    }

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    [link] = store.add_links_calls[0]
    assert link.parent_id == "folder-1"


async def test_edge_update_parent_id_from_data_moves_to_top_level():
    """An `edge.update` with `data.parentId` surfaces as a top-level move.

    Regression: `_edge_patch_to_link_data` only read endpoint / style /
    label / midpoint fields. Rescope updates from `useStampNewEdges`
    were invisible server-side, so a pasted edge stayed at the source
    `parent_id` on the DB.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "edge.update",
        "id": "e1",
        "patch": {"data": {"parentId": "folder-2", "graphUid": "b1"}},
        "prev": {},
    }

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    data = store.update_link_calls[0]["data"]
    assert data["parent_id"] == "folder-2"
    assert data["graph_uid"] == "b1"


async def test_edge_update_parent_id_null_moves_to_root():
    """An `edge.update` with `data.parentId: null` clears to root."""
    store = _RecordingGraphStore()
    op = {
        "type": "edge.update",
        "id": "e1",
        "patch": {"data": {"parentId": None}},
        "prev": {},
    }

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert store.update_link_calls[0]["data"]["parent_id"] is None


async def test_edge_remove_dispatches_to_delete_link():
    """Edge remove dispatches to delete link."""
    store = _RecordingGraphStore()
    op = {"type": "edge.remove", "edge": {"id": "e1"}}

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert store.delete_link_calls == ["e1"]


async def test_edge_update_endpoint_change():
    """Edge update endpoint change."""
    store = _RecordingGraphStore()
    op = {
        "type": "edge.update",
        "id": "e1",
        "patch": {"target": {"nodeId": "n3"}},
        "prev": {},
    }

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    assert store.update_link_calls == [{"link_id": "e1", "data": {"target": "n3"}}]


async def test_edge_update_persists_midpoint_to_control_point():
    """Edge curve adjustments persist as `properties.edge_control_point`.

    The wire carries a `_midpoint` field (the client computes it from
    cubic-bezier control points before sending) so the server stays
    stateless — no node-position lookup needed.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "edge.update",
        "id": "e1",
        "patch": {
            # canvas-harness Edge.control stays on the wire for peers
            # to paint with; the server ignores it.
            "control": [{"x": 50, "y": 10}, {"x": 50, "y": 10}],
            "_midpoint": {"x": 50, "y": 25},
        },
        "prev": {},
    }

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    expected = {
        "properties": {
            "edge_control_point": {
                "type": "position",
                "position": {"x": 50.0, "y": 25.0},
            },
        },
    }
    assert store.update_link_calls == [{"link_id": "e1", "data": expected}]


async def test_edge_add_persists_label_and_style_and_path_style():
    """An edge.add with content + style + pathStyle round-trips into the Link.

    Mirrors the client's outbound wire shape (camelCase EdgeStyle); the
    server snake_cases the fields back onto `LinkStyle` and saves
    `content` as `Link.label.markdown`.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "edge.add",
        "edge": {
            "id": "e1",
            "source": {"nodeId": "n1"},
            "target": {"nodeId": "n2"},
            "pathStyle": "straight",
            "content": "labeled edge",
            "style": {
                "strokeColor": "#ff0000",
                "strokeWidth": 3,
                "strokeStyle": "dashed",
                "sourceArrowhead": "barb",
                "targetArrowhead": "arrow-filled",
            },
        },
    }

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    [link] = store.add_links_calls[0]
    assert link.label is not None
    assert link.label.markdown == "labeled edge"
    assert link.style.path_style == "straight"
    assert link.style.stroke_color == "#ff0000"
    assert link.style.stroke_width == 3
    assert link.style.stroke_style == "dashed"
    assert link.style.source_arrowhead == "barb"
    assert link.style.target_arrowhead == "arrow-filled"


async def test_edge_update_persists_label_and_path_style():
    """An edge.update with content + pathStyle propagates to update_link.

    `content` becomes `label.markdown`; `pathStyle` ends up nested under
    the `style` patch dict (snake_case).
    """
    store = _RecordingGraphStore()
    op = {
        "type": "edge.update",
        "id": "e1",
        "patch": {
            "content": "renamed",
            "pathStyle": "polyline",
            "style": {"textColor": "#222222"},
        },
        "prev": {},
    }

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    [call] = store.update_link_calls
    assert call["link_id"] == "e1"
    assert call["data"]["label"] == {"markdown": "renamed"}
    assert call["data"]["style"] == {
        "path_style": "polyline",
        "text_color": "#222222",
    }


async def test_edge_update_clears_label_when_content_empty():
    """An empty `content` patch clears the label (deep-merge sets None)."""
    store = _RecordingGraphStore()
    op = {
        "type": "edge.update",
        "id": "e1",
        "patch": {"content": ""},
        "prev": {},
    }

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    [call] = store.update_link_calls
    assert call["data"]["label"] is None


async def test_edge_update_clears_label_when_content_null():
    """Undo of a first-time label set arrives as `content: null` over the wire.

    canvas-harness 0.1.8 fixed `slicePrev` to substitute `null` for
    `undefined` so an inverse op like `patch: { content: null }`
    survives `JSON.stringify` instead of becoming `patch: {}`. The
    edge-label persistence path treats `null` identically to `""` —
    both clear the label.

    Without this contract, undoing a first-time edge-label edit
    silently no-ops on every peer (the symptom of issue confirmed
    after smoke).
    """
    store = _RecordingGraphStore()
    op = {
        "type": "edge.update",
        "id": "e1",
        "patch": {"content": None},
        "prev": {},
    }

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    [call] = store.update_link_calls
    assert call["data"]["label"] is None


async def test_edge_add_pulls_canonical_colors_from_stored_colors():
    """`data._storedColors` on edge.add overrides display-adapted style colors.

    Symmetric to the node-side `_storedColors` handling — keeps the
    user's canonical pick in the DB regardless of the sender's theme.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "edge.add",
        "edge": {
            "id": "e1",
            "source": {"nodeId": "n1"},
            "target": {"nodeId": "n2"},
            "style": {"strokeColor": "#display-adapted"},
            "data": {
                "_storedColors": {
                    "strokeColor": "#0a0a0a",
                    "textColor": "#111111",
                },
            },
        },
    }

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    [link] = store.add_links_calls[0]
    assert link.style.stroke_color == "#0a0a0a"
    assert link.style.text_color == "#111111"


async def test_edge_add_persists_attached_endpoint_local_offset():
    """A user-drawn edge stores its `localOffset` so it doesn't snap to center.

    Regression: the inbound WS path used to read only `nodeId` from the
    endpoint, dropping `localOffset` on the floor. On the next reload
    `linkToEdge` then fell through to the (w/2, h/2) default and every
    edge endpoint snapped to the node's center — the bug surfaced from
    smoke testing after collab became the sole writer.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "edge.add",
        "edge": {
            "id": "e1",
            "source": {"nodeId": "n1", "localOffset": {"x": 50, "y": 30}},
            "target": {"nodeId": "n2", "localOffset": {"x": 180, "y": 10}},
        },
    }

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    [link] = store.add_links_calls[0]
    assert link.source == "n1"
    assert link.target == "n2"
    # `is_local_offset` is set on both endpoints — disambiguates from
    # the legacy world-coord interpretation when read back.
    assert link.properties.start_point.is_local_offset is True
    assert link.properties.start_point.position.x == 50.0
    assert link.properties.start_point.position.y == 30.0
    assert link.properties.end_point.is_local_offset is True
    assert link.properties.end_point.position.x == 180.0
    assert link.properties.end_point.position.y == 10.0


async def test_edge_add_persists_free_endpoint_world_point():
    """A free-floating endpoint persists as `source == ""` + world-coord position.

    Inbound WS used to reject free endpoints entirely (no `nodeId` →
    early return). Now we flatten them to the empty-string sentinel +
    world-coord `start_point`/`end_point` with `is_local_offset=False`,
    matching the REST round-trip convention.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "edge.add",
        "edge": {
            "id": "e1",
            "source": {"nodeId": "n1", "localOffset": {"x": 100, "y": 50}},
            "target": {"worldPoint": {"x": 800, "y": 400}},
        },
    }

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    [link] = store.add_links_calls[0]
    assert link.source == "n1"
    assert link.target == ""    # empty-string sentinel for free
    assert link.properties.end_point.is_local_offset is False
    assert link.properties.end_point.position.x == 800.0
    assert link.properties.end_point.position.y == 400.0


async def test_edge_update_endpoint_change_carries_local_offset():
    """An `edge.update` that moves an endpoint persists the new `localOffset`.

    Used when the user drags an attached endpoint to a different
    position on the same node (or onto a different node entirely).
    Without this the new position is lost on reload.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "edge.update",
        "id": "e1",
        "patch": {
            "target": {"nodeId": "n3", "localOffset": {"x": 25, "y": 75}},
        },
        "prev": {},
    }

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    [call] = store.update_link_calls
    assert call["data"]["target"] == "n3"
    assert call["data"]["properties"]["end_point"]["position"] == {"x": 25.0, "y": 75.0}
    assert call["data"]["properties"]["end_point"]["is_local_offset"] is True


async def test_edge_add_carries_midpoint_onto_link_properties():
    """A freshly-drawn edge with a curve persists the midpoint on create."""
    store = _RecordingGraphStore()
    op = {
        "type": "edge.add",
        "edge": {
            "id": "e1",
            "source": {"nodeId": "n1"},
            "target": {"nodeId": "n2"},
            "control": [{"x": 100, "y": 50}, {"x": 100, "y": 50}],
            "_midpoint": {"x": 100, "y": 60},
        },
    }

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is True
    [link] = store.add_links_calls[0]
    assert link.properties.edge_control_point.position.x == 100.0
    assert link.properties.edge_control_point.position.y == 60.0


# ---------------------------------------------------------------------------
# Unsupported / batch behaviour
# ---------------------------------------------------------------------------

async def test_unsupported_op_does_not_apply_but_does_not_raise():
    """Unsupported op does not apply but does not raise."""
    store = _RecordingGraphStore()
    op = {"type": "group.upsert", "group": {"id": "g1"}}

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])

    assert results[0].applied is False
    assert results[0].reason == "unsupported op type"


async def test_batch_keeps_processing_after_a_single_op_fails():
    """Batch keeps processing after a single op fails."""
    store = _RecordingGraphStore()
    ops = [
        {"type": "node.update", "id": "n1", "patch": {"x": 1, "y": 2}, "prev": {}},
        {"type": "group.upsert", "group": {"id": "g1"}},  # unsupported
        {"type": "node.remove", "node": {"id": "n2"}},
    ]

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=ops)

    assert [r.applied for r in results] == [True, False, True]
    assert len(store.patch_calls) == 1
    assert len(store.delete_node_calls) == 1


async def test_op_handler_exception_is_caught_per_bucket():
    """A failing bulk dispatch fails every op in that bucket, others continue.

    Bulk dispatch is atomic from `apply_batch`'s perspective — when the
    backing store raises we can't tell which specific op in the bucket
    caused it without falling back to per-op apply, which would defeat
    the batching optimization. So we mark every op in the failing
    bucket as `applied=False` with the exception message, and let other
    kinds proceed. The WS handler still broadcasts the original batch
    regardless of apply results.
    """

    class _BoomStore(_RecordingGraphStore):
        async def patch_notes(self, updates, user_uid=None):
            """Bulk patch raises — should fail every node.update op in the bucket."""
            raise RuntimeError("db down")

    store = _BoomStore()
    ops = [
        {"type": "node.update", "id": "n1", "patch": {"x": 1, "y": 2}, "prev": {}},
        {"type": "node.update", "id": "n2", "patch": {"x": 3, "y": 4}, "prev": {}},
        {"type": "node.remove", "node": {"id": "n3"}},
    ]

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=ops)

    # Both updates fail with the same reason; the remove still applies.
    assert results[0].applied is False
    assert results[0].reason and "db down" in results[0].reason
    assert results[1].applied is False
    assert results[1].reason and "db down" in results[1].reason
    assert results[2].applied is True


# ---------------------------------------------------------------------------
# Grouped bulk dispatch — the win behind apply_batch's restructure.
# ---------------------------------------------------------------------------

async def test_homogeneous_node_add_batch_dispatches_as_one_bulk_call():
    """1000 node.add ops should hit `add_notes` once, not 1000 times.

    This is the core scaling fix — without grouping, a paste-1000-nodes
    batch produces 1000 single-item embedding + Qdrant round-trips.
    With grouping it's one embed call + one upsert.
    """
    store = _RecordingGraphStore()
    ops = [
        {
            "type": "node.add",
            "node": {
                "id": f"n{i}",
                "x": 0, "y": 0, "w": 200, "h": 80, "z": 0, "angle": 0,
                "data": {"noteType": "note", "styleType": "rectangle", "version": 1},
            },
        }
        for i in range(50)
    ]

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=ops)

    assert all(r.applied for r in results)
    # One bulk add_notes call with 50 notes — not 50 separate calls.
    assert len(store.add_notes_calls) == 1
    assert len(store.add_notes_calls[0]) == 50


async def test_homogeneous_node_update_batch_dispatches_as_one_patch_notes_call():
    """N node.updates collapse to one bulk patch_notes(updates) call."""
    store = _RecordingGraphStore()
    ops = [
        {"type": "node.update", "id": f"n{i}", "patch": {"x": i, "y": i}, "prev": {}}
        for i in range(20)
    ]

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=ops)

    # One bulk call with 20 (id, data) pairs.
    assert len(store.patch_notes_bulk_calls) == 1
    assert len(store.patch_notes_bulk_calls[0]["updates"]) == 20
    # user_uid threaded through so snapshots can attribute correctly.
    assert store.patch_notes_bulk_calls[0]["user_uid"] == "u1"


async def test_homogeneous_node_remove_batch_dispatches_as_one_delete_nodes_call():
    """N node.removes collapse to one bulk delete_nodes(ids) call."""
    store = _RecordingGraphStore()
    ops = [
        {"type": "node.remove", "node": {"id": f"n{i}"}}
        for i in range(15)
    ]

    await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=ops)

    assert len(store.delete_nodes_bulk_calls) == 1
    assert len(store.delete_nodes_bulk_calls[0]["node_ids"]) == 15


async def test_mixed_batch_groups_ops_by_kind_each_kind_one_bulk_call():
    """An interleaved batch still collapses to ONE bulk call per kind.

    Cross-kind execution order is deterministic (adds → updates →
    edge.* → removes). Within a kind, input order is preserved so
    same-id sequences (e.g., two updates on n1) merge correctly in
    `patch_notes`.
    """
    store = _RecordingGraphStore()
    _node = {"x": 0, "y": 0, "w": 10, "h": 10, "z": 0, "angle": 0}
    _data = {"noteType": "note", "styleType": "rectangle", "version": 1}
    ops = [
        {"type": "node.add", "node": {"id": "n1", **_node, "data": _data}},
        {"type": "node.update", "id": "n2", "patch": {"x": 5, "y": 5}, "prev": {}},
        {"type": "node.add", "node": {"id": "n3", **_node, "data": _data}},
        {"type": "node.update", "id": "n4", "patch": {"x": 9, "y": 9}, "prev": {}},
        {"type": "node.remove", "node": {"id": "n5"}},
    ]

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=ops)

    # Per-kind: one bulk call carrying all items of that kind.
    assert len(store.add_notes_calls) == 1
    assert len(store.add_notes_calls[0]) == 2     # n1, n3
    assert len(store.patch_notes_bulk_calls) == 1
    assert len(store.patch_notes_bulk_calls[0]["updates"]) == 2   # n2, n4
    assert len(store.delete_nodes_bulk_calls) == 1
    assert len(store.delete_nodes_bulk_calls[0]["node_ids"]) == 1  # n5
    # All 5 results in input order, all applied.
    assert [r.applied for r in results] == [True] * 5


async def test_invalid_ops_excluded_from_bucket_dont_poison_bulk_dispatch():
    """Per-op validation failure skips that op without failing the bucket.

    Without this guarantee, a single malformed `node.update` in a 1000-
    op batch would prevent the other 999 from being dispatched.
    """
    store = _RecordingGraphStore()
    ops = [
        {"type": "node.update", "id": "n1", "patch": {"x": 1, "y": 1}, "prev": {}},
        {"type": "node.update", "patch": {"x": 2}, "prev": {}},  # missing id
        {"type": "node.update", "id": "n3", "patch": {"x": 3, "y": 3}, "prev": {}},
    ]

    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=ops)

    # Middle op fails its own validation; flanking ops still applied.
    assert [r.applied for r in results] == [True, False, True]
    assert results[1].reason == "missing id"
    # The single bulk patch_notes call only carried the two valid ops.
    assert len(store.patch_notes_bulk_calls) == 1
    assert len(store.patch_notes_bulk_calls[0]["updates"]) == 2


# ---------------------------------------------------------------------------
# persist-failure classification + reject policy
# ---------------------------------------------------------------------------

def test_batch_had_persist_failure_keys_off_the_flag():
    """batch_had_persist_failure reads the structured flag, not the reason text."""
    real = WireOpResult(applied=False, op_type="node.add", reason="could not construct Note", persist_failure=True)
    deferred = WireOpResult(applied=False, op_type="group.upsert", reason="unsupported op type")
    ok = WireOpResult(applied=True, op_type="node.add")
    assert batch_had_persist_failure([real]) is True
    assert batch_had_persist_failure([deferred]) is False  # relay-only, not a loss
    assert batch_had_persist_failure([ok, ok]) is False


def test_should_reject_only_single_op_total_failure():
    """Reject a lone failed op; never a multi-op (coalesced/paste) batch."""
    fail = WireOpResult(applied=False, op_type="node.add", reason="x", persist_failure=True)
    ok = WireOpResult(applied=True, op_type="node.add")
    deferred = WireOpResult(applied=False, op_type="group.upsert", reason="unsupported op type")
    assert should_reject_batch([fail]) is True            # lone failure → safe to roll back
    assert should_reject_batch([fail, ok]) is False       # a sibling persisted → keep it
    assert should_reject_batch([fail, fail]) is False     # paste/coalesced → never destroy the batch
    assert should_reject_batch([deferred]) is False       # lone relay-only op → not a failure
    assert should_reject_batch([ok]) is False


async def test_node_add_construct_failure_flags_persist_failure():
    """A node.add that can't build a Note is flagged as a real durability failure."""
    store = _RecordingGraphStore()
    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[{"type": "node.add", "node": {}}])
    assert results[0].applied is False
    assert results[0].persist_failure is True
    assert should_reject_batch(results) is True


async def test_group_upsert_is_not_a_persist_failure():
    """A deferred/relayed op kind is applied=False but NOT a persist failure."""
    store = _RecordingGraphStore()
    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[{"type": "group.upsert", "group": {"id": "g1"}}])
    assert results[0].applied is False
    assert results[0].persist_failure is False
    assert should_reject_batch(results) is False


# ---------------------------------------------------------------------------
# ink round-trip guard — pen color survives apply_batch (persist path)
# ---------------------------------------------------------------------------

async def test_ink_node_add_persists_stroke_color():
    """An ink node.add keeps its pen color through the persist path.

    End-to-end guard for the color-loss regression: apply_batch skips the wire
    style's display colors and persists the canonical ones from data._storedColors.
    Ink must carry _storedColors, else stroke_color falls to the transparent
    default and the reloaded stroke paints invisibly.
    """
    store = _RecordingGraphStore()
    op = {
        "type": "node.add",
        "node": {
            "id": "k1", "type": "ink",
            "x": 0, "y": 0, "w": 10, "h": 10, "angle": 0, "z": 0, "groups": [],
            "style": {"strokeColor": "#1f2937", "backgroundColor": "transparent"},
            "data": {
                "styleType": "ink",
                "ink": {
                    "type": "ink", "version": 1, "size": 5,
                    "points": [[0.0, 0.0, 0.5], [4.0, 3.0, 0.6]],
                    "intrinsicWidth": 10.0, "intrinsicHeight": 10.0,
                },
                "_storedColors": {"strokeColor": "#1f2937", "backgroundColor": "transparent"},
            },
        },
    }
    results = await apply_batch(graph_store=store, board_id="b1", user_id="u1", ops=[op])
    assert results[0].applied is True
    assert not batch_had_persist_failure(results)
    note = store.add_notes_calls[0][0]
    assert note.style.stroke_color == "#1f2937"   # NOT the transparent default
    assert note.properties.ink_data is not None
