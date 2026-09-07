"""Convert text into a drawn diagram graph."""
from __future__ import annotations

from agents import ModelSettings

from topix.agents.base import BaseAgent
from topix.agents.datatypes.context import Context
from topix.agents.datatypes.drawn_graph import DrawnEdge, DrawnGraph, DrawnNode
from topix.agents.datatypes.model_enum import ModelEnum
from topix.datatypes.note.link import Link
from topix.datatypes.note.note import Note
from topix.datatypes.note.style import Arrowhead, FontFamily, FontSize, NodeType
from topix.datatypes.property import NumberProperty, PositionProperty, SizeProperty
from topix.datatypes.resource import RichText


class DrawifyAgent(BaseAgent):
    """Drawify Agent for generating a diagram graph."""

    def __init__(
        self,
        model: str = ModelEnum.OpenRouter.CLAUDE_OPUS,
        instructions_template: str = "drawify/drawify.system.jinja",
        model_settings: ModelSettings | None = None,
    ):
        """Init method."""
        name = "Drawify"
        instructions = self._render_prompt(instructions_template)
        if model_settings is None:
            model_settings = ModelSettings(temperature=0.01)

        super().__init__(
            name=name,
            model=model,
            model_settings=model_settings,
            instructions=instructions,
            output_type=DrawnGraph,
        )
        super().__post_init__()

    async def _input_formatter(self, context: Context, input: str) -> str:
        """Format the input for the drawify agent."""
        user_prompt = self._render_prompt(
            "drawify/drawify.user.jinja",
            input_text=input,
        )
        return user_prompt


def _font_size_from_label(size: str) -> FontSize:
    return FontSize.L if size == "lg" else FontSize.M


def _node_type_from_drawn(node_type: str) -> NodeType:
    if node_type == "ellipse":
        return NodeType.ELLIPSE
    if node_type == "diamond":
        return NodeType.DIAMOND
    if node_type == "text":
        return NodeType.TEXT
    return NodeType.RECTANGLE


def _roundness_from_drawn(rounded: bool) -> float:
    """Map drawify's binary `rounded` flag to a Dim0 roundness value.

    `3` matches the webui's "Rounded" picker (~12 px corner radius at
    canvas-harness's `roundness * 4` mapping). `0` keeps the corners
    sharp.
    """
    return 3 if rounded else 0


def _arrowhead_from_label(kind: str) -> Arrowhead:
    return Arrowhead.ARROW_FILLED if kind == "arrow" else Arrowhead.NONE


def _convert_drawn_node(node: DrawnNode, z_index: int) -> Note:
    """Convert a drawn node into a content-first board note."""
    note = Note(
        content=RichText(markdown=node.label) if node.label else None,
    )
    note.style.type = _node_type_from_drawn(node.type)
    note.style.font_size = _font_size_from_label(node.font_size)
    note.style.font_family = FontFamily.HANDWRITING
    note.style.roundness = _roundness_from_drawn(node.rounded)

    if node.background:
        note.style.background_color = node.background
    if node.border:
        note.style.stroke_color = node.border

    note.properties.node_position = PositionProperty(
        position=PositionProperty.Position(x=node.x, y=node.y)
    )
    note.properties.node_size = SizeProperty(
        size=SizeProperty.Size(width=node.width, height=node.height)
    )
    note.properties.node_z_index = NumberProperty(number=z_index)
    return note


def _convert_drawn_edge(edge: DrawnEdge, id_map: dict[str, str]) -> Link | None:
    if edge.source not in id_map or edge.target not in id_map:
        return None
    link = Link(
        source=id_map[edge.source],
        target=id_map[edge.target],
    )
    link.style.source_arrowhead = _arrowhead_from_label(edge.tail)
    link.style.target_arrowhead = _arrowhead_from_label(edge.head)
    link.style.font_family = FontFamily.HANDWRITING

    if edge.label:
        link.label = RichText(markdown=edge.label)
    return link


def convert_drawify_output_to_notes_links(output: DrawnGraph) -> tuple[list[Note], list[Link]]:
    """Convert DrawnGraph output to notes and links."""
    notes: list[Note] = []
    links: list[Link] = []
    id_map: dict[str, str] = {}

    for idx, node in enumerate(output.nodes):
        if node.id in id_map:
            continue
        note = _convert_drawn_node(node, idx)
        notes.append(note)
        id_map[node.id] = note.id

    for edge in output.edges:
        link = _convert_drawn_edge(edge, id_map)
        if link is not None:
            links.append(link)

    return notes, links
