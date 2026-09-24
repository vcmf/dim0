"""Backend note tools refuse note types this agent can't author.

`applet` is a persisted `NodeType` (synced boards store it) but only the
browser agent knows and validates its JSX grammar. A backend write would
persist a broken node, so `write_note` / `create_note` reject it up front.
"""

from __future__ import annotations

import asyncio
import json

from unittest.mock import AsyncMock

import pytest

from agents.tool_context import ToolContext

from topix.agents.datatypes.context import Context
from topix.agents.notes.tools import create_create_note_tool, create_write_note_tool


class _DummyGraphStore:
    """Minimal graph-store stub matching the shape note tools use."""

    def __init__(self) -> None:
        """Init the AsyncMock surface that build_note + the note tools touch."""
        self.add_notes = AsyncMock()
        self.add_links = AsyncMock()
        self.get_graph = AsyncMock(return_value=type("Graph", (), {"nodes": []})())
        self.get_nodes = AsyncMock(return_value=[])
        self.patch_note = AsyncMock()
        self._note_locks: dict[str, asyncio.Lock] = {}

    def note_lock(self, note_id: str) -> asyncio.Lock:
        """Mirror GraphStore.note_lock so tools can serialize edits."""
        return self._note_locks.setdefault(note_id, asyncio.Lock())


def _make_write_note(store: _DummyGraphStore):
    """Build write_note with no agent bridge (direct store calls)."""
    return create_write_note_tool(graph_store=store, graph_uid="board-1")  # type: ignore[arg-type]


def _make_create_note(store: _DummyGraphStore):
    """Build the deprecated create_note tool."""
    return create_create_note_tool(graph_store=store, graph_uid="board-1")  # type: ignore[arg-type]


async def _invoke(tool, **kwargs):
    """Invoke a FunctionTool with keyword args; tool errors come back as a string."""
    ctx = ToolContext(
        context=Context(),
        tool_name=tool.name,
        tool_call_id="test-call-id",
        tool_arguments="{}",
    )
    return await tool.on_invoke_tool(ctx, json.dumps(kwargs))


@pytest.mark.parametrize("make_tool", [_make_write_note, _make_create_note])
async def test_applet_note_type_is_rejected_without_persisting(make_tool):
    """An applet write fails with a pointer to mini-app and stores nothing."""
    store = _DummyGraphStore()

    result = await _invoke(make_tool(store), content="<Widget/>", note_type="applet")

    text = str(result)
    assert 'note_type="applet" is not supported' in text
    assert "mini-app" in text
    store.add_notes.assert_not_awaited()


async def test_supported_note_type_still_persists():
    """The guard doesn't affect ordinary types."""
    store = _DummyGraphStore()

    await _invoke(_make_write_note(store), content="hello", note_type="rectangle")

    store.add_notes.assert_awaited_once()
