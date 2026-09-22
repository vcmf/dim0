"""SendMessageRequest tolerance for unknown enabled_tools.

The browser-agent frontend sends its own toolset (e.g. `learn_generate_applet`)
to the legacy backend agent, which has no such `AgentToolName` member. The
request must drop unknown tool names, not 422 the whole message.
"""

from topix.agents.datatypes.tools import AgentToolName
from topix.api.datatypes.requests import SendMessageRequest


def test_drops_unknown_tool_names_instead_of_422():
    """An unknown tool name (learn_generate_applet) is filtered, request still validates."""
    req = SendMessageRequest(
        query="hi",
        enabled_tools=["write_note", "learn_generate_applet", "learn_generate_diagram"],
    )
    assert AgentToolName.WRITE_NOTE in req.enabled_tools
    assert AgentToolName.LEARN_GENERATE_DIAGRAM in req.enabled_tools
    # the unknown one is dropped, not raised
    assert all(t.value != "learn_generate_applet" for t in req.enabled_tools)
    assert len(req.enabled_tools) == 2


def test_keeps_all_valid_tools():
    """A list of only-valid tools passes through unchanged."""
    req = SendMessageRequest(query="hi", enabled_tools=["web_search", "get_note"])
    assert req.enabled_tools == [AgentToolName.WEB_SEARCH, AgentToolName.GET_NOTE]


def test_default_enabled_tools_when_omitted():
    """Omitting enabled_tools keeps the model default (validator is a no-op)."""
    req = SendMessageRequest(query="hi")
    assert AgentToolName.WEB_SEARCH in req.enabled_tools


def test_unknown_force_tool_becomes_none():
    """A forced tool outside the enum drops to None instead of 422ing the request."""
    req = SendMessageRequest(query="hi", force_tool="learn_generate_applet")
    assert req.force_tool is None


def test_known_force_tool_preserved():
    """A valid forced tool passes through."""
    req = SendMessageRequest(query="hi", force_tool="write_note")
    assert req.force_tool == AgentToolName.WRITE_NOTE
