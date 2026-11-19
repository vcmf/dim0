"""Web Search Handler."""
import httpx

from agents import FunctionTool, ModelSettings, RunContextWrapper, Runner, function_tool

from topix.agents.config import WebSearchConfig
from topix.agents.datatypes.context import Context
from topix.agents.datatypes.model_enum import ModelEnum
from topix.agents.datatypes.outputs import WebSearchOutput
from topix.agents.datatypes.tools import AgentToolName
from topix.agents.datatypes.web_search import WebSearchContextSize, WebSearchOption
from topix.agents.tool_handler import ToolHandler
from topix.agents.websearch.openai import OpenAIWebSearch
from topix.agents.websearch.keenable import search_keenable
from topix.agents.websearch.tools import search_exa, search_linkup, search_perplexity, search_tavily
from topix.agents.websearch.web_summarize import WebSummarize
from topix.datatypes.recurrence import Recurrence
from topix.utils.common import gen_uid


class WebSearchHandler:
    """Web Search Handler."""

    @classmethod
    def from_config(
        cls,
        config: WebSearchConfig,
        *,
        client: httpx.AsyncClient | None = None,
        timeout: httpx.Timeout | None = None,
    ) -> FunctionTool:
        """Get Web search Tool from WebSearchConfig."""
        if config.search_engine == WebSearchOption.OPENAI:
            if not config.model.startswith("openai"):
                raise ValueError(
                    "OpenAI search engine is only compatible with OpenAI models,"
                    f"got {config.model}."
                )
            return cls.get_openai_web_tool(
                model=config.model,
                instructions_template=config.instructions_template,
                model_settings=config.model_settings,
                search_context_size=config.search_context_size,
                recency=config.recency,
                streamed=config.streamed,
            )
        else:
            web_summarizer = WebSummarize(
                model=config.model,
                instructions_template=config.instructions_template,
                model_settings=config.model_settings,
            )
            return cls.get_web_tool(
                search_engine=config.search_engine,
                search_context_size=config.search_context_size,
                recency=config.recency,
                max_results=config.max_results,
                enable_summary=config.enable_summary,
                streamed=config.streamed,
                web_summarizer=web_summarizer,
                client=client,
                timeout=timeout,
            )

    @classmethod
    def get_openai_web_tool(
        cls,
        model: str = ModelEnum.OpenAI.GPT_5_4_MINI,
        instructions_template: str = "web_search.jinja",
        model_settings: ModelSettings | None = None,
        search_context_size: WebSearchContextSize = WebSearchContextSize.MEDIUM,
        recency: Recurrence | None = None,
        streamed: bool = False,
    ) -> FunctionTool:
        """Get the OpenAI web search tool."""
        web_search_agent = OpenAIWebSearch(
            model=model,
            instructions_template=instructions_template,
            model_settings=model_settings,
            search_context_size=search_context_size,
            recency=recency,
        )

        return ToolHandler.convert_agent_to_tool(
            agent=web_search_agent,
            tool_name=AgentToolName.WEB_SEARCH,
            streamed=streamed,
        )

    @classmethod
    def get_web_tool(
        cls,
        search_engine: WebSearchOption,
        search_context_size: WebSearchContextSize,
        recency: Recurrence | None = None,
        max_results: int = 10,
        enable_summary: bool = False,
        streamed: bool = False,
        web_summarizer: WebSummarize | None = None,
        *,
        client: httpx.AsyncClient | None = None,
        timeout: httpx.Timeout | None = None,
    ) -> FunctionTool:
        """Get the normal web search tools."""

        async def web_search(
            wrapper: RunContextWrapper[Context],
            query: str,
        ) -> WebSearchOutput:
            match search_engine:
                case WebSearchOption.TAVILY:
                    search_func = search_tavily
                case WebSearchOption.LINKUP:
                    search_func = search_linkup
                case WebSearchOption.PERPLEXITY:
                    search_func = search_perplexity
                case WebSearchOption.EXA:
                    search_func = search_exa
                case WebSearchOption.KEENABLE:
                    search_func = search_keenable
                case _:
                    raise ValueError(f"Unknown search engine: {search_engine}")

            res: WebSearchOutput = await search_func(
                query=query,
                max_results=max_results,
                search_context_size=search_context_size,
                recency=recency,
                client=client,
                timeout=timeout,
            )
            return res

        if not enable_summary:
            return ToolHandler.convert_func_to_tool(
                func=web_search,
                tool_name=AgentToolName.WEB_SEARCH,
            )

        @function_tool(name_override=AgentToolName.WEB_SEARCH)
        async def search_with_summary(
            wrapper: RunContextWrapper,
            query: str,
        ) -> WebSearchOutput:
            """Search the web and return a concise, cited summary of the results.

            Args:
                wrapper: The agent run context (injected; not part of the tool schema).
                query: The web search query.

            """
            tool_id = getattr(wrapper, "tool_call_id", None) or gen_uid()
            search_output: WebSearchOutput = await web_search(wrapper, query)
            await ToolHandler.log_input(
                AgentToolName.WEB_SEARCH, tool_id, query, wrapper.context
            )
            summary_agent = WebSummarize() if not web_summarizer else web_summarizer
            if streamed:
                response = await Runner.run_streamed(
                    summary_agent,
                    input=str(search_output),
                )
                await ToolHandler.process_llm_streaming(
                    wrapper.context,
                    response,
                    tool_id,
                    AgentToolName.WEB_SEARCH,
                )
            else:
                response = await Runner.run(
                    starting_agent=summary_agent,
                    input=str(search_output),
                    context=wrapper.context,
                )

            search_output.answer = response.final_output

            await ToolHandler.log_output(
                wrapper.context,
                AgentToolName.WEB_SEARCH,
                tool_id,
                input=query,
                output=search_output,
            )
            return search_output

        return search_with_summary
