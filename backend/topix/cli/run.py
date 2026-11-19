# ai_cli_agent_app.py
"""Interactive CLI app for a real streaming agent."""

from __future__ import annotations

import asyncio
import contextlib
import subprocess
import time

from typing import Literal, Optional

import questionary

from readchar import readkey
from readchar.key import CTRL_C, CTRL_D, ENTER, LEFT, RIGHT
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.text import Text

from topix.agents.assistant.manager import AssistantManager
from topix.agents.config import AssistantManagerConfig, DeepResearchConfig
from topix.agents.datatypes.context import ReasoningContext
from topix.agents.datatypes.stream import AgentStreamMessage
from topix.agents.datatypes.tools import AgentToolName, tool_descriptions
from topix.agents.deep_research import DeepResearch
from topix.agents.sessions import AssistantSession
from topix.cli.utils import Renderer, SessionRun, StepRun

# --------- Dim0 agent imports ----------
from topix.setup import setup
from topix.store.chat import ChatStore
from topix.utils.common import gen_uid
from topix.utils.logging import logging_config

logging_config(level="WARNING")

console = Console()

# --------- UI / timing ----------
USE_ALT_SCREEN = True
CIRCLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
SPINNER_INTERVAL = 0.001
STREAM_INTERVAL = 0.001
CURSOR = "▌"

# --------- Tool titles (step headings) ----------
TOOL_TITLES: dict[str, str] = tool_descriptions

# --------- App state ----------
history: list[SessionRun] = []
expand_all = False
input_buffer = ""
stop_requested = False
agent_task: Optional[asyncio.Task] = None  # running agent task or None


# ---------- helpers ----------
def parse_tool_uuid(tool_id: str) -> str:
    """Extract the UUID part from a tool_id like '<uuid>::<order>' or 'TOOL::UUID'."""
    return tool_id.split("::", 1)[0] if "::" in tool_id else tool_id


def extract_urls(annotations: list[object]) -> list[str]:
    """Safely extract 'url' fields from annotation objects or dicts."""
    urls: list[str] = []
    for ann in annotations or []:
        url = getattr(ann, "url", None)
        if url is None and isinstance(ann, dict):
            url = ann.get("url")
        if isinstance(url, str) and url.strip():
            urls.append(url.strip())
    return urls


def ensure_paragraph_break(s: str) -> str:
    """Ensure s ends with a blank line (Markdown paragraph break)."""
    if not s:
        return s
    if s.endswith("\n\n"):
        return s
    if s.endswith("\n"):
        return s + "\n"
    return s + "\n\n"


def strip_query_echo_once(
    existing_answer: Optional[str], incoming: str, query: str
) -> str:
    """If the final answer is empty, strip an initial echo of the user's query."""
    if existing_answer:
        return incoming
    inc = incoming.lstrip()
    prefixes = [query, f"User: {query}", f"Query: {query}"]
    for p in prefixes:
        if inc.startswith(p):
            dropped = inc[len(p):]
            while dropped and dropped[0] in ": -–—\n\t":
                dropped = dropped[1:]
            return dropped.lstrip("\n")
    return incoming


class FinalAnswerGate:
    """Detect when the final answer starts based on RAW_MESSAGE tool calls."""

    def __init__(self) -> None:
        """Init method."""
        self.raw_seen: list[str] = []  # ordered unique UUIDs for raw_message
        self.final_uuid: Optional[str] = None

    def observe(self, msg: AgentStreamMessage) -> None:
        """Observe a message to track RAW_MESSAGE tool calls."""
        if msg.tool_name not in (
            AgentToolName.RAW_MESSAGE,
            AgentToolName.SYNTHESIZER,
            AgentToolName.ANSWER_REFORMULATE,
        ):
            return
        uuid = parse_tool_uuid(msg.tool_id)
        if uuid not in self.raw_seen:
            self.raw_seen.append(uuid)
        if len(self.raw_seen) >= 2 and self.final_uuid is None:
            # second UUID is the final-answer stream
            self.final_uuid = self.raw_seen[1]

    def is_final_answer(self, msg: AgentStreamMessage) -> bool:
        """Check if this message belongs to the final answer stream."""
        return msg.tool_name in (
            AgentToolName.ANSWER_REFORMULATE,
            AgentToolName.SYNTHESIZER,
        )


async def run_agent_session(  # noqa: C901
    query: str,
    assistant: AssistantManager | DeepResearch,
    session: AssistantSession,
    renderer: Renderer,
) -> None:
    """Consume assistant.run_streamed(...) and render steps + final answer live."""
    global stop_requested

    # New session block in UI
    sess = SessionRun(query=query)
    history.append(sess)

    # Per-tool tracking
    step_index = 0
    by_uuid: dict[str, StepRun] = {}
    step_started_at: dict[str, float] = {}
    last_urls_for_uuid: dict[str, str] = {}  # de-dupe per tool instance

    final_gate = FinalAnswerGate()
    current_active_uuid: Optional[str] = None
    frame_idx = 0

    # initial paint
    renderer.render_tail(
        history=history, expand_all=expand_all, input_buffer=input_buffer
    )
    context = ReasoningContext()

    final_answer = ""

    try:
        async for msg in assistant.run_streamed(
            query=query, context=context, session=session
        ):
            if stop_requested:
                break

            # detect final answer stream
            final_gate.observe(msg)
            if final_gate.is_final_answer(msg):
                # skip 'status' tokens even in final mode
                if (
                    msg.content
                    and getattr(msg.content, "type", None)
                    and str(msg.content.type) == "status"
                ):
                    continue
                if msg.content and msg.content.text:
                    final_answer += msg.content.text
                    # strip a leading echo of the query only on the first chunk
                    chunk = strip_query_echo_once(sess.answer, msg.content.text, query)
                    if chunk:
                        renderer.stream_answer_tick(sess, chunk)
                # caret on the actively streaming answer
                renderer.render_tail(
                    history=history,
                    expand_all=expand_all,
                    input_buffer=input_buffer,
                    answer_caret_for=sess,
                )
                await asyncio.sleep(STREAM_INTERVAL)
                continue

            # tool step streaming (only arguments + annotations; NO token text)
            uuid = parse_tool_uuid(msg.tool_id)
            tool_key = msg.tool_name.value
            title = TOOL_TITLES.get(tool_key, tool_key.replace("_", " "))

            if uuid not in by_uuid:
                step_index += 1
                st = StepRun(idx=step_index, title=f"Step {step_index}: {title}")
                by_uuid[uuid] = st
                sess.steps.append(st)
                step_started_at[uuid] = time.perf_counter()

            st = by_uuid[uuid]
            current_active_uuid = uuid

            if msg.content:
                ctype = (
                    str(msg.content.type)
                    if getattr(msg.content, "type", None) is not None
                    else ""
                )
                text = msg.content.text or ""
                urls = extract_urls(getattr(msg.content, "annotations", []) or [])

                # 1) Skip 'status' messages entirely
                if ctype == "status":
                    pass

                # 2) Inputs → ARGUMENTS (string). If you emit JSON here, json.loads & set dict instead.
                elif ctype == "input":
                    st.arguments = st.arguments or ""
                    if isinstance(st.arguments, str) and text:
                        st.arguments = (
                            st.arguments + ("\n" if st.arguments else "") + text
                        )

                # 3) All other content types BEFORE final answer:
                #    DO NOT append token text to the step; only show annotations (Reading: ...)
                else:
                    if urls:
                        urls_line = "Reading: " + ", ".join(urls)
                        if last_urls_for_uuid.get(uuid) != urls_line:
                            # For web_search, ensure a blank line before Reading:
                            if tool_key == "web_search":
                                st.details = ensure_paragraph_break(st.details)
                            else:
                                if st.details and not st.details.endswith(
                                    ("\n", "\n\n")
                                ):
                                    st.details += "\n"
                            st.details += urls_line
                            last_urls_for_uuid[uuid] = urls_line

            if msg.is_stop:
                started = step_started_at.get(uuid)
                if started is not None:
                    st.elapsed = time.perf_counter() - started
                st.timestamp = time.strftime("%H:%M:%S")

            # render active with spinner; details/arguments only
            frame = CIRCLE_FRAMES[frame_idx % len(CIRCLE_FRAMES)]
            frame_idx += 1
            renderer.render_tail(
                history=history,
                expand_all=expand_all,
                input_buffer=input_buffer,
                active_sess=sess,
                current_idx=by_uuid[current_active_uuid].idx
                if current_active_uuid
                else None,
                spinner_frame=frame,
                show_details=True,
                show_input_caret=True,
            )
            await asyncio.sleep(SPINNER_INTERVAL)
    except KeyboardInterrupt:
        stop_requested = True

    # final paint
    renderer.render_tail(
        history=history,
        expand_all=expand_all,
        input_buffer=input_buffer,
    )

    if sess.answer and sess.answer.strip():
        # 1) render final UI so user sees the latest state before switching
        renderer.render_tail(
            history=history,
            expand_all=expand_all,
            input_buffer=input_buffer,
        )

        # 2) create a fresh Console (do NOT reuse renderer.console)
        plain_console = Console(
            record=True,
            force_terminal=True,
        )

        # 3) Render markdown into plain_console record (this produces ANSI)
        # print query :
        plain_console.print(
            Panel(
                sess.query,
                title="Query",
                border_style="blue",
                expand=False,
            )
        )

        md = Markdown(sess.answer, code_theme="monokai", hyperlinks=False)
        plain_console.print(md)

        # 4) Grab ANSI-ified text
        rendered = plain_console.export_text(
            styles=True
        )  # this contains ANSI / color codes

        # 5) Exit alt screen before launching external pager (only if using alt screen)
        if USE_ALT_SCREEN:
            renderer.exit_alt_screen()

        subprocess.run(["stty", "sane"], check=False)

        try:
            # 6) Call system pager less -R so ANSI color preserved and scrolling works
            #    If less is not available, this will fall back to printing text.
            p = subprocess.Popen(["less", "-R"], stdin=subprocess.PIPE)
            rendered_with_enter = rendered + "\n"
            try:
                p.stdin.write(rendered_with_enter.encode("utf-8"))
                p.stdin.close()
                p.wait()
            except BrokenPipeError:
                # user quit pager early; ignore
                pass
            except Exception:
                # fallback: print directly if pager fails
                print(rendered)
        finally:
            # 7) ALWAYS try to re-enter alt screen and re-render the live UI
            #    (the try/finally guarantees we do this even on errors / Ctrl-C)
            if USE_ALT_SCREEN:
                # tiny sleep helps terminals stabilize
                time.sleep(0.05)
                renderer.enter_alt_screen()
            # re-draw the UI to restore state
            renderer.render_tail(
                history=history, expand_all=expand_all, input_buffer=input_buffer
            )


async def key_loop(renderer: Renderer) -> None:  # noqa: C901
    """Global key loop that drives the prompt + expands/collapses + launches runs."""
    global expand_all, input_buffer, stop_requested, agent_task

    while not stop_requested:
        try:
            k = await asyncio.to_thread(readkey)
        except KeyboardInterrupt:
            stop_requested = True
            break

        # Quit
        if k in (CTRL_C, CTRL_D):
            stop_requested = True
            if agent_task and not agent_task.done():
                agent_task.cancel()
            break

        # Expand / collapse anytime
        if k == RIGHT:
            expand_all = True
            renderer.render_tail(
                history=history, expand_all=expand_all, input_buffer=input_buffer
            )
            continue
        if k == LEFT:
            expand_all = False
            renderer.render_tail(
                history=history, expand_all=expand_all, input_buffer=input_buffer
            )
            continue

        # Enter: if idle, launch; if running, ignore
        if k == ENTER:
            if agent_task is None or agent_task.done():
                q = input_buffer.strip()
                input_buffer = ""
                renderer.render_tail(
                    history=history, expand_all=expand_all, input_buffer=input_buffer
                )
                if q:
                    agent_task = asyncio.create_task(
                        run_agent_session(
                            q, key_loop.assistant, key_loop.session, renderer
                        )  # type: ignore[attr-defined]
                    )
                    await agent_task
            continue

        # Backspace
        if k == "\x7f" or k == "\b":
            input_buffer = input_buffer[:-1]
            renderer.render_tail(
                history=history, expand_all=expand_all, input_buffer=input_buffer
            )
            continue

        # Regular char (ignore escape sequences)
        if len(k) == 1 and not k.startswith("\x1b"):
            input_buffer += k
            renderer.render_tail(
                history=history, expand_all=expand_all, input_buffer=input_buffer
            )
            continue


DEFAULT_MODEL = "openai/gpt-4.1"


async def main_async(
    mode=Literal["assistant", "deep_research"],
    model: str = DEFAULT_MODEL,
    search_engine: str = "perplexity",
) -> None:
    """Run main async app."""
    global stop_requested, agent_task

    # One-time Dim0 setup & assistant manager
    await setup("local")
    chat_store = ChatStore()

    # Create a new chat session (thread)
    session_id = gen_uid()
    session = AssistantSession(session_id, chat_store=chat_store)
    if mode == "assistant":
        assistant_config = AssistantManagerConfig.from_yaml()
        assistant_config.set_model(model)
        assistant_config.set_web_engine(search_engine)

        assistant: AssistantManager = AssistantManager.from_config(
            content_store=chat_store._content_store, config=assistant_config
        )
    else:
        deepsearch_config = DeepResearchConfig.from_yaml()
        deepsearch_config.set_model(model)
        assistant: DeepResearch = DeepResearch.from_config(deepsearch_config)

    renderer = Renderer(
        console=console,
        use_alt_screen=USE_ALT_SCREEN,
        header_title="[bold]AI Agent 👋[/bold]",
        header_char="=",
        header_style="cyan",
        input_caret=CURSOR,
        wrap_margin=4,
        show_hint=True,
    )

    # DI: stash assistant & session for key loop
    key_loop.assistant = assistant  # type: ignore[attr-defined]
    key_loop.session = session  # type: ignore[attr-defined]

    if USE_ALT_SCREEN:
        renderer.enter_alt_screen()
    try:
        renderer.render_tail(
            history=history, expand_all=expand_all, input_buffer=input_buffer
        )
        await key_loop(renderer)
        if agent_task and not agent_task.done():
            agent_task.cancel()
            with contextlib.suppress(Exception):
                await agent_task
    finally:
        if USE_ALT_SCREEN:
            renderer.exit_alt_screen()
        console.print(Text("Bye-bye appli.", style="red"))


MODEL_DICT = {
    "gpt-4.1": "openai/gpt-4.1",
    "gemini-2.5-flash": "openrouter/google/gemini-2.5-flash",
    "deepseek-chat-v3.1": "openrouter/deepseek/deepseek-chat-v3.1",
    "mistral-medium-3.1": "openrouter/mistralai/mistral-medium-3.1",
    "claude-sonnet-4.6": "openrouter/anthropic/claude-sonnet-4.6",
    "glm-4.7": "openrouter/z-ai/glm-4.7:nitro",
    "qwen3.5-plus-02-15": "openrouter/qwen/qwen3.5-plus-02-15",
    "qwen3.6-plus": "openrouter/qwen/qwen3.6-plus-preview:free",
}


def _select_options() -> tuple[Literal["assistant", "deep_research"], str, str]:
    mode = questionary.select(
        "Choose a mode to start:",
        choices=[
            {"name": "🤖 Assistant (general-purpose chat)", "value": "assistant"},
            {"name": "🔬 Deep Research (Research Report)", "value": "deep_research"},
        ],
        qmark="?",
        pointer="❯",
        style=questionary.Style(
            [
                ("qmark", "fg:cyan bold"),
                ("question", "bold"),
                ("pointer", "fg:green bold"),
            ]
        ),
    ).ask()

    model_name = questionary.select(
        "Model to use:",
        default="gpt-4.1",
        choices=[
            "gpt-4.1",
            "gemini-2.5-flash",
            "deepseek-chat-v3.1",
            "mistral-medium-3.1",
            "claude-sonnet-4.6",
            "glm-4.7",
            "qwen3.5-plus-02-15",
            "qwen3.6-plus-preview:free",
        ],
        qmark="?",
        style=questionary.Style(
            [
                ("qmark", "fg:cyan bold"),
                ("question", "bold"),
            ]
        ),
    ).ask()

    model = MODEL_DICT.get(model_name, DEFAULT_MODEL)

    search_engine = questionary.select(
        "Web search engine (if applicable):",
        default={"name": "Linkup", "value": "linkup"},
        choices=[
            {"name": "Linkup", "value": "linkup"},
            {"name": "Perplexity", "value": "perplexity"},
            {"name": "Tavily", "value": "tavily"},
            {"name": "Keenable", "value": "keenable"},
        ],
        qmark="?",
        pointer="❯",
        style=questionary.Style(
            [
                ("qmark", "fg:cyan bold"),
                ("question", "bold"),
                ("pointer", "fg:green bold"),
            ]
        ),
    ).ask()

    return mode, model or DEFAULT_MODEL, search_engine or "perplexity"


if __name__ == "__main__":
    mode, model, search_engine = _select_options()

    try:
        asyncio.run(main_async(mode, model, search_engine))
    except KeyboardInterrupt:
        console.print(Text("Bye-bye appli.", style="red"))
