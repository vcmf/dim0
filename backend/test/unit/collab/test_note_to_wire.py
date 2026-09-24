"""Tests for the server-side Note/Link → canvas-harness wire converters.

The wire `type` field on a Node must use canvas-harness's shape
vocabulary, not Dim0's enum values. Four entries are renamed
(`rectangle → rect`, `layered-rectangle → layered-rect`,
`layered-circle → layered-ellipse`, `slide → frame`); the rest are
1:1 with either built-in shapes or client-registered custom defs.
"""

import re

from pathlib import Path

import pytest

from topix.collab.note_to_wire import (
    _CANVAS_TO_DIM0_TYPE,
    _DIM0_TO_CANVAS_TYPE,
    _camel_to_snake,
    _snake_to_camel,
    note_to_wire_node,
)
from topix.datatypes.file.document import Document
from topix.datatypes.note.note import Note
from topix.datatypes.note.style import NodeType, StrokeStyle, Style


def _note_with_style_type(style_type: NodeType) -> Note:
    """Build a minimal Note carrying a specific Dim0 NodeType for wire conversion."""
    return Note(id="n1", graph_uid="b1", style=Style(type=style_type))


# All four shape renames where Dim0 and canvas-harness disagree on the name.
RENAMES = [
    (NodeType.RECTANGLE, "rect"),
    (NodeType.LAYERED_RECTANGLE, "layered-rect"),
    (NodeType.LAYERED_CIRCLE, "layered-ellipse"),
    (NodeType.SLIDE, "frame"),
]


# Types where the Dim0 enum string matches the canvas-harness
# built-in / custom-def string verbatim. Listed explicitly so a future
# rename or custom-def addition surfaces here.
IDENTITY = [
    (NodeType.ELLIPSE, "ellipse"),
    (NodeType.DIAMOND, "diamond"),
    (NodeType.TAG, "tag"),
    (NodeType.CAPSULE, "capsule"),
    (NodeType.THOUGHT_CLOUD, "thought-cloud"),
    (NodeType.LAYERED_DIAMOND, "layered-diamond"),
    (NodeType.SOFT_DIAMOND, "soft-diamond"),
    (NodeType.TEXT, "text"),
    (NodeType.IMAGE, "image"),
    (NodeType.ICON, "icon"),
    (NodeType.FOLDER, "folder"),
    (NodeType.SHEET, "sheet"),
    (NodeType.CODE_SANDBOX, "code-sandbox"),
    (NodeType.WIDGET, "widget"),
    (NodeType.APPLET, "applet"),
]


# The client's Dim0 → canvas type table — the source of truth for which node
# types the UI can create. Read from the monorepo so a new client type can't
# ship without server support.
_CLIENT_NODE_TYPE_TS = (
    Path(__file__).resolve().parents[4]
    / "webui/src/features/board/harness/convert/node-type.ts"
)


def _client_dim0_to_canvas() -> dict[str, str]:
    """Parse `DIM0_TO_CANVAS` out of the client's node-type.ts."""
    source = _CLIENT_NODE_TYPE_TS.read_text()
    body = re.search(r"const DIM0_TO_CANVAS[^=]*=\s*\{(.*?)\n\}", source, re.S)
    assert body, "DIM0_TO_CANVAS not found in node-type.ts"
    pairs = re.findall(r'^\s*"?([\w-]+)"?\s*:\s*"([\w-]+)"', body.group(1), re.M)
    return dict(pairs)


@pytest.mark.skipif(not _CLIENT_NODE_TYPE_TS.exists(), reason="webui/ not checked out")
def test_server_knows_every_client_node_type() -> None:
    """Every node type the client can create is a server NodeType with the same wire name.

    Regression: the client shipped `applet` but the server enum/map didn't, so
    synced applets were rejected (or persisted as rectangles) on every add.
    """
    client = _client_dim0_to_canvas()
    assert len(client) > 10, "parser matched too few entries — node-type.ts format changed?"
    server_types = {t.value for t in NodeType}
    assert set(client) - server_types == set(), "client types missing from NodeType"
    assert {k: v for k, v in client.items() if _DIM0_TO_CANVAS_TYPE.get(k) != v} == {}


@pytest.mark.parametrize(("dim0_type", "expected"), RENAMES)
def test_wire_type_applies_renames(dim0_type: NodeType, expected: str) -> None:
    """Dim0 enum values that differ from canvas-harness built-ins get translated.

    Without these renames, peers receive a node.add with a `type` string
    canvas-harness has no renderer for; the node enters the store but
    paints nothing — the "invisible rectangle" symptom that gave us the
    bug report.
    """
    note = _note_with_style_type(dim0_type)
    wire = note_to_wire_node(note)
    assert wire["type"] == expected


@pytest.mark.parametrize(("dim0_type", "expected"), IDENTITY)
def test_wire_type_passes_through_built_ins_and_custom_defs(
    dim0_type: NodeType, expected: str,
) -> None:
    """Dim0 enum values where the canvas-harness name matches verbatim."""
    note = _note_with_style_type(dim0_type)
    wire = note_to_wire_node(note)
    assert wire["type"] == expected


def test_map_covers_every_dim0_node_type() -> None:
    """`_DIM0_TO_CANVAS_TYPE` is exhaustive over the Dim0 NodeType enum.

    A missing entry would silently fall through `_canvas_type_for` and
    render as an unregistered custom type on peers — exactly the bug we
    just fixed. This lock prevents that recurring when new shapes land.
    """
    enum_values = {nt.value for nt in NodeType}
    assert set(_DIM0_TO_CANVAS_TYPE.keys()) == enum_values


def test_inverse_map_round_trips() -> None:
    """Every canvas-harness value maps back to its Dim0 enum value.

    Auto-generated from `_DIM0_TO_CANVAS_TYPE`, so the only way this can
    fail is if the forward map has duplicate values (which would collapse
    two Dim0 types onto one canvas type — a bug).
    """
    for dim0, canvas in _DIM0_TO_CANVAS_TYPE.items():
        assert _CANVAS_TO_DIM0_TYPE[canvas] == dim0


def test_document_takes_precedence_over_style_type() -> None:
    """`Note.type == "document"` ships wire `type="document"` regardless of style.type.

    Documents are a different Dim0 subclass (separate from the NodeType
    enum); the canvas-harness side has a `defineNode("document")`
    registration that the wire targets via this short-circuit.
    """
    doc = Document(id="n1", graph_uid="b1", style=Style(type=NodeType.RECTANGLE))
    wire = note_to_wire_node(doc)
    assert wire["type"] == "document"


# ---------------------------------------------------------------------------
# Snake ↔ camel case helpers
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("snake", "camel"),
    [
        ("stroke_color", "strokeColor"),
        ("stroke_width", "strokeWidth"),
        ("background_color", "backgroundColor"),
        ("font_family", "fontFamily"),
        ("source_arrowhead", "sourceArrowhead"),
        ("opacity", "opacity"),  # single word — identity
        ("text", "text"),
    ],
)
def test_snake_to_camel_round_trip(snake: str, camel: str) -> None:
    """`_snake_to_camel` matches the closed-set Dim0 ↔ canvas-harness vocabulary."""
    assert _snake_to_camel(snake) == camel
    assert _camel_to_snake(camel) == snake


# ---------------------------------------------------------------------------
# Node style on the wire — Dim0 snake_case → canvas-harness camelCase
# ---------------------------------------------------------------------------

def test_wire_style_is_camel_case_with_dim0_values() -> None:
    """All Dim0 LinkStyle fields appear on the wire under their camelCase keys.

    Without this translation, canvas-harness reads `style.strokeColor` →
    undefined → theme default, which is what produced the "peer sees a
    generic blue rectangle instead of the agent's intended palette" bug.
    """
    note = Note(
        id="n1", graph_uid="b1",
        style=Style(
            type=NodeType.RECTANGLE,
            stroke_color="#222222",
            stroke_width=4,
            stroke_style=StrokeStyle.DASHED,
            background_color="#ffeebb",
            roughness=0.3,
            roundness=2.0,
            opacity=80,
            text_color="#0a0a0a",
        ),
    )

    wire = note_to_wire_node(note)
    style = wire["style"]

    assert style["strokeColor"] == "#222222"
    assert style["strokeWidth"] == 4
    assert style["strokeStyle"] == "dashed"
    assert style["backgroundColor"] == "#ffeebb"
    assert style["roughness"] == 0.3
    assert style["roundness"] == 2.0
    assert style["opacity"] == 80
    assert style["textColor"] == "#0a0a0a"
    # Lifted / dropped fields never appear in the wire style.
    assert "type" not in style
    assert "angle" not in style
    assert "fillStyle" not in style
    assert "fill_style" not in style
    assert "groupIds" not in style
    assert "group_ids" not in style


def test_wire_node_ships_stored_colors_for_theme_adaptation() -> None:
    """Canonical colors land on `data._storedColors` so peers can re-adapt.

    Mirrors the edge-side `_storedColors` convention — receiver projects
    these through `adaptNodeColors` for its local theme. Without this
    field, dark-mode peers would render the originator's light-mode
    palette as-is (white-on-white or black-on-black, depending on the
    pick).
    """
    note = Note(
        id="n1", graph_uid="b1",
        style=Style(
            type=NodeType.RECTANGLE,
            stroke_color="#000",
            background_color="#fff",
            text_color="#123",
        ),
    )
    wire = note_to_wire_node(note)
    assert wire["data"]["_storedColors"] == {
        "strokeColor": "#000",
        "backgroundColor": "#fff",
        "textColor": "#123",
    }


def test_wire_node_lifts_group_ids_onto_node_groups() -> None:
    """`style.group_ids` is lifted onto `Node.groups` per canvas-harness model."""
    note = Note(
        id="n1", graph_uid="b1",
        style=Style(type=NodeType.RECTANGLE, group_ids=["g1", "g2"]),
    )
    wire = note_to_wire_node(note)
    assert wire["groups"] == ["g1", "g2"]


# ---------------------------------------------------------------------------
# Height auto-fit must be disabled for preview-rendered custom types
# ---------------------------------------------------------------------------

# Custom canvas types whose lib grow-to-fit must be off on the wire — they
# render only a preview of `node.content`, so auto-fit would snap the node
# tall enough for the unseen full body, uncapped. Mirrors the frontend's
# `AUTOFIT_DISABLED_TYPES` in convert/note-to-node.ts.
AUTOFIT_DISABLED = [
    NodeType.FOLDER,
    NodeType.SHEET,
    NodeType.CODE_SANDBOX,
    NodeType.WIDGET,
    NodeType.MINI_APP,
    NodeType.APPLET,
]


@pytest.mark.parametrize("dim0_type", AUTOFIT_DISABLED)
def test_wire_disables_autofit_for_preview_types(dim0_type: NodeType) -> None:
    """Sheet/code-sandbox/widget/mini-app/applet/folder ship `style.autoFit = False`.

    Without it, an agent-created sheet reaches peers with autoFit unset
    (defaults on in the lib) and the node auto-grows to fit the entire
    markdown body with no cap — the runaway-tall-sheet bug.
    """
    note = _note_with_style_type(dim0_type)
    wire = note_to_wire_node(note)
    assert wire["style"]["autoFit"] is False


def test_wire_disables_autofit_for_documents() -> None:
    """Documents (separate subclass) also ship `style.autoFit = False`."""
    doc = Document(id="n1", graph_uid="b1", style=Style(type=NodeType.RECTANGLE))
    wire = note_to_wire_node(doc)
    assert wire["style"]["autoFit"] is False


def test_wire_leaves_autofit_unset_for_plain_shapes() -> None:
    """Built-in primitives keep the lib default (auto-fit on) — no `autoFit` key."""
    note = _note_with_style_type(NodeType.RECTANGLE)
    wire = note_to_wire_node(note)
    assert "autoFit" not in wire["style"]


def test_unknown_style_type_passes_through_unchanged() -> None:
    """A future Dim0 enum value not yet in the map renders as a custom type.

    Falling through (rather than erroring) lets a new shape land without
    a wire-side rebuild — peers won't render it until both sides know
    about it, but nothing crashes.
    """
    # Bypass the NodeType enum since we want to test the unknown-string
    # path; construct the Style with `model_validate` to skip the
    # pydantic enum check.
    note = Note(id="n1", graph_uid="b1")
    note.style.type = "future-shape"  # type: ignore[assignment]
    wire = note_to_wire_node(note)
    assert wire["type"] == "future-shape"
