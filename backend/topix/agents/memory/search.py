""""Memory search tool."""


from typing import Awaitable

from agents import RunContextWrapper

from topix.agents.datatypes.context import Context
from topix.agents.datatypes.outputs import MemorySearchOutput
from topix.agents.datatypes.tools import AgentToolName, tool_descriptions
from topix.agents.memory.utils import resource_to_ref_annotation
from topix.agents.tool_handler import ToolHandler
from topix.store.qdrant.store import ContentStore
from topix.store.qdrant.utils import build_filter


async def mem_search(
    query: str,
    content_store: ContentStore,
    filters: dict | None = None,
    limit: int = 5
) -> MemorySearchOutput:
    """Search inside memory with optional filtering.

    Args:
        query: The search query.
        content_store: The content store to search from.
        filters: Optional filters to apply during the search.
        limit: The maximum number of results to return.

    Returns: A MemorySearchOutput containing the search results; empty when
    `filters` carries no `graph_uid`, since the collection is shared by every
    user and only a board scope keeps the search to one board.

    """
    if not isinstance(filters, dict) or not filters.get("graph_uid"):
        return MemorySearchOutput()
    results = await content_store.search(
        query=query,
        limit=limit,
        filter=build_filter(must=filters),
    )
    return MemorySearchOutput(
        references=[resource_to_ref_annotation(res.resource) for res in results if res.resource is not None]
    )


def create_memory_search_tool(
    filters: dict | None,
    content_store: ContentStore,
) -> Awaitable[MemorySearchOutput]:
    """Create a memory search tool.

    Args:
        filters: Optional filters to apply during the search.
        content_store: The content store to search from.

    Returns: An awaitable MemorySearchOutput.

    """
    async def tool(_wrapper: RunContextWrapper[Context], query: str) -> MemorySearchOutput:
        """Search the board's notes and documents by meaning and return matching references.

        Args:
            query: Natural-language text to match against note titles and content.

        """
        return await mem_search(
            query=query,
            content_store=content_store,
            filters=filters,
        )

    toolfunc = ToolHandler.convert_func_to_tool(
        tool,
        tool_name=AgentToolName.MEMORY_SEARCH,
        tool_description=tool_descriptions[AgentToolName.MEMORY_SEARCH],
    )

    # Attach filters to the tool for later reference
    toolfunc.memory_search_filter = filters

    return toolfunc
