"""Ink property round-trip coverage."""

from topix.collab.note_to_wire import note_to_wire_node
from topix.datatypes.note.note import Note
from topix.datatypes.note.style import NodeType


def test_ink_note_validates_and_serializes_to_wire() -> None:
    """Persisted freehand payloads survive Note validation and relay output."""
    note = Note.model_validate({
        "id": "00000000-0000-4000-8000-000000000001",
        "graph_uid": "board-1",
        "style": {"type": "ink", "stroke_color": "#123456"},
        "properties": {
            "node_position": {"type": "position", "position": {"x": 10, "y": 20}},
            "node_size": {"type": "size", "size": {"width": 30, "height": 40}},
            "ink_data": {
                "type": "ink",
                "version": 1,
                "size": 5,
                "points": [[0, 0, 0.2], [20, 20, 0.9]],
                "outline": [[0, 0], [20, 0], [20, 20]],
                "intrinsicWidth": 20,
                "intrinsicHeight": 20,
            },
        },
    })

    assert note.style.type == NodeType.INK
    assert note.properties.ink_data is not None
    assert note.properties.ink_data.intrinsic_width == 20

    wire = note_to_wire_node(note)
    assert wire["type"] == "ink"
    assert wire["data"]["styleType"] == NodeType.INK
    assert wire["data"]["properties"]["ink_data"]["outline"]
