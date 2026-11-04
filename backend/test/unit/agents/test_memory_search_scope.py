"""Unit tests for the memory_search tool's board scoping.

The tool must only ever search within a board filter; without one it returns
nothing instead of querying the whole shared content collection.
"""

from __future__ import annotations

import json

from unittest.mock import AsyncMock

import pytest

from agents.tool_context import ToolContext

from topix.agents.datatypes.context import Context
from topix.agents.memory.search import create_memory_search_tool, mem_search


def _make_tool_ctx() -> ToolContext[Context]:
    """Build a ToolContext stub for invoking the tool directly."""
    return ToolContext(
        context=Context(),
        tool_name="memory_search",
        tool_call_id="test-call-id",
        tool_arguments="{}",
    )


_UNSCOPED_FILTERS = [None, {}, {"graph_uid": None}, {"graph_uid": ""}, {"type": "note"}]


@pytest.mark.parametrize("filters", _UNSCOPED_FILTERS)
async def test_memory_search_without_board_scope_does_not_query(filters):
    """No board filter: no store query, empty result."""
    content_store = AsyncMock()
    tool = create_memory_search_tool(filters, content_store)

    result = await tool.on_invoke_tool(_make_tool_ctx(), json.dumps({"query": "anything"}))

    content_store.search.assert_not_awaited()
    assert result.type == "memory_search"
    assert result.references == []


async def test_memory_search_with_board_scope_queries_with_filter():
    """A board filter is passed through to the store query."""
    content_store = AsyncMock()
    content_store.search.return_value = []
    tool = create_memory_search_tool({"graph_uid": "g1"}, content_store)

    await tool.on_invoke_tool(_make_tool_ctx(), json.dumps({"query": "anything"}))

    content_store.search.assert_awaited_once()
    assert content_store.search.await_args.kwargs["filter"] is not None


@pytest.mark.parametrize("filters", _UNSCOPED_FILTERS)
async def test_mem_search_itself_refuses_unscoped_queries(filters):
    """The guard lives in mem_search, so direct callers are covered too."""
    content_store = AsyncMock()

    result = await mem_search("anything", content_store, filters=filters)

    content_store.search.assert_not_awaited()
    assert result.references == []
