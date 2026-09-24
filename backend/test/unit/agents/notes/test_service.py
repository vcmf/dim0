"""Tests for default note style construction (webui createDefaultStyle parity)."""

from __future__ import annotations

import pytest

from topix.agents.notes.service import build_default_note_style, build_note, get_default_note_size
from topix.datatypes.note.style import FontFamily, FontSize, NodeType, Style
from topix.utils.colors import BLUE_200, TAILWIND_200_ADAPTED
from topix.utils.graph.text_measure import estimate_node_size

_TRANSPARENT = "#00000000"

# Built-in shapes that should be sharp-cornered and filled from the adapted
# Tailwind-200 palette, matching the frontend.
_SHARP_SHAPES = [
    NodeType.RECTANGLE,
    NodeType.LAYERED_RECTANGLE,
    NodeType.ELLIPSE,
    NodeType.LAYERED_CIRCLE,
    NodeType.DIAMOND,
    NodeType.SOFT_DIAMOND,
    NodeType.LAYERED_DIAMOND,
    NodeType.CAPSULE,
    NodeType.TAG,
    NodeType.THOUGHT_CLOUD,
]


def test_style_class_defaults_match_frontend_rectangle():
    """The bare Style default is the frontend rectangle: sharp + adapted blue."""
    style = Style()
    assert style.roundness == 0.0
    assert style.background_color == BLUE_200


@pytest.mark.parametrize("note_type", _SHARP_SHAPES)
def test_builtin_shapes_are_sharp_and_palette_filled(note_type):
    """Built-in shapes get roundness 0 and a fill from the adapted palette."""
    style = build_default_note_style(note_type)
    assert style.roundness == 0
    assert style.background_color in TAILWIND_200_ADAPTED


def test_text_is_transparent_and_sharp():
    """Text notes are transparent with no rounding."""
    style = build_default_note_style(NodeType.TEXT)
    assert style.background_color == _TRANSPARENT
    assert style.roundness == 0


def test_sheet_is_sharp_and_flat():
    """Sheets are sharp-cornered and flat (roughness 0)."""
    style = build_default_note_style(NodeType.SHEET)
    assert style.roundness == 0
    assert style.roughness == 0


@pytest.mark.parametrize(
    ("note_type", "expected_roundness"),
    [
        (NodeType.SLIDE, 2),
        (NodeType.CODE_SANDBOX, 1),
        (NodeType.WIDGET, 1),
        (NodeType.APPLET, 1),
    ],
)
def test_custom_nodes_keep_their_roundness(note_type, expected_roundness):
    """Custom nodes override the shape default with their own roundness."""
    assert build_default_note_style(note_type).roundness == expected_roundness


def test_code_sandbox_and_widget_use_rose_pine_fill():
    """Code/widget cards keep their bespoke rose-pine background, not the palette."""
    for note_type in (NodeType.CODE_SANDBOX, NodeType.WIDGET, NodeType.APPLET):
        assert build_default_note_style(note_type).background_color == "#faf4ed"


def test_applet_style_matches_frontend_card():
    """Applets mirror webui `createDefaultStyle`: sans-serif S, borderless, flat."""
    style = build_default_note_style(NodeType.APPLET)
    assert style.font_family == FontFamily.SANS_SERIF
    assert style.font_size == FontSize.S
    assert style.stroke_color == _TRANSPARENT
    assert style.roughness == 0


def test_applet_default_size_matches_frontend():
    """Applets default to 720x440 (DEFAULT_APPLET_* in webui note.ts), not the rectangle stub."""
    assert get_default_note_size(NodeType.APPLET) == (720, 440)


# --- build_note content-fit sizing ------------------------------------------


class _EmptyGraphStore:
    """Minimal GraphStore stand-in: an empty board (no siblings)."""

    async def get_graph(self, *_args, **_kwargs):
        return None


async def _build(content: str, note_type: NodeType = NodeType.RECTANGLE):
    return await build_note(
        graph_store=_EmptyGraphStore(),
        graph_uid="g1",
        label=None,
        content=content,
        note_type=note_type,
        parent_id=None,
    )


async def test_build_note_fits_box_to_content():
    """A rectangle's box matches the shape-aware content estimate, not the default."""
    content = "The quick brown fox jumps over the lazy dog and keeps running past the meadow"
    note = await _build(content)
    default_w, default_h = get_default_note_size(NodeType.RECTANGLE)
    exp_w, exp_h = estimate_node_size(NodeType.RECTANGLE, default_w, content, note.style.font_size)
    size = note.properties.node_size.size
    assert (size.width, size.height) == (exp_w, exp_h)
    assert exp_h != default_h  # actually content-driven, not the stub default


async def test_build_note_short_label_shrinks_width_and_height():
    """Fit-exact: a one-word rectangle shrinks in both dimensions below the default."""
    note = await _build("Hi")
    default_w, default_h = get_default_note_size(NodeType.RECTANGLE)
    size = note.properties.node_size.size
    assert size.width < default_w
    assert size.height < default_h


async def test_build_note_long_single_line_clamps_width_to_default():
    """A long unbroken line can't grow past the type's default (max) width."""
    note = await _build("word " * 200)
    default_w, _ = get_default_note_size(NodeType.RECTANGLE)
    assert note.properties.node_size.size.width == default_w


async def test_build_note_diamond_stays_squareish():
    """A short-label diamond keeps a square-ish aspect, not a flat sliver."""
    note = await _build("Decision point", NodeType.DIAMOND)
    size = note.properties.node_size.size
    assert size.height >= size.width  # min-aspect floor (square)


async def test_build_note_sheet_keeps_default_size():
    """Sheets are long-form docs: kept at the full default size, never content-fit."""
    default_w, default_h = get_default_note_size(NodeType.SHEET)
    note = await _build("a short heading", NodeType.SHEET)
    assert note.properties.node_size.size.width == default_w
    assert note.properties.node_size.size.height == default_h


async def test_build_note_empty_content_keeps_default_size():
    """Empty content has nothing to measure, so the default size is kept."""
    note = await _build("")
    width, height = get_default_note_size(NodeType.RECTANGLE)
    assert note.properties.node_size.size.width == width
    assert note.properties.node_size.size.height == height


async def test_build_note_non_content_type_keeps_default_size():
    """Preview types (e.g. slide) are not content-sized; default height stands."""
    note = await _build("lots of text " * 50, NodeType.SLIDE)
    width, height = get_default_note_size(NodeType.SLIDE)
    assert note.properties.node_size.size.height == height
