"""Estimate the rendered height of a note's markdown at a given width.

Python port of the canvas engine's height probe
(`canvas-harness/packages/core/src/text/estimate-height.ts`, itself ported
from `canvas-lite-markdown.tsx`). The canvas wraps text with the browser's
`canvas.measureText`; here we have no canvas, so we mirror its SSR fallback —
a character-count heuristic (`len * fontSizePx * CHAR_WIDTH_FACTOR`).

Used by the post-turn auto-layout so Sugiyama spacing reflects how tall a
note will actually render, instead of the stub default heights (e.g. a TEXT
note defaults to 20px tall but renders much taller once content wraps).

Because the width heuristic is linear in character count, wrapping is pure
arithmetic — no per-character re-measuring — so this stays O(content length).
Keep the constants below in sync with `text/defaults.ts`.
"""

from __future__ import annotations

import re

from math import ceil, isfinite

from topix.datatypes.note.style import FontSize, NodeType

# Mirror text/defaults.ts. Font size and line height in CSS px per FontSize.
_FONT_SIZE_PX: dict[str, int] = {"S": 14, "M": 16, "L": 24, "XL": 36}
_LINE_HEIGHT_PX: dict[str, int] = {"S": 20, "M": 24, "L": 32, "XL": 40}

# Keep these aligned with @canvas-harness/core's exported font-size constants.
MIN_FONT_SIZE_PX = 8.0
MAX_FONT_SIZE_PX = 256.0
NUMERIC_LINE_HEIGHT_RATIO = 1.25

# Average glyph advance as a fraction of font size. Matches the canvas's own
# SSR / no-context fallback in `text/measure.ts` (`length * fontSize * 0.55`).
# It is deliberately rough: we only need realistic *line counts*, not pixels.
CHAR_WIDTH_FACTOR = 0.55

# Layout constants from text/defaults.ts.
CODE_BLOCK_PADDING_X = 6
CODE_BLOCK_MARGIN_Y = 4
CONTENT_HEIGHT_BUFFER = 4
MIN_WIDTH = 40
MIN_CODE_WIDTH = 20

# Guards against pathological content: a 100KB note tells us nothing more
# about spacing than a 5KB one does — both just mean "give it lots of room".
MAX_MEASURE_CHARS = 16_000
MAX_ESTIMATED_HEIGHT = 4_000.0

# Width-fitting: horizontal text padding (2 × canvas CONTENT_PADDING) and the
# floor a shrunk node width may not drop below.
HORIZONTAL_PADDING = 12
MIN_NODE_WIDTH = 120.0

_HR_RE = re.compile(r"^[ \t]*---[ \t]*$")
_HR_DOUBLE_RE = re.compile(r"^[ \t]*===[ \t]*$")

# Collapses inline markdown emphasis to its display text so marker characters
# (`**`, `` ` ``, `[…](…)`, `$$…$$`, …) don't inflate the measured width.
# Mirrors INLINE_PATTERN in text/tokens.ts; the captured group is the text
# that actually renders (link label, code body, math source, etc.).
_INLINE_SUB = re.compile(
    r"\$\$([^\n]+?)\$\$"
    r"|\*\*([^*]+)\*\*"
    r"|==([^=\s](?:[^=]*?[^=\s])?)=="
    r"|`([^`]+)`"
    r"|\*([^*]+)\*"
    r"|__([^_]+)__"
    r"|~~([^~]+)~~"
    r"|_([^_]+)_"
    r"|\[([^\]]+)\]\([^)]+\)"
)

_WS_SPLIT = re.compile(r"(\s+)")


def _font_metrics(font_size: FontSize | str | float) -> tuple[float, float]:
    """Resolve a preset or a bounded explicit CSS-pixel font size."""
    if isinstance(font_size, (int, float)):
        raw_size = float(font_size)
        if not isfinite(raw_size):
            return _FONT_SIZE_PX["M"], _LINE_HEIGHT_PX["M"]
        size = min(MAX_FONT_SIZE_PX, max(MIN_FONT_SIZE_PX, raw_size))
        for preset, preset_size in _FONT_SIZE_PX.items():
            if size == preset_size:
                return size, _LINE_HEIGHT_PX[preset]
        return size, size * NUMERIC_LINE_HEIGHT_RATIO
    key = font_size.value if isinstance(font_size, FontSize) else str(font_size)
    return _FONT_SIZE_PX.get(key, _FONT_SIZE_PX["M"]), _LINE_HEIGHT_PX.get(
        key, _LINE_HEIGHT_PX["M"]
    )


def _display_text(line: str) -> str:
    """Strip inline emphasis markers, keeping the text that renders."""

    def repl(match: re.Match[str]) -> str:
        for group in match.groups():
            if group is not None:
                return group
        return match.group(0)

    return _INLINE_SUB.sub(repl, line)


def _wrap_line_count(line: str, max_width: float, char_w: float) -> int:
    """Count the visual lines one prose source line wraps into at `max_width`.

    Word-wraps by whitespace, falling back to character wrapping for words
    longer than the width — same policy as the canvas wrap engine.
    """
    chunks = [c for c in _WS_SPLIT.split(_display_text(line)) if c]
    if not chunks:
        return 1

    cursor = 0.0
    count = 1
    for chunk in chunks:
        width = len(chunk) * char_w
        if chunk.isspace():
            # Leading whitespace on a fresh line is dropped (cursor == 0).
            if cursor > 0.0:
                cursor += width
            continue
        if cursor > 0.0 and cursor + width > max_width:
            count += 1
            cursor = 0.0
        if width > max_width and len(chunk) > 1:
            # Word longer than the line: char-wrap. Linear because width is
            # proportional to length — no need to re-measure per character.
            per_line = max(1, int(max_width // char_w))
            lines_needed = ceil(len(chunk) / per_line)
            count += lines_needed - 1
            last_chars = len(chunk) - (lines_needed - 1) * per_line
            cursor = last_chars * char_w
            continue
        cursor += width
    return count


def _prose_height(block: str, max_width: float, char_w: float, line_height: int) -> float:
    """Height of a non-code text segment (handles hard breaks and hr lines)."""
    if not block.strip():
        return 0.0
    visual = 0
    for line in block.split("\n"):
        if _HR_RE.match(line) or _HR_DOUBLE_RE.match(line):
            visual += 1
            continue
        visual += _wrap_line_count(line, max_width, char_w)
    return visual * line_height


def _code_block_height(code: str, max_width: float, char_w: float, line_height: int) -> float:
    """Height of a fenced code block: char-wrapped lines plus top/bottom margin."""
    code_max_width = max(MIN_CODE_WIDTH, max_width - CODE_BLOCK_PADDING_X * 2)
    per_line = max(1, int(code_max_width // char_w))

    visual = 0
    for raw in code.split("\n"):
        normalized = raw.replace("\t", "  ")
        if not normalized:
            visual += 1
        else:
            visual += max(1, ceil(len(normalized) / per_line))
    visual = max(1, visual)
    # First and last visual line each carry a vertical margin.
    return visual * line_height + 2 * CODE_BLOCK_MARGIN_Y


def _iter_segments(text: str):
    """Yield (is_code, segment_text) splitting on ``` fences, like tokenize()."""
    cursor = 0
    length = len(text)
    while cursor < length:
        start = text.find("```", cursor)
        if start == -1:
            yield False, text[cursor:]
            return
        if start > cursor:
            yield False, text[cursor:start]
        end = text.find("```", start + 3)
        if end == -1:
            # Unterminated fence: treat the remainder as prose (matches tokenize).
            yield False, text[start:]
            return
        fence_content = text[start + 3 : end]
        # Drop the optional language line after the opening fence.
        newline = re.search(r"[\r\n]", fence_content)
        code = fence_content
        if newline:
            code = re.sub(r"^\r?\n", "", fence_content[newline.start() :])
        yield True, code.replace("\r\n", "\n")
        cursor = end + 3


def estimate_markdown_height(
    content: str | None,
    width: float,
    font_size: FontSize | str | float = FontSize.M,
) -> float:
    """Estimate the px height `content` renders to when wrapped at `width`.

    Mirrors the canvas `estimateMarkdownContentHeight`. Returns 0.0 for empty
    content; otherwise at least one line height plus a small buffer, clamped to
    a sane maximum so a giant note can't blow up downstream layout math.
    """
    text = (content or "").strip()
    if not text:
        return 0.0
    if len(text) > MAX_MEASURE_CHARS:
        text = text[:MAX_MEASURE_CHARS]

    font_size_px, line_height = _font_metrics(font_size)
    char_w = font_size_px * CHAR_WIDTH_FACTOR
    max_width = max(MIN_WIDTH, ceil(width))

    total = 0.0
    for is_code, segment in _iter_segments(text):
        if is_code:
            total += _code_block_height(segment, max_width, char_w, line_height)
        else:
            total += _prose_height(segment, max_width, char_w, line_height)

    total = max(line_height, total) + CONTENT_HEIGHT_BUFFER
    return min(total, MAX_ESTIMATED_HEIGHT)


# Per-shape (text_width_factor, content_height_factor), mirroring the canvas
# `contentBounds` insets (render/shapes/content-bounds.ts). text_width_factor
# shrinks the wrap width — a narrower interior makes the same text wrap taller;
# content_height_factor is the fraction of the bounding box usable for text, so
# the box height needed is `content_height / content_height_factor`. Capsule /
# tag / thought-cloud use approximate constants in place of the canvas's
# size-dependent (and self-referential) absolute insets — close enough for
# layout spacing.
_SQRT2_INV = 0.7071067811865476
_SHAPE_FACTORS: dict[NodeType, tuple[float, float]] = {
    NodeType.DIAMOND: (_SQRT2_INV, _SQRT2_INV),
    NodeType.LAYERED_DIAMOND: (_SQRT2_INV, _SQRT2_INV),
    NodeType.SOFT_DIAMOND: (_SQRT2_INV, _SQRT2_INV),
    NodeType.ELLIPSE: (0.7, 0.7),
    NodeType.LAYERED_CIRCLE: (0.7, 0.7),
    NodeType.CAPSULE: (0.8, 1.0),
    NodeType.TAG: (0.75, 1.0),
    NodeType.THOUGHT_CLOUD: (1.0, 0.75),
}

# Node types whose layout height is derived from rendered content instead of the
# stub default. Only built-in shapes are content-sized — they're text-on-canvas
# primitives that should hug their label. Document-style custom nodes (SHEET,
# CODE_SANDBOX) are deliberately excluded: they're long-form scrolling surfaces
# (Notion-like prose; arbitrary code), so fitting their height would spawn giant
# cards. They keep their fixed default size and the inner content scrolls.
# Everything else (folder, image, icon, slide, widget, mini-app, sheet,
# code-sandbox) keeps its fixed default size.
CONTENT_SIZED_TYPES: frozenset[NodeType] = frozenset(
    {
        NodeType.RECTANGLE,
        NodeType.LAYERED_RECTANGLE,
        NodeType.TEXT,
        NodeType.ELLIPSE,
        NodeType.LAYERED_CIRCLE,
        NodeType.DIAMOND,
        NodeType.LAYERED_DIAMOND,
        NodeType.SOFT_DIAMOND,
        NodeType.CAPSULE,
        NodeType.TAG,
        NodeType.THOUGHT_CLOUD,
    }
)


def estimate_node_height(
    node_type: NodeType,
    width: float,
    content: str | None,
    font_size: FontSize | str | float = FontSize.M,
) -> float:
    """Estimate the bounding-box height a node needs to fit `content` at `width`.

    Returns 0.0 for content-less or non-content-sized types. Accounts for shape
    geometry: text inside a diamond/ellipse occupies an inscribed rect, so the
    box must be taller (and wrap narrower) than a plain rectangle's.
    """
    if node_type not in CONTENT_SIZED_TYPES or width <= 0:
        return 0.0
    width_factor, height_factor = _SHAPE_FACTORS.get(node_type, (1.0, 1.0))
    text_width = max(MIN_WIDTH, width * width_factor)
    content_height = estimate_markdown_height(content, text_width, font_size)
    if content_height <= 0.0:
        return 0.0
    return min(content_height / height_factor, MAX_ESTIMATED_HEIGHT)


# Document-style types keep a fixed reading width; only their height fits.
# (Sheet is excluded from content sizing entirely — see CONTENT_SIZED_TYPES.)
_FIXED_WIDTH_TYPES: frozenset[NodeType] = frozenset({NodeType.CODE_SANDBOX})

# Minimum height as a fraction of width, so geometric shapes don't collapse to
# slivers once width also shrinks. Square shapes (diamond/ellipse) stay ~square;
# naturally-wide ones (capsule/tag) get a gentler floor. Types absent here
# (rectangle/text/sheet) fit height freely.
_MIN_ASPECT: dict[NodeType, float] = {
    NodeType.DIAMOND: 1.0,
    NodeType.LAYERED_DIAMOND: 1.0,
    NodeType.SOFT_DIAMOND: 1.0,
    NodeType.ELLIPSE: 1.0,
    NodeType.LAYERED_CIRCLE: 1.0,
    NodeType.THOUGHT_CLOUD: 0.6,
    NodeType.CAPSULE: 0.35,
    NodeType.TAG: 0.35,
}


def _natural_text_width(content: str, char_w: float) -> float:
    """Return the widest unwrapped line of `content` in px (markers stripped)."""
    widest = 0.0
    for is_code, segment in _iter_segments(content):
        for line in segment.split("\n"):
            display = line if is_code else _display_text(line)
            widest = max(widest, len(display) * char_w)
    return widest


def estimate_node_size(
    node_type: NodeType,
    default_width: float,
    content: str | None,
    font_size: FontSize | str | float = FontSize.M,
) -> tuple[float, float] | None:
    """Fit a node's (width, height) to its content, shape-aware.

    Returns None for empty content or non-content-sized types (the caller keeps
    the default size). Width shrinks toward the content's natural width, clamped
    to [MIN_NODE_WIDTH, default_width], for shapes and text labels; document
    types (sheet, code-sandbox) keep their reading width and only fit height. A
    per-shape minimum aspect keeps diamonds/ellipses from collapsing to slivers.
    """
    text = (content or "").strip()
    if node_type not in CONTENT_SIZED_TYPES or not text:
        return None

    if node_type in _FIXED_WIDTH_TYPES:
        width = default_width
    else:
        font_size_px, _ = _font_metrics(font_size)
        char_w = font_size_px * CHAR_WIDTH_FACTOR
        width_factor = _SHAPE_FACTORS.get(node_type, (1.0, 1.0))[0]
        box_width = (_natural_text_width(text, char_w) + HORIZONTAL_PADDING) / width_factor
        lower = min(MIN_NODE_WIDTH, default_width)
        width = max(lower, min(default_width, float(ceil(box_width))))

    height = estimate_node_height(node_type, width, text, font_size)
    min_aspect = _MIN_ASPECT.get(node_type)
    if min_aspect is not None:
        height = max(height, width * min_aspect)
    return width, height
