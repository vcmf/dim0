"""Primitive create/edit note tools scoped to the current board context."""

from __future__ import annotations

from typing import Literal

from agents import FunctionTool, RunContextWrapper

from topix.agents.datatypes.context import Context
from topix.agents.datatypes.outputs import (
    CreateNoteOutput,
    EditNoteOutput,
    GetNoteOutput,
    LinkNotesOutput,
    WriteNoteOutput,
)
from topix.agents.datatypes.tools import AgentToolName
from topix.agents.notes.service import (
    SHEET_MIN_HEIGHT,
    SHEET_MIN_WIDTH,
    build_note,
    get_default_note_size,
)
from topix.agents.tool_handler import ToolHandler
from topix.collab.agent_bridge import AgentBoardBridge
from topix.datatypes.note.link import Link
from topix.datatypes.note.style import NodeType
from topix.datatypes.property import SizeProperty
from topix.datatypes.resource import RichText
from topix.mini_app import compile_mini_app_source
from topix.store.graph import GraphStore

# Types this agent can't author: `applet` source is a JSX grammar only the
# browser agent is taught (and validates), so a backend write would persist a
# broken node. The enum still carries it because synced boards persist applets.
_AGENT_UNSUPPORTED_NOTE_TYPES: frozenset[NodeType] = frozenset({NodeType.APPLET})


def _reject_unsupported_note_type(note_type: NodeType) -> None:
    """Refuse note types this agent can't author, pointing it at `mini-app` instead."""
    if note_type in _AGENT_UNSUPPORTED_NOTE_TYPES:
        raise ValueError(
            f'note_type="{note_type.value}" is not supported by this tool. For a chart, '
            'dashboard or other interactive artifact, call `learn_generate_mini_app` and '
            'write the JSX with note_type="mini-app".'
        )


async def _validate_mini_app_content(content: str) -> None:
    """Reject a mini-app write whose source can't compile.

    Runs the sucrase + widget-declaration check before the note is
    persisted, so the agent's failed write surfaces a structured
    ValueError it can correct on the next attempt (compile errors
    include the line + column).

    Bypasses the check for non-mini-app note types — callers pass
    every content through here and let the function early-out on the
    cheap case.
    """
    result = await compile_mini_app_source(content)
    if result.ok:
        return
    err = result.error
    if err is None:
        raise ValueError("mini-app validation failed with no error detail")
    parts = [f"mini-app {err.kind}: {err.message}"]
    if err.line is not None:
        loc = f"line {err.line}"
        if err.column is not None:
            loc += f", column {err.column}"
        parts.append(f"at {loc}")
    raise ValueError(" ".join(parts))


def create_write_note_tool(  # noqa: C901 — branching is the whole job (create vs rewrite, sheet-resize, mini-app-validate); splitting would scatter cohesive logic
    graph_store: GraphStore,
    graph_uid: str,
    root_id: str | None = None,
    agent_bridge: AgentBoardBridge | None = None,
) -> FunctionTool:
    """Build a write-note tool bound to the current board and optional folder scope.

    When `agent_bridge` is supplied, mutations route through it so live
    collab peers receive a `peer-op` with `is_system: true`. When omitted,
    falls back to direct `graph_store` calls (used in tests + the CLI).
    """

    async def write_note(
        _wrapper: RunContextWrapper[Context],
        content: str,
        label: str | None = None,
        note_type: NodeType = NodeType.RECTANGLE,
        note_id: str | None = None,
    ) -> WriteNoteOutput:
        """Create a new note or fully rewrite an existing note in the current board scope.

        Use this tool when you need to author full note content in one shot, including prose,
        markdown, code, or widget source. Omit `note_id` to create a new note. Provide
        `note_id` only when you intend to fully rewrite the authored fields of an existing note,
        perform a major restructure, or change the note type. For localized updates to an
        existing note, use `edit_note` instead. Always identify an existing note by `note_id`,
        never by label, because labels are descriptive and may change. If the user asks for a
        rich-text document or long-form note, use `note_type="sheet"`.

        Args:
            content (str): The complete note body after this write, such as prose, markdown, code, or widget source.
            label (str | None): Optional short title stored separately from the main body.
            note_type (NodeType): Visual note type to use after the write.
            note_id (str | None): Optional existing note id. Omit to create a new note.

        """
        _reject_unsupported_note_type(note_type)
        # mini-app notes are sandbox-rendered React; reject malformed
        # JSX before persisting so the agent can correct in one tool
        # round-trip (the error message includes line/col from sucrase).
        if note_type == NodeType.MINI_APP:
            await _validate_mini_app_content(content)

        if note_id is None:
            note = await build_note(
                graph_store=graph_store,
                graph_uid=graph_uid,
                label=label,
                content=content,
                note_type=note_type,
                parent_id=root_id,
            )
            if agent_bridge is not None:
                await agent_bridge.add_notes(board_id=graph_uid, notes=[note])
            else:
                await graph_store.add_notes([note])

            return WriteNoteOutput(
                action="created",
                note_id=note.id,
                graph_uid=graph_uid,
                label=label,
                note_type=note_type,
                parent_id=root_id,
            )

        existing_notes = await graph_store.get_nodes([note_id])
        if not existing_notes:
            raise ValueError(f"Note {note_id} was not found.")

        existing_note = existing_notes[0]
        if existing_note.graph_uid != graph_uid:
            raise ValueError("Note does not belong to the current board scope.")

        patch: dict = {
            "label": {"markdown": label} if label is not None else None,
            "content": {"markdown": content},
            "style": {"type": note_type},
        }
        if note_type != existing_note.style.type and note_type == NodeType.SHEET:
            existing_size = existing_note.properties.node_size.size
            needs_seed = (
                existing_size is None
                or existing_size.width < SHEET_MIN_WIDTH
                or existing_size.height < SHEET_MIN_HEIGHT
            )
            if needs_seed:
                width, height = get_default_note_size(note_type)
                patch.setdefault("properties", {})["node_size"] = SizeProperty(
                    size=SizeProperty.Size(width=width, height=height)
                ).model_dump()

        if agent_bridge is not None:
            updated_note = await agent_bridge.patch_note(
                board_id=graph_uid, node_id=note_id, data=patch, user_uid=None,
            )
        else:
            updated_note = await graph_store.patch_note(note_id, patch)
        if updated_note is None:
            raise ValueError(f"Note {note_id} was not found.")

        return WriteNoteOutput(
            action="rewritten",
            note_id=updated_note.id,
            graph_uid=graph_uid,
            label=updated_note.label.markdown if updated_note.label else None,
            note_type=updated_note.style.type,
            parent_id=updated_note.parent_id,
        )

    return ToolHandler.convert_func_to_tool(
        write_note,
        tool_name=AgentToolName.WRITE_NOTE,
        tool_description=None,
    )


def create_create_note_tool(
    graph_store: GraphStore,
    graph_uid: str,
    root_id: str | None = None,
) -> FunctionTool:
    """Build a create-note tool bound to the current board and optional folder scope."""

    async def create_note(
        _wrapper: RunContextWrapper[Context],
        content: str,
        label: str | None = None,
        note_type: NodeType = NodeType.RECTANGLE,
    ) -> CreateNoteOutput:
        """Create a note in the current board scope.

        Keep content short and concise, with only light markdown when helpful.
        DEPRECATED: prefer `write_note` for new integrations. This tool remains for
        backward compatibility.
        If the user asks for a rich-text document or long-form note, use `note_type="sheet"`.
        If the user asks for a code note or runnable snippet, use `code-sandbox` and put the code in `content`.
        If the user asks for a chart, dashboard, diagram, flashcard, or other custom-rendered artifact,
            first call `learn_generate_mini_app` and then store the JSX in `content` with `note_type="mini-app"`.
            Raw HTML widgets (`learn_generate_html_widget` + `note_type="widget"`) are legacy.

        Args:
            content (str): Main markdown body of the note. This is the most important text.
            label (str | None): Optional short title stored separately from the main body.
            note_type (NodeType): Visual note shape to create, such as rectangle or sheet.

        """
        _reject_unsupported_note_type(note_type)
        note = await build_note(
            graph_store=graph_store,
            graph_uid=graph_uid,
            label=label,
            content=content,
            note_type=note_type,
            parent_id=root_id,
        )
        await graph_store.add_notes([note])

        return CreateNoteOutput(
            note_id=note.id,
            graph_uid=graph_uid,
            label=label,
            note_type=note_type,
            parent_id=root_id,
        )

    return ToolHandler.convert_func_to_tool(
        create_note,
        tool_name=AgentToolName.CREATE_NOTE,
        tool_description=None,
    )


def create_edit_note_tool(
    graph_store: GraphStore,
    graph_uid: str,
    agent_bridge: AgentBoardBridge | None = None,
) -> FunctionTool:
    """Build an edit-note tool bound to the current board scope.

    When `agent_bridge` is supplied, patches route through it so live
    peers receive the equivalent `node.update` as a system `peer-op`.
    """

    async def edit_note(
        _wrapper: RunContextWrapper[Context],
        note_id: str,
        field: Literal["label", "content"],
        old: str,
        new: str,
        replace_all: bool = False,
    ) -> EditNoteOutput:
        """Apply a targeted text edit to a note field by anchoring on a unique substring.

        Use this as the default tool for localized changes to an existing note, including prose,
        markdown, code, or widget source. Always identify the target note by `note_id`, never by
        label, because labels are descriptive and may change.

        `old` is a substring of the current field value, not the entire value. Use the smallest
        snippet that's clearly unique — typically a phrase or 2-4 adjacent lines. The edit fails
        if `old` occurs zero times or more than once. To resolve a non-unique match, expand `old`
        with surrounding context, or pass `replace_all=true` to change every occurrence.

        Args:
            note_id (str): Exact id of the note to update.
            field (Literal["label", "content"]): Which note field to edit.
            old (str): Non-empty substring of the current field value to anchor the edit.
            new (str): Replacement text for the matched substring.
            replace_all (bool): When true, replace every occurrence of `old`. Reserve for
                renames or repeated tokens you want changed everywhere.

        """
        if old == "":
            raise ValueError(
                "Empty old not allowed. Pass a non-empty anchor, "
                "or use write_note to rewrite the field."
            )

        async with graph_store.note_lock(note_id):
            existing_notes = await graph_store.get_nodes([note_id])
            if not existing_notes:
                raise ValueError(f"Note {note_id} was not found.")

            existing_note = existing_notes[0]
            if existing_note.graph_uid != graph_uid:
                raise ValueError("Note does not belong to the current board scope.")

            if field == "label":
                current_value = existing_note.label.markdown if existing_note.label is not None else ""
            else:
                current_value = existing_note.content.markdown if existing_note.content is not None else ""

            count = current_value.count(old)
            if count == 0:
                raise ValueError(
                    f"old not found in {field}. Re-read the note with get_note "
                    f"and use a snippet from its current content."
                )
            if count > 1 and not replace_all:
                raise ValueError(
                    f"old occurs {count} times in {field}. Expand it with surrounding "
                    f"context for uniqueness, or pass replace_all=true."
                )

            new_value = current_value.replace(old, new) if replace_all else current_value.replace(old, new, 1)

            patch: dict = {
                field: {"markdown": new_value},
            }

            if agent_bridge is not None:
                updated_note = await agent_bridge.patch_note(
                    board_id=graph_uid, node_id=note_id, data=patch, user_uid=None,
                )
            else:
                updated_note = await graph_store.patch_note(note_id, patch)
            if updated_note is None:
                raise ValueError(f"Note {note_id} was not found.")

        return EditNoteOutput(
            note_id=updated_note.id,
            graph_uid=graph_uid,
            label=updated_note.label.markdown if updated_note.label else None,
            note_type=updated_note.style.type,
            parent_id=updated_note.parent_id,
        )

    return ToolHandler.convert_func_to_tool(
        edit_note,
        tool_name=AgentToolName.EDIT_NOTE,
        tool_description=None,
    )


def create_get_note_tool(
    graph_store: GraphStore,
    graph_uid: str,
) -> FunctionTool:
    """Build a get-note tool bound to the current board scope."""

    async def get_note(
        _wrapper: RunContextWrapper[Context],
        note_id: str,
    ) -> GetNoteOutput:
        """Read the current content and metadata of an existing note by exact note id.

        Use this tool when you already know a note id and need to inspect the note again
        before editing or rewriting it. Always identify existing notes by `note_id`, not by
        label, because labels are descriptive and may be duplicated or changed.

        Args:
            note_id (str): Exact id of the note to fetch.

        """
        existing_notes = await graph_store.get_nodes([note_id])
        if not existing_notes:
            raise ValueError(f"Note {note_id} was not found.")

        note = existing_notes[0]
        if note.graph_uid != graph_uid:
            raise ValueError("Note does not belong to the current board scope.")

        return GetNoteOutput(
            note_id=note.id,
            graph_uid=note.graph_uid,
            label=note.label.markdown if note.label else None,
            content=note.content.markdown if note.content else "",
            note_type=note.style.type,
            parent_id=note.parent_id,
        )

    return ToolHandler.convert_func_to_tool(
        get_note,
        tool_name=AgentToolName.GET_NOTE,
        tool_description=None,
    )


def create_link_notes_tool(
    graph_store: GraphStore,
    graph_uid: str,
    root_id: str | None = None,
    agent_bridge: AgentBoardBridge | None = None,
) -> FunctionTool:
    """Build a link-notes tool bound to the current board and folder scope.

    When `agent_bridge` is supplied, new links route through it so live
    peers receive the equivalent `edge.add` as a system `peer-op`.
    """

    async def link_notes(
        _wrapper: RunContextWrapper[Context],
        source_id: str,
        target_id: str,
        label: str | None = None,
    ) -> LinkNotesOutput:
        """Create a directed arrow from `source_id` to `target_id` in the current board scope.

        Use this to express hierarchy (parent -> child), order (step A -> step B),
        causal or logical relations, or decision branches. The link is a primitive
        edge between two existing notes; it does not modify either note's content.
        Positions of the connected notes are arranged automatically at the end of the
        turn, so you do not need to think about layout when choosing what to link.

        Args:
            source_id (str): Exact id of the note the arrow starts from.
            target_id (str): Exact id of the note the arrow points to.
            label (str | None): Optional short label rendered on the edge, such as
                "yes", "no", "then", "reads", or "causes".

        """
        if source_id == target_id:
            raise ValueError("source_id and target_id must refer to different notes.")

        existing_notes = await graph_store.get_nodes([source_id, target_id])
        existing_by_id = {note.id: note for note in existing_notes}

        missing = [nid for nid in (source_id, target_id) if nid not in existing_by_id]
        if missing:
            raise ValueError(f"Note(s) not found: {', '.join(missing)}.")

        for nid in (source_id, target_id):
            if existing_by_id[nid].graph_uid != graph_uid:
                raise ValueError(f"Note {nid} does not belong to the current board scope.")

        link = Link(
            source=source_id,
            target=target_id,
            graph_uid=graph_uid,
            parent_id=root_id,
            label=RichText(markdown=label) if label else None,
        )
        if agent_bridge is not None:
            await agent_bridge.add_links(board_id=graph_uid, links=[link])
        else:
            await graph_store.add_links([link])

        return LinkNotesOutput(
            link_id=link.id,
            source_id=source_id,
            target_id=target_id,
            graph_uid=graph_uid,
            label=label,
        )

    return ToolHandler.convert_func_to_tool(
        link_notes,
        tool_name=AgentToolName.LINK_NOTES,
        tool_description=None,
    )
