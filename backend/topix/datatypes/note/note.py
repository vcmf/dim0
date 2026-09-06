"""Classes representing a note object with properties and content."""

from typing import Literal

from pydantic import Field

from topix.datatypes.note.style import Style
from topix.datatypes.property import (
    BooleanProperty,
    DataProperty,
    IconProperty,
    ImageProperty,
    InkProperty,
    NumberProperty,
    PositionProperty,
    SizeProperty,
    TextProperty,
    URLProperty,
)
from topix.datatypes.resource import Resource, ResourceProperties


class NoteProperties(ResourceProperties):
    """Note properties."""

    # need to repeat this for every subclass of ResourceProperties
    # otherwise pydantic gets confused
    __pydantic_extra__: dict[str, DataProperty] = Field(init=False)

    node_position: PositionProperty = Field(
        default_factory=lambda: PositionProperty(
            position=PositionProperty.Position(x=0, y=0)
        )
    )
    node_size: SizeProperty = Field(
        default_factory=lambda: SizeProperty(
            size=SizeProperty.Size(width=300, height=100)
        )
    )
    node_z_index: NumberProperty = Field(
        default_factory=lambda: NumberProperty(number=0)
    )
    # DEPRECATED: not read by any view; superseded by `icon_data`. Kept
    # to preserve wire compatibility for existing rows. Do not set new
    # values on this field — write to `icon_data` instead.
    emoji: IconProperty = Field(
        default_factory=lambda: IconProperty(
            icon=IconProperty.Emoji(emoji="")
        )
    )
    pinned: BooleanProperty = Field(
        default_factory=lambda: BooleanProperty(boolean=False)
    )
    list_order: NumberProperty = Field(
        default_factory=lambda: NumberProperty(number=0.0)
    )
    url: URLProperty = Field(
        default_factory=lambda: URLProperty()
    )
    image_url: ImageProperty = Field(
        default_factory=lambda: ImageProperty()
    )
    icon_data: IconProperty = Field(
        default_factory=lambda: IconProperty()
    )
    slide_name: TextProperty = Field(
        default_factory=lambda: TextProperty()
    )
    slide_number: NumberProperty = Field(
        default_factory=lambda: NumberProperty()
    )
    programming_language: TextProperty = Field(
        default_factory=lambda: TextProperty(text="python")
    )
    ink_data: InkProperty | None = None


class Note(Resource):
    """Note object."""

    type: Literal["note"] = "note"

    # properties
    properties: NoteProperties = Field(
        default_factory=NoteProperties
    )

    # graph attributes
    graph_uid: str | None = None
    parent_id: str | None = None
    style: Style = Field(default_factory=Style)
