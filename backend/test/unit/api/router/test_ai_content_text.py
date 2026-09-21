"""Unit tests for `_content_text` — the classifier-input flattener in ai.py.

Ensures multimodal (content-parts) messages don't dump base64 image data into the
`auto` complexity classifier: only `text` parts survive.
"""

from topix.api.router.ai import _content_text


def test_plain_string_passthrough():
    """A plain string passes through unchanged."""
    assert _content_text("hello") == "hello"


def test_none_and_non_text_become_empty():
    """None or a non-string/list value flattens to an empty string."""
    assert _content_text(None) == ""
    assert _content_text(123) == ""


def test_content_parts_keep_only_text():
    """Only text parts survive; an image part's data URL is dropped."""
    content = [
        {"type": "text", "text": "what is this?"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAABBBBCCCC"}},
    ]
    out = _content_text(content)
    assert "what is this?" in out
    assert "base64" not in out
    assert "AAAABBBBCCCC" not in out


def test_multiple_text_parts_joined():
    """Multiple text parts join with a single space."""
    content = [
        {"type": "text", "text": "a"},
        {"type": "text", "text": "b"},
    ]
    assert _content_text(content) == "a b"


def test_null_text_value_does_not_stringify_to_none():
    """A text part whose value is null contributes nothing, not the literal 'None'."""
    content = [{"type": "text", "text": None}, {"type": "text", "text": "real"}]
    out = _content_text(content)
    assert "None" not in out
    assert out.strip() == "real"
