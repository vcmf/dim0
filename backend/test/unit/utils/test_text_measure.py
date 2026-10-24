"""Tests for markdown height estimation used by post-turn auto-layout."""

from __future__ import annotations

import pytest

from topix.datatypes.note.style import FontSize, NodeType
from topix.utils.graph.text_measure import (
    CONTENT_HEIGHT_BUFFER,
    CONTENT_SIZED_TYPES,
    MAX_ESTIMATED_HEIGHT,
    MAX_FONT_SIZE_PX,
    MIN_FONT_SIZE_PX,
    NUMERIC_LINE_HEIGHT_RATIO,
    estimate_markdown_height,
    estimate_node_height,
)

# One short line at the default font size: a single 24px line plus the buffer.
_ONE_LINE_M = 24 + CONTENT_HEIGHT_BUFFER
_LONG_LINE = "The quick brown fox jumps over the lazy dog and keeps running past the meadow"


@pytest.mark.parametrize("content", ["", "   ", "\n\t\n", None])
def test_empty_content_is_zero(content):
    """Blank or missing content contributes no height."""
    assert estimate_markdown_height(content, 300) == 0.0


def test_single_short_line_is_one_line_plus_buffer():
    """A line that fits the width is exactly one line height plus the buffer."""
    assert estimate_markdown_height("hello world", 300) == _ONE_LINE_M


def test_wrapping_grows_height_as_width_shrinks():
    """The same text wraps to more lines (taller) at a narrower width."""
    wide = estimate_markdown_height(_LONG_LINE, 600)
    narrow = estimate_markdown_height(_LONG_LINE, 200)
    assert narrow > wide > _ONE_LINE_M


def test_hard_line_breaks_count_as_lines():
    """Each newline forces a new line even when each fits the width."""
    three = estimate_markdown_height("line one\nline two\nline three", 300)
    assert three == 3 * 24 + CONTENT_HEIGHT_BUFFER


def test_code_block_adds_vertical_margin():
    """A fenced block carries top+bottom margin beyond its prose lines."""
    plain = estimate_markdown_height("def f(x):\n    return x * x", 300)
    fenced = estimate_markdown_height("```python\ndef f(x):\n    return x * x\n```", 300)
    assert fenced > plain


def test_larger_font_is_taller():
    """A larger font size yields a taller single line."""
    small = estimate_markdown_height("hello", 300, FontSize.S)
    large = estimate_markdown_height("hello", 300, FontSize.XL)
    assert large > small


def test_numeric_font_size_is_supported():
    """An explicit pixel size is measured proportionally, beyond XL."""
    assert estimate_markdown_height("hello", 300, 72) == 90 + CONTENT_HEIGHT_BUFFER


def test_numeric_font_size_is_bounded():
    """Explicit sizes are clamped to the same safe range as canvas-harness."""
    assert (
        estimate_markdown_height("h", 300, 1)
        == MIN_FONT_SIZE_PX * NUMERIC_LINE_HEIGHT_RATIO + CONTENT_HEIGHT_BUFFER
    )
    assert (
        estimate_markdown_height("h", 300, 999)
        == MAX_FONT_SIZE_PX * NUMERIC_LINE_HEIGHT_RATIO + CONTENT_HEIGHT_BUFFER
    )


@pytest.mark.parametrize("font_size", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_font_size_falls_back_to_medium(font_size):
    """Non-finite sizes cannot propagate into layout geometry."""
    assert estimate_markdown_height("hello", 300, font_size) == _ONE_LINE_M


def test_inline_markers_do_not_inflate_height():
    """Emphasis markers are stripped before measuring, so they don't add lines."""
    plain = estimate_markdown_height("bold and code and link", 300)
    marked = estimate_markdown_height("**bold** and `code` and [link](http://x)", 300)
    assert marked == plain


def test_oversize_content_is_clamped():
    """Pathologically large content is capped, not unbounded."""
    assert estimate_markdown_height("word " * 200_000, 300) == MAX_ESTIMATED_HEIGHT


def test_long_unbroken_word_char_wraps():
    """A word longer than the width wraps by character into multiple lines."""
    assert estimate_markdown_height("x" * 400, 300) > 5 * 24


def test_font_size_accepts_string_alias():
    """The font size may be passed as its string value, not only the enum."""
    assert estimate_markdown_height("hello", 300, "M") == estimate_markdown_height(
        "hello", 300, FontSize.M
    )


# --- estimate_node_height (shape-aware) -------------------------------------


def test_excluded_types_return_zero():
    """Preview/doc node types are not content-sized (incl. sheet + code-sandbox — kept at default)."""
    for node_type in (NodeType.SLIDE, NodeType.WIDGET, NodeType.MINI_APP, NodeType.FOLDER,
                       NodeType.IMAGE, NodeType.ICON, NodeType.SHEET, NodeType.CODE_SANDBOX):
        assert node_type not in CONTENT_SIZED_TYPES
        assert estimate_node_height(node_type, 400, _LONG_LINE) == 0.0


def test_included_types_are_positive():
    """Content-sized types produce a positive height for non-empty content."""
    for node_type in (NodeType.RECTANGLE, NodeType.TEXT,
                      NodeType.DIAMOND, NodeType.ELLIPSE):
        assert estimate_node_height(node_type, 400, _LONG_LINE) > 0.0


def test_node_height_zero_for_empty_or_no_width():
    """No content or a non-positive width yields no height."""
    assert estimate_node_height(NodeType.RECTANGLE, 400, "") == 0.0
    assert estimate_node_height(NodeType.RECTANGLE, 0, _LONG_LINE) == 0.0


def test_diamond_and_ellipse_taller_than_rectangle():
    """Inscribed-area shapes need a taller bounding box than a plain rect."""
    rect = estimate_node_height(NodeType.RECTANGLE, 300, _LONG_LINE)
    diamond = estimate_node_height(NodeType.DIAMOND, 300, _LONG_LINE)
    ellipse = estimate_node_height(NodeType.ELLIPSE, 300, _LONG_LINE)
    assert diamond > rect
    assert ellipse > rect


def test_node_height_is_clamped():
    """Even after the shape height-factor divide, output stays within the cap."""
    assert estimate_node_height(NodeType.DIAMOND, 300, "word " * 200_000) == MAX_ESTIMATED_HEIGHT
