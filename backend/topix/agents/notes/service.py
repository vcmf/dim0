"""Helpers for board-scoped note creation tools."""

from __future__ import annotations

import random

from topix.datatypes.note.note import Note
from topix.datatypes.note.style import FontFamily, FontSize, NodeType, StrokeStyle, Style, TextAlign
from topix.datatypes.property import PositionProperty, SizeProperty
from topix.datatypes.resource import RichText
from topix.store.graph import GraphStore
from topix.utils.colors import TAILWIND_200_ADAPTED
from topix.utils.graph.text_measure import estimate_node_size

DEFAULT_NOTE_GAP = 80
DEFAULT_CHILD_OFFSET_X = 40
DEFAULT_CHILD_OFFSET_Y = 80
SHEET_MIN_WIDTH = 200
SHEET_MIN_HEIGHT = 120


def build_default_note_style(note_type: NodeType) -> Style:
    """Return the backend default style for a given note type.

    Mirrors webui `createDefaultStyle`: built-in shapes are sharp-cornered
    (roundness 0) and filled with a random paper-adapted Tailwind-200 swatch —
    the same palette the canvas renders (see :mod:`topix.utils.colors`). Custom
    nodes (sheet / code-sandbox / widget / slide) keep their bespoke styling.
    """
    style = Style(type=note_type)
    style.background_color = random.choice(TAILWIND_200_ADAPTED)
    # Built-in shapes default to sharp corners; the Style class default (3.0)
    # is for legacy rows. Custom nodes override below.
    style.roundness = 0

    if note_type == NodeType.SHEET:
        style.roughness = 0
        style.text_align = TextAlign.LEFT
    elif note_type == NodeType.TEXT:
        style.background_color = "#00000000"
        style.text_align = TextAlign.LEFT
    elif note_type == NodeType.SLIDE:
        style.background_color = "#00000000"
        style.stroke_style = StrokeStyle.DASHED
        style.font_family = FontFamily.SANS_SERIF
        style.roundness = 2
    elif note_type == NodeType.CODE_SANDBOX:
        style.background_color = "#faf4ed"
        style.text_color = "#575279"
        style.font_family = FontFamily.MONOSPACE
        style.text_align = TextAlign.LEFT
        style.roughness = 0
        style.roundness = 1
        style.stroke_color = "#00000000"
    elif note_type == NodeType.WIDGET:
        style.background_color = "#faf4ed"
        style.text_color = "#575279"
        style.text_align = TextAlign.LEFT
        style.roughness = 0
        style.roundness = 1
        style.stroke_color = "#00000000"
    elif note_type == NodeType.APPLET:
        # Mirrors the webui `createDefaultStyle` applet case (rose-pine card).
        style.background_color = "#faf4ed"
        style.font_family = FontFamily.SANS_SERIF
        style.font_size = FontSize.S
        style.text_align = TextAlign.LEFT
        style.roughness = 0
        style.roundness = 1
        style.stroke_color = "#00000000"

    return style


def get_default_note_size(note_type: NodeType) -> tuple[int, int]:  # noqa: C901
    """Return the default (width, height) for a freshly-created note of `note_type`.

    Mirrors the frontend constants in webui/src/features/board/types/note.ts.
    Keep both files in sync — the frontend handles canvas-toolbar creates,
    this function handles agent-side `write_note` creates. A drift between
    them means agent-created notes land at different sizes than user-
    created ones.
    """
    if note_type == NodeType.SHEET:
        # Square "sticky note" default — a sheet is a long-form rich-text doc
        # that scrolls, so a square jot surface reads better than a wide card.
        # Sheets are exempt from content sizing, so this is the size they keep.
        # Keep in sync with DEFAULT_SHEET_* in webui note.ts.
        return 440, 440
    if note_type == NodeType.TEXT:
        return 300, 20
    if note_type == NodeType.SLIDE:
        return 960, 540
    if note_type == NodeType.FOLDER:
        return 150, 150
    if note_type == NodeType.CODE_SANDBOX:
        # Code-friendly rectangle — ~75 chars/line at typical monospace,
        # close to the 80-char convention. Like sheet, code-sandbox is a
        # scrolling fixed-surface node (overflow handles long content), so
        # it's exempt from content-fit sizing in CONTENT_SIZED_TYPES.
        # Keep in sync with DEFAULT_CODE_SANDBOX_* in webui note.ts.
        return 560, 360
    if note_type == NodeType.WIDGET:
        return 800, 500
    if note_type in {NodeType.MINI_APP, NodeType.APPLET}:
        # Keep in sync with DEFAULT_MINI_APP_* / DEFAULT_APPLET_* in webui note.ts.
        # Tablet-portrait proportions; paired with the 1200px auto-grow
        # cap in webui's MiniAppView, a max-grown card reads at 1:1.67
        # instead of a thin column.
        return 720, 440
    if note_type == NodeType.ELLIPSE:
        return 320, 320
    if note_type == NodeType.LAYERED_CIRCLE:
        return 320, 320
    if note_type in {NodeType.DIAMOND, NodeType.SOFT_DIAMOND, NodeType.LAYERED_DIAMOND}:
        return 340, 340
    if note_type == NodeType.RECTANGLE:
        return 320, 180
    return 320, 180


async def compute_note_position(
    graph_store: GraphStore,
    graph_uid: str,
    parent_id: str | None,
) -> PositionProperty.Position:
    """Choose a simple non-overlapping position for a newly created note."""
    siblings_graph = await graph_store.get_graph(graph_uid, root_id=parent_id) if parent_id else await graph_store.get_graph(graph_uid)
    siblings = [
        note
        for note in (siblings_graph.nodes if siblings_graph else [])
        if note.deleted_at is None
    ]

    if siblings:
        anchor_x = min(note.properties.node_position.position.x for note in siblings)
        max_y = max(
            note.properties.node_position.position.y + note.properties.node_size.size.height
            for note in siblings
        )
        return PositionProperty.Position(x=anchor_x, y=max_y + DEFAULT_NOTE_GAP)

    if parent_id:
        parents = await graph_store.get_nodes([parent_id])
        if parents:
            parent = parents[0]
            parent_position = parent.properties.node_position.position
            parent_size = parent.properties.node_size.size
            return PositionProperty.Position(
                x=parent_position.x + DEFAULT_CHILD_OFFSET_X,
                y=parent_position.y + parent_size.height + DEFAULT_CHILD_OFFSET_Y,
            )

    return PositionProperty.Position(x=0, y=0)


async def build_note(
    graph_store: GraphStore,
    graph_uid: str,
    label: str | None,
    content: str,
    note_type: NodeType,
    parent_id: str | None,
) -> Note:
    """Build a new note with content-first defaults and automatic placement."""
    width, height = get_default_note_size(note_type)
    position = await compute_note_position(
        graph_store=graph_store,
        graph_uid=graph_uid,
        parent_id=parent_id,
    )

    note = Note(
        graph_uid=graph_uid,
        parent_id=parent_id,
        style=build_default_note_style(note_type),
        label=RichText(markdown=label) if label else None,
        content=RichText(markdown=content),
    )
    note.properties.node_position = PositionProperty(position=position)
    # Fit the box to the rendered markdown (shape-aware) so agent-created notes
    # aren't stuck at the stub default: shapes/text labels shrink toward their
    # content width, document types keep their reading width and fit height.
    # Empty content / non-content-sized types fall back to the default size.
    fitted = estimate_node_size(note_type, width, content or label, note.style.font_size)
    if fitted is not None:
        width, height = fitted
    note.properties.node_size = SizeProperty(
        size=SizeProperty.Size(width=width, height=height)
    )
    if note_type == NodeType.CODE_SANDBOX:
        note.properties.programming_language.text = "python"
    return note
