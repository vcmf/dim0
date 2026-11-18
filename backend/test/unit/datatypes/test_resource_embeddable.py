"""Tests for `dict_to_embeddable` on note and document payloads (#359)."""

import pytest

from pydantic import ValidationError

from topix.datatypes.chat.chat import Message
from topix.datatypes.file.document import Document
from topix.datatypes.note.note import Note
from topix.datatypes.property import TextProperty
from topix.datatypes.resource import RichText, dict_to_embeddable


def test_embeds_note_dump_with_null_optional_property():
    """A full note dump carries `properties.ink_data: None`; it must still embed its label."""
    note = Note(label=RichText(markdown="after"))
    payload = note.model_dump(exclude_none=False)
    assert payload["properties"]["ink_data"] is None

    assert dict_to_embeddable(payload) == ["after"]


def test_note_payload_matches_model_embedding():
    """A full note dump embeds like `Note.to_embeddable()`, searchable text properties included."""
    note = Note(label=RichText(markdown="after"))
    note.properties.slide_name = TextProperty(text="intro slide", searchable=True)

    assert dict_to_embeddable(note.model_dump(exclude_none=False)) == ["after", "intro slide"]


def test_note_payload_honours_searchable_flags():
    """Non-searchable label and text properties stay out of the embedding."""
    note = Note(label=RichText(markdown="hidden", searchable=False), content=RichText(markdown="shown"))
    note.properties.slide_name = TextProperty(text="private", searchable=False)

    assert dict_to_embeddable(note.model_dump(exclude_none=False)) == ["shown"]


def test_partial_note_payload_embeds_its_fields():
    """A partial note update (label only) still embeds as before."""
    assert dict_to_embeddable({"type": "note", "id": "x", "label": {"markdown": "edited"}}) == ["edited"]


def test_rejects_invalid_note_values():
    """A note payload with an invalid value is still rejected."""
    with pytest.raises(ValidationError):
        dict_to_embeddable({"type": "note", "id": "x", "label": {"markdown": 1}})


def test_embeds_document_dump_with_null_optional_property():
    """Documents inherit the note's nullable `ink_data`; a full dump must embed (renaming a document)."""
    doc = Document(label=RichText(markdown="report.pdf"))
    payload = doc.model_dump(exclude_none=False)
    assert payload["properties"]["ink_data"] is None

    assert dict_to_embeddable(payload) == doc.to_embeddable()
    assert "report.pdf" in dict_to_embeddable(payload)


def test_partial_document_payload_embeds_its_fields():
    """A partial document update still embeds its provided label."""
    assert dict_to_embeddable({"type": "document", "id": "x", "label": {"markdown": "renamed"}}) == ["renamed"]


def test_other_types_keep_the_generic_path():
    """Non-note payloads are untouched: a message embeds generically and honours `searchable`."""
    message = Message(role="user", content=RichText(markdown="secret", searchable=False), chat_uid="c1")

    assert dict_to_embeddable(message.model_dump(exclude_none=False)) == []
