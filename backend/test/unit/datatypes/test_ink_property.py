"""Ink stroke persistence: InkProperty shape + Note ↔ wire round-trip.

An ink node stores its geometry (canvas-harness `InkStrokeData`) at the wire
`node.data.ink`, camelCase inner keys and all. These tests pin the two crossings
that made ink drop before: the property must validate that camelCase blob, and
the collab converters must carry it Note ⇄ wire without losing the points.
"""

from topix.collab.apply_ops import _wire_node_to_note
from topix.collab.note_to_wire import note_to_wire_node
from topix.datatypes.note.note import Note, NoteProperties
from topix.datatypes.note.style import NodeType, Style
from topix.datatypes.property import InkProperty, PropertyType

# The camelCase geometry blob as it rides on the wire (node.data.ink).
WIRE_INK = {
    "type": "ink",
    "version": 1,
    "size": 6,
    "points": [[0.0, 0.0, 0.4], [12.0, 8.0, 0.7], [30.0, 20.0, 0.55]],
    "intrinsicWidth": 30.0,
    "intrinsicHeight": 20.0,
    "thinning": 0.68,
}


def test_ink_property_validates_camelcase_wire_blob() -> None:
    """InkProperty accepts the engine's camelCase keys via field aliases."""
    ink = InkProperty.model_validate(WIRE_INK)
    assert ink.type is PropertyType.INK
    assert ink.intrinsic_width == 30.0
    assert ink.intrinsic_height == 20.0
    assert ink.points[1] == (12.0, 8.0, 0.7)


def test_ink_property_dumps_back_to_camelcase() -> None:
    """by_alias dump reproduces the shape the client renderer expects."""
    dumped = InkProperty.model_validate(WIRE_INK).model_dump(
        by_alias=True, exclude_none=True,
    )
    assert dumped["intrinsicWidth"] == 30.0
    assert dumped["intrinsicHeight"] == 20.0
    assert "intrinsic_width" not in dumped


def test_note_with_ink_validates() -> None:
    """A Note carrying style.type='ink' + ink_data validates (enum + property)."""
    note = Note(
        id="n1",
        graph_uid="b1",
        style=Style(type=NodeType.INK),
        properties=NoteProperties(ink_data=InkProperty.model_validate(WIRE_INK)),
    )
    assert note.style.type is NodeType.INK
    assert note.properties.ink_data is not None
    assert note.properties.ink_data.points[0] == (0.0, 0.0, 0.4)


def test_wire_node_to_note_persists_ink() -> None:
    """A drawn-stroke node.add lifts data.ink onto the Note's ink_data."""
    wire_node = {
        "id": "n1",
        "type": "ink",
        "data": {"styleType": "ink", "ink": WIRE_INK},
    }
    note = _wire_node_to_note(wire_node, board_id="b1")
    assert note is not None
    assert note.style.type is NodeType.INK
    assert note.properties.ink_data is not None
    assert note.properties.ink_data.intrinsic_width == 30.0
    assert len(note.properties.ink_data.points) == 3


def test_wire_node_to_note_persists_ink_stroke_color() -> None:
    """The pen color survives the collab persist, carried by data._storedColors.

    Regression: apply_ops treats style.strokeColor/backgroundColor as theme
    display values and only persists the canonical ones from _storedColors. Ink
    is engine-created (bypasses the client noteToNode that stamps _storedColors),
    so without it the color is dropped → the Note style defaults to a transparent
    stroke → a reloaded stroke paints invisibly and the minimap shows a box.
    """
    wire_node = {
        "id": "n1",
        "type": "ink",
        "style": {"strokeColor": "#1f2937", "backgroundColor": "transparent"},
        "data": {
            "styleType": "ink",
            "ink": WIRE_INK,
            "_storedColors": {"strokeColor": "#1f2937", "backgroundColor": "transparent"},
        },
    }
    note = _wire_node_to_note(wire_node, board_id="b1")
    assert note is not None
    # The pen color persists (NOT the model's transparent #00000000 default).
    assert note.style.stroke_color == "#1f2937"
    assert note.style.background_color == "transparent"
    assert note.properties.ink_data is not None


def test_wire_node_to_note_ink_without_stored_colors_loses_color() -> None:
    """Documents the failure mode: no _storedColors → color falls to the default.

    This is exactly the shipped bug; the fix is the client always sending
    _storedColors on ink (see test above), not a server change.
    """
    wire_node = {
        "id": "n1",
        "type": "ink",
        "style": {"strokeColor": "#1f2937"},
        "data": {"styleType": "ink", "ink": WIRE_INK},
    }
    note = _wire_node_to_note(wire_node, board_id="b1")
    assert note is not None
    # No _storedColors → the wire strokeColor is skipped → transparent default.
    assert note.style.stroke_color == "#00000000"


def test_note_to_wire_lifts_ink_to_data_ink() -> None:
    """note_to_wire_node emits camelCase data.ink and drops the snake echo."""
    note = Note(
        id="n1",
        graph_uid="b1",
        style=Style(type=NodeType.INK),
        properties=NoteProperties(ink_data=InkProperty.model_validate(WIRE_INK)),
    )
    wire = note_to_wire_node(note)
    assert wire["type"] == "ink"
    assert wire["data"]["ink"]["intrinsicWidth"] == 30.0
    assert wire["data"]["ink"]["points"][1] == [12.0, 8.0, 0.7]
    # Geometry ships once, at data.ink — not echoed in data.properties.
    assert "ink_data" not in wire["data"].get("properties", {})
    # No stray Property.id leaks in — data.ink stays exact InkStrokeData.
    assert "id" not in wire["data"]["ink"]
    # Ink autoFit is disabled so the empty-content node isn't collapsed.
    assert wire["style"]["autoFit"] is False


def test_ink_property_dump_has_no_id() -> None:
    """InkProperty never mints or serializes the base Property.id."""
    ink = InkProperty.model_validate(WIRE_INK)
    assert ink.id is None
    assert "id" not in ink.model_dump(by_alias=True, exclude_none=True, mode="json")


def test_wire_node_to_note_ignores_stray_ink_on_non_ink_node() -> None:
    """A non-ink node carrying a stray data.ink must not persist ink_data."""
    wire_node = {
        "id": "n1",
        "type": "rect",
        "data": {"styleType": "rectangle", "ink": WIRE_INK},
    }
    note = _wire_node_to_note(wire_node, board_id="b1")
    assert note is not None
    assert note.properties.ink_data is None


def test_wire_note_wire_round_trip_preserves_geometry() -> None:
    """Wire → Note → wire keeps the stroke byte-for-byte."""
    wire_node = {"id": "n1", "type": "ink", "data": {"styleType": "ink", "ink": WIRE_INK}}
    note = _wire_node_to_note(wire_node, board_id="b1")
    assert note is not None
    back = note_to_wire_node(note)
    assert back["data"]["ink"]["points"] == WIRE_INK["points"]
    assert back["data"]["ink"]["intrinsicWidth"] == WIRE_INK["intrinsicWidth"]
    assert back["data"]["ink"]["size"] == WIRE_INK["size"]
