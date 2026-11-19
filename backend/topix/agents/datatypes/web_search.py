"""Web Search Settings Data Types."""
from enum import StrEnum


class WebSearchOption(StrEnum):
    """Enumeration of web search options."""

    OPENAI = "openai"
    TAVILY = "tavily"
    PERPLEXITY = "perplexity"
    LINKUP = "linkup"
    EXA = "exa"
    KEENABLE = "keenable"


class WebSearchContextSize(StrEnum):
    """Enumeration of web search context sizes."""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
