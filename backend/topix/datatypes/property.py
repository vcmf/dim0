"""Property classes."""

from __future__ import annotations

import abc

from enum import IntEnum, StrEnum
from typing import Annotated, Literal, Type

from pydantic import BaseModel, ConfigDict, Field

from topix.agents.datatypes.annotations import SearchResult
from topix.agents.datatypes.reasoning_step import ReasoningStep
from topix.agents.datatypes.tool_call import ToolCall
from topix.datatypes.mime import MimeTypeEnum
from topix.utils.common import gen_uid


class PropertyType(StrEnum):
    """Property type enum."""

    NUMBER = "number"
    DATE = "date"
    BOOLEAN = "boolean"
    TEXT = "text"
    MULTI_TEXT = "multi_text"
    KEYWORD = "keyword"
    MULTI_KEYWORD = "multi_keyword"
    LOCATION = "location"
    POSITION = "position"
    SIZE = "size"
    ICON = "icon"
    IMAGE = "image"
    FILE = "file"
    URL = "url"
    REASONING = "reasoning"
    MULTI_SOURCE = "multi_source"
    INK = "ink"


class Property(abc.ABC, BaseModel):
    """Base class for all property types."""

    id: str = Field(default_factory=gen_uid)
    type: PropertyType


class NumberProperty(Property):
    """Property for numeric values."""

    type: Literal[PropertyType.NUMBER] = PropertyType.NUMBER
    number: int | float | None = None


class DateProperty(Property):
    """Property for date values."""

    type: Literal[PropertyType.DATE] = PropertyType.DATE
    date: str | None = None


class BooleanProperty(Property):
    """Property for boolean values."""

    type: Literal[PropertyType.BOOLEAN] = PropertyType.BOOLEAN
    boolean: bool | None = None


class TextProperty(Property):
    """Property for text values."""

    type: Literal[PropertyType.TEXT] = PropertyType.TEXT
    text: str | None = None
    searchable: bool | None = None


class IconProperty(Property):
    """Property for icon or emoji values."""

    class Icon(BaseModel):
        """Icon data model."""

        type: Literal['icon'] = 'icon'
        icon: str  # URL of the icon image

    class Emoji(BaseModel):
        """Emoji data model."""

        type: Literal['emoji'] = 'emoji'
        emoji: str

    class Phosphor(BaseModel):
        """Phosphor icon by name with an optional color tint.

        `color` stores either a hex like '#dc2626' (paper-adapted Tailwind
        palette) or a CSS variable reference like 'var(--color-foreground)'.
        The raw value is what reaches the wire — dark-mode adaptation is a
        render-time concern, never persisted.
        """

        type: Literal['phosphor'] = 'phosphor'
        name: str
        color: str | None = None

    type: Literal[PropertyType.ICON] = PropertyType.ICON
    icon: Icon | Emoji | Phosphor | None = None


class ImageProperty(Property):
    """Property for image values."""

    class Image(BaseModel):
        """Image data model."""

        url: str
        caption: str | None = None

    type: Literal[PropertyType.IMAGE] = PropertyType.IMAGE
    image: Image | None = None


class FileProperty(Property):
    """Property for file values."""

    class File(BaseModel):
        """File data model."""

        url: str
        name: str
        size: float | None = None
        mime_type: MimeTypeEnum | None = None

    type: Literal[PropertyType.FILE] = PropertyType.FILE
    file: File | None = None


class URLProperty(Property):
    """Property for URL values."""

    type: Literal[PropertyType.URL] = PropertyType.URL
    url: str | None = None


class MultiTextProperty(Property):
    """Property for multiple text values."""

    type: Literal[PropertyType.MULTI_TEXT] = PropertyType.MULTI_TEXT
    texts: list[str] = []  # list of str


class KeywordProperty(Property):
    """Property for keyword values."""

    type: Literal[PropertyType.KEYWORD] = PropertyType.KEYWORD
    value: int | str | None = None
    value_type: Type[IntEnum | StrEnum] | None = None


class MultiKeywordProperty(Property):
    """Property for multiple keyword values."""

    type: Literal[PropertyType.MULTI_KEYWORD] = PropertyType.MULTI_KEYWORD
    values: list[int | str] = []
    value_type: Type[IntEnum | StrEnum] | None = None


class LocationProperty(Property):
    """Property for location values."""

    class Location(BaseModel):
        """Location data model."""

        latitude: float
        longitude: float

    type: Literal[PropertyType.LOCATION] = PropertyType.LOCATION
    location: Location | None = None


class PositionProperty(Property):
    """Property for position values."""

    class Position(BaseModel):
        """Position data model."""

        x: float
        y: float

    type: Literal[PropertyType.POSITION] = PropertyType.POSITION
    position: Position | None = None
    # When the position belongs to an edge endpoint AND the link's
    # source/target resolves to an attached node, callers may interpret
    # `position` as a node-local offset (relative to the node's
    # top-left, pre-rotation) instead of an absolute world coordinate.
    # Default `False` keeps the legacy world-coord interpretation for
    # existing rows so no data migration is needed. Newer clients set
    # this to True when saving attached endpoints so edges that move
    # with their node don't require cascading updates.
    is_local_offset: bool = False


class SizeProperty(Property):
    """Property for size values."""

    class Size(BaseModel):
        """Size data model."""

        width: float
        height: float

    type: Literal[PropertyType.SIZE] = PropertyType.SIZE
    size: Size | None = None


class ReasoningProperty(Property):
    """Property for agent's reasoning steps."""

    type: Literal[PropertyType.REASONING] = PropertyType.REASONING
    reasoning: list[ToolCall | ReasoningStep] = []


class MultiSourceProperty(Property):
    """Property for multiple web source values."""

    type: Literal[PropertyType.MULTI_SOURCE] = PropertyType.MULTI_SOURCE
    sources: list[SearchResult] = []


class InkProperty(Property):
    """Pressure-aware freehand samples and their precomputed render outline."""

    model_config = ConfigDict(populate_by_name=True)

    type: Literal[PropertyType.INK] = PropertyType.INK
    version: Literal[1] = 1
    size: float
    points: list[tuple[float, float, float]]
    outline: list[tuple[float, float]]
    intrinsic_width: float = Field(alias="intrinsicWidth")
    intrinsic_height: float = Field(alias="intrinsicHeight")


type DataProperty = Annotated[
    (
        NumberProperty
        | DateProperty
        | BooleanProperty
        | TextProperty
        | IconProperty
        | ImageProperty
        | FileProperty
        | URLProperty
        | MultiTextProperty
        | KeywordProperty
        | MultiKeywordProperty
        | LocationProperty
        | PositionProperty
        | SizeProperty
        | ReasoningProperty
        | InkProperty
    ),
    Field(discriminator="type")
]
