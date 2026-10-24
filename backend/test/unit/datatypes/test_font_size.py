"""Validation tests for preset and explicit note font sizes."""

import pytest

from pydantic import ValidationError

from topix.datatypes.note.style import FontSize, LinkStyle, Style


@pytest.mark.parametrize("value", [8, 72, 256])
def test_explicit_font_size_accepts_supported_range(value):
    """Node and link styles accept bounded explicit pixel sizes."""
    assert Style(font_size=value).font_size == value
    assert LinkStyle(font_size=value).font_size == value


def test_font_size_presets_remain_supported():
    """Existing preset values retain their enum representation."""
    assert Style(font_size="XL").font_size is FontSize.XL


@pytest.mark.parametrize(
    "value", [0, 7.99, 256.01, 999, float("nan"), float("inf"), float("-inf")]
)
def test_explicit_font_size_rejects_unsafe_values(value):
    """Out-of-range and non-finite sizes are rejected at the model boundary."""
    with pytest.raises(ValidationError):
        Style(font_size=value)
