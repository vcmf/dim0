"""Classes representing the style of a node in a graph."""

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel

from topix.utils.colors import BLUE_200


class NodeType(StrEnum):
    """Enumeration for node types."""

    RECTANGLE = "rectangle"
    FOLDER = "folder"
    ELLIPSE = "ellipse"
    DIAMOND = "diamond"
    SHEET = "sheet"
    TEXT = "text"
    IMAGE = "image"
    ICON = "icon"
    LAYERED_RECTANGLE = "layered-rectangle"
    THOUGHT_CLOUD = "thought-cloud"
    CAPSULE = "capsule"
    LAYERED_DIAMOND = "layered-diamond"
    SOFT_DIAMOND = "soft-diamond"
    LAYERED_CIRCLE = "layered-circle"
    TAG = "tag"
    SLIDE = "slide"
    CODE_SANDBOX = "code-sandbox"
    WIDGET = "widget"
    MINI_APP = "mini-app"
    INK = "ink"


class StrokeStyle(StrEnum):
    """Enumeration for stroke styles."""

    SOLID = "solid"
    DASHED = "dashed"
    DOTTED = "dotted"


class FillStyle(StrEnum):
    """Enumeration for fill styles."""

    SOLID = "solid"
    HACHURE = "hachure"
    CROSSHATCH = "cross-hatch"
    ZIGZAG = "zigzag"
    DOTS = "dots"


class TextAlign(StrEnum):
    """Enumeration for text alignment."""

    LEFT = "left"
    CENTER = "center"
    RIGHT = "right"


class FontSize(StrEnum):
    """Enumeration for font sizes."""

    S = "S"
    M = "M"
    L = "L"
    XL = "XL"


class FontFamily(StrEnum):
    """Enumeration for font families."""

    HANDWRITING = "handwriting"
    SANS_SERIF = "sans-serif"
    SERIF = "serif"
    MONOSPACE = "monospace"
    INFORMAL = "informal"


class Style(BaseModel):
    """Style of a node in a graph.

    Attributes:
        type (str): Type of the node, default is "rectangle".
        angle (float): Rotation angle of the node in degrees.
        stroke_color (str): Color of the node's border.
        background_color (str): Background color of the node.
        fill_style (str): Fill style of the node, e.g., "solid"
        stroke_width (int): Width of the node's border.
        stroke_style (str): Style of the node's border, can be "solid" or "dashed".
        roughness (float): Roughness of the node, between 0 and 2.
        roundness (float): Roundness of the node's corners. 0 = sharp;
            1 = subtle (used by code-sandbox / widget); 3 = fully rounded
            (the user-facing "Rounded" toggle).
        opacity (int): Opacity of the node, default is 100%.
        group_ids (list[str]): List of group IDs this node belongs to.
        font_family (str): Font family used for text in the node.
        text_align (str): Text alignment within the node,
            can be "left", "center", or "right".
        color (str | None): Text color, if applicable.

    """

    # Defaults aligned with frontend createDefaultStyle() for rectangle nodes:
    # sharp corners (roundness 0) and the paper-adapted blue-200 fill.
    type: NodeType = NodeType.RECTANGLE
    angle: float = 0.0
    stroke_color: str = "#00000000"
    stroke_width: float = 2
    stroke_style: StrokeStyle = StrokeStyle.SOLID
    background_color: str = BLUE_200
    fill_style: FillStyle = FillStyle.SOLID
    roughness: float = 0.5
    roundness: float = 0.0
    opacity: float = 100
    group_ids: list[str] = []
    font_size: FontSize = FontSize.M
    font_family: FontFamily = FontFamily.HANDWRITING
    text_align: TextAlign = TextAlign.CENTER
    text_color: str = "#000000"
    text_style: str | None = "normal"


class Arrowhead(StrEnum):
    """Enumeration for arrowhead types."""

    ARROW = "arrow"
    BARB = "barb"
    ARROW_FILLED = "arrow-filled"
    NONE = "none"


class PathStyle(StrEnum):
    """Enumeration for path styles."""

    BEZIER = "bezier"
    STRAIGHT = "straight"
    POLYLINE = "polyline"


class LinkStyle(Style):
    """Style for links in a graph."""

    type: Literal["arrow"] = "arrow"

    # Defaults aligned with frontend createDefaultLinkStyle()
    stroke_color: str = "#292524"
    stroke_width: float = 2
    stroke_style: StrokeStyle = StrokeStyle.SOLID
    background_color: str = "#00000000"
    fill_style: FillStyle = FillStyle.SOLID
    roughness: float = 1
    roundness: float = 0
    opacity: float = 100
    group_ids: list[str] = []
    font_family: FontFamily = FontFamily.HANDWRITING
    font_size: FontSize = FontSize.M
    text_align: TextAlign = TextAlign.CENTER
    text_color: str = "#000000"
    text_style: str | None = "normal"

    source_arrowhead: Arrowhead = Arrowhead.NONE
    target_arrowhead: Arrowhead = Arrowhead.ARROW_FILLED

    path_style: PathStyle = PathStyle.BEZIER
