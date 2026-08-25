/**
 * The agent's tools (A4) — OURS, executed LOCALLY against the canvas store.
 *
 * Each tool is defined from a Zod parameter schema (`defineTool`): the schema
 * types the handler, validates the model's call at runtime, and becomes the JSON
 * Schema the LLM sees — one source of truth, no hand-written schema + coercion.
 * Each mutation is wrapped in `store.batch()` so an agent action is ONE undoable
 * batch (INV-8) and flows through the same persistence + search + sync pipeline
 * as a human edit. No server round-trips for these.
 */
import { z } from "zod"
import { asNodeId } from "@canvas-harness/core"
import type { Node } from "@canvas-harness/core"
import type { DimNodeData } from "@/features/board/model"
import { labelText } from "@/features/board/model"
import { validateMiniAppSource } from "@/features/mini-app/validate"
import { defineTool } from "./types"
import type { Tool, ToolContext } from "./types"
import { StoreMutator, type BoardMutator } from "./board-mutator"
import type { MemoryKind, MemoryScope } from "@/features/board/persist/local/idb"


/**
 * The board write port for a tool call: the ctx-provided `BoardMutator`, or a
 * default `StoreMutator` over the live store when absent (tests / lean ctx).
 * Tools write through this — never `store` directly — so the runtime stays
 * decoupled from the collab op pipeline (see board-mutator.ts).
 */
const mutatorFor = (ctx: ToolContext): BoardMutator => ctx.board ?? new StoreMutator(ctx.store, ctx.rootId ?? null)


/**
 * Resolve a note by id across the WHOLE board: the layer-scoped `store` (freshest,
 * for the current folder's live edits) first, then the per-turn whole-board
 * `boardNotes` snapshot for notes in other folders. Without the fallback,
 * search_notes / get_note can't read a cross-folder hit.
 */
const resolveBoardNode = (ctx: ToolContext, id: string): Node | undefined =>
  ctx.store.getNode(asNodeId(id)) ?? ctx.boardNotes?.get(id)


// Model-facing color params — a color NAME (scheme + a few examples, not the full
// list, so the tool schema stays lean). Resolved leniently by the mutator.
const BG_COLOR_DESC = "Fill color by name — a Tailwind family (amber, sky, rose, slate, emerald, …) or white/black/transparent. Applies to plain notes and (as a light tint) sheets; mini-app/widget/code notes ignore it. Omit for an automatic color; 'transparent' for no fill."
const BORDER_COLOR_DESC = "Border color, same scheme as background (plain notes only). Omit for no border."
const colorsFor = (background?: string, border?: string): { background?: string; border?: string } | undefined =>
  background || border ? { background, border } : undefined


export const createNote = defineTool({
  name: "create_note",
  description: "Create a note on the board with a title and optional body.",
  parameters: z.object({
    id: z.string().optional().describe("Optional explicit id; omit to auto-generate."),
    title: z.string().optional().describe("Short note title (the heading, stored separately from the body)."),
    body: z.string().optional().describe("The note body — prose or markdown."),
    x: z.number().optional().describe("Optional x canvas position; defaults beneath existing content (auto-arranged after the turn)."),
    y: z.number().optional().describe("Optional y canvas position; defaults beneath existing content (auto-arranged after the turn)."),
    background_color: z.string().optional().describe(BG_COLOR_DESC),
    border_color: z.string().optional().describe(BORDER_COLOR_DESC),
  }),
  run: async ({ id, title = "", body = "", x, y, background_color, border_color }, ctx) =>
    mutatorFor(ctx).createNote({ id, content: body, label: title, type: "rect", x, y, colors: colorsFor(background_color, border_color) }),
})


export const updateNote = defineTool({
  name: "update_note",
  description: "Update a note's title and/or body.",
  parameters: z.object({
    id: z.string().describe("Id of the note to update."),
    title: z.string().optional().describe("New title; omit to leave unchanged."),
    body: z.string().optional().describe("New body; omit to leave unchanged."),
  }),
  run: async ({ id, title, body }, ctx) => {
    if (!ctx.store.getNode(asNodeId(id))) return { error: "note not found" }
    await mutatorFor(ctx).patchNote(id, {
      ...(typeof body === "string" ? { content: body } : {}),
      ...(typeof title === "string" ? { label: title } : {}),
    })
    return { id }
  },
})


export const linkNotes = defineTool({
  name: "link_notes",
  description: "Create a directed link from one note to another.",
  parameters: z.object({
    sourceId: z.string().describe("Exact id of the note the arrow starts from."),
    targetId: z.string().describe("Exact id of the note the arrow points to."),
    label: z.string().optional().describe("Optional short label on the edge, e.g. 'yes', 'no', 'then', 'reads', 'causes'."),
  }),
  run: async ({ sourceId, targetId, label }, ctx) => mutatorFor(ctx).createLink({ sourceId, targetId, label }),
})


export const writeNote = defineTool({
  name: "write_note",
  description: "Create a new note, or fully rewrite an existing one when note_id is given. note_type: rectangle | sheet | mini-app | widget.",
  parameters: z.object({
    content: z.string().describe("The complete note body after this write — prose, markdown, code, or widget source."),
    label: z.string().optional().describe("Optional short title, stored separately from the body."),
    note_type: z.string().optional().describe("Visual note type: rectangle | sheet | mini-app | widget."),
    note_id: z.string().optional().describe("Existing note id to fully rewrite; omit to create a new note."),
    background_color: z.string().optional().describe(BG_COLOR_DESC),
    border_color: z.string().optional().describe(BORDER_COLOR_DESC),
  }),
  run: async ({ content, label, note_type, note_id, background_color, border_color }, ctx) => {
    // Validate a mini-app before persisting, so a malformed one is rejected with
    // line/col for the agent to fix this turn (not a silently-broken note).
    if (note_type === "mini-app") {
      const v = validateMiniAppSource(content)
      if (!v.ok) {
        return { error: `mini-app invalid: ${v.message}${v.line ? ` (line ${v.line}:${v.column})` : ""}` }
      }
    }

    const spec = { content, label, type: note_type, colors: colorsFor(background_color, border_color) }
    const board = mutatorFor(ctx)
    if (note_id) {
      // In the current layer → full rewrite (NOT a creation; the turn won't
      // re-arrange/recenter it). Existing but in ANOTHER folder → refuse rather
      // than create a colliding duplicate (cross-folder writes aren't supported
      // yet). Nowhere → a brand-new note with this explicit id.
      if (ctx.store.getNode(asNodeId(note_id))) return board.rewriteNote(note_id, spec)
      if (resolveBoardNode(ctx, note_id)) return { error: "That note is in another folder. Open that folder before editing it." }
      return board.createNote({ ...spec, id: note_id })
    }
    return board.createNote(spec)
  },
})


export const getNote = defineTool({
  name: "get_note",
  description: "Read an existing note's label, content, and type.",
  parameters: z.object({
    note_id: z.string().describe("Id of the note to read."),
  }),
  run: async ({ note_id }, ctx) => {
    // Whole-board resolve so a note in another folder (not in the layer-scoped
    // store) is still readable — search_notes can surface cross-folder ids.
    const node = resolveBoardNode(ctx, note_id)
    if (!node) return { error: "note not found" }
    return {
      id: note_id,
      label: labelText((node.data as DimNodeData | undefined)?.label),
      content: node.content ?? "",
      note_type: node.type,
    }
  },
})


export const editNote = defineTool({
  name: "edit_note",
  description: "Targeted edit: replace `old` with `new` in a note's content or label. Fails unless `old` is unique (or replace_all).",
  parameters: z.object({
    note_id: z.string().describe("Id of the note to edit."),
    field: z.enum(["content", "label"]).describe("Which field to edit."),
    old: z.string().describe("Exact substring to find; must be unique unless replace_all is set."),
    new: z.string().describe("Replacement text for `old`."),
    replace_all: z.boolean().optional().describe("When true, replace every occurrence of `old` instead of requiring uniqueness."),
  }),
  run: async ({ note_id, field, old, new: replacement, replace_all }, ctx) => {
    const node = ctx.store.getNode(asNodeId(note_id))
    if (!node) {
      // A cross-folder note (resolvable whole-board but not in this layer) can't be
      // edited from here yet — say so, consistent with write_note, instead of a
      // bare "not found".
      return resolveBoardNode(ctx, note_id)
        ? { error: "That note is in another folder. Open that folder before editing it." }
        : { error: "note not found" }
    }

    // Compute the replacement here (tool logic); the write goes through the port.
    const prev = node.data as DimNodeData | undefined
    const current = field === "label" ? labelText(prev?.label) : node.content ?? ""

    const occurrences = old ? current.split(old).length - 1 : 0
    if (occurrences === 0) return { error: "`old` not found in field" }
    if (occurrences > 1 && replace_all !== true) {
      return { error: "`old` occurs multiple times; expand it for uniqueness or set replace_all" }
    }
    const updated = replace_all === true ? current.split(old).join(replacement) : current.replace(old, replacement)

    await mutatorFor(ctx).patchNote(note_id, field === "label" ? { label: updated } : { content: updated })
    return { id: note_id }
  },
})


// Cap per-hit body + hit count so the tool payload stays lean (mirrors the old
// backend's 500-char / limit-5 shaping — here a touch higher on both).
const SEARCH_SNIPPET_CHARS = 600
const SEARCH_MAX_HITS = 8


/** Coerce to a plain string; a node's label/content is typed string but the store types data generically. */
const asText = (value: unknown): string => (typeof value === "string" ? value : "")


export const searchNotes = defineTool({
  name: "search_notes",
  description:
    "Full-text search the board's existing notes across ALL folders/layers (not just the" +
    " current one). Returns each match's id, title, and a content snippet — usually enough" +
    " to answer without a separate get_note.",
  parameters: z.object({
    query: z.string().describe("Full-text query matched against note titles and bodies."),
  }),
  run: async ({ query }, ctx) => {
    if (!ctx.search) return { results: [] }
    const ids = (await ctx.search.query(query)).slice(0, SEARCH_MAX_HITS)
    const results = ids.flatMap((id) => {
      // Resolve whole-board: a cross-folder hit isn't in the layer-scoped store.
      const node = resolveBoardNode(ctx, id)
      // A stale index entry (node deleted from the store) resolves to nothing —
      // drop it so neither the model nor the chat cites a phantom empty note.
      if (!node) return []
      // Title is `data.label`; the body lives in the native `node.content`.
      const title = labelText((node.data as DimNodeData | undefined)?.label)
      const content = asText(node.content).slice(0, SEARCH_SNIPPET_CHARS)
      // parentId lets the chat cite the hit + jump to its layer + node.
      const parentId = (node.data as DimNodeData | undefined)?.parentId ?? null
      return [{ id, title, content, parentId }]
    })
    return { results }
  },
})


export const listBoards = defineTool({
  name: "list_boards",
  description: "List the user's boards.",
  parameters: z.object({}),
  run: async (_args, ctx) => {
    if (!ctx.registry) return { boards: [] }
    const boards = await ctx.registry.listBoards()
    return { boards: boards.map((b) => ({ id: b.id, title: b.title })) }
  },
})


// ── Memory tools ──────────────────────────────────────────────────────────────
// Durable facts the agent saves and re-reads across turns/sessions. `scope` +
// `boardId` are bound from context, NEVER from the model — it passes only scope +
// content, so a board turn can't write into another board or forge a global fact.

const MEMORY_KIND = z.enum(["user", "feedback", "project", "reference"])
const MEMORY_SCOPE = z.enum(["board", "global"])


/** Resolve the boardId a scoped write targets (null for global, ctx-bound for board). */
const scopeBoardId = (scope: MemoryScope, ctx: ToolContext): string | null =>
  scope === "board" ? (ctx.boardId ?? null) : null


/** The model-facing over-cap payload: the message + the entries to consolidate. */
const overCapPayload = (entries: { id: string; title: string; summary: string }[]) => ({
  ok: false as const,
  reason: "over_cap" as const,
  message: "Memory is full for this scope. Delete or merge an entry below, then retry.",
  entries: entries.map((r) => ({ id: r.id, title: r.title, summary: r.summary })),
})


/** At most this many records come back from a single recall (bounds context cost). */
const RECALL_MAX = 25


/**
 * Fetch a memory the current turn is allowed to edit/delete: it must exist, be
 * live, and — if board-scoped — belong to THIS board. Blocks a board turn from
 * mutating another board's memory via a surfaced/guessed id (global is the user's
 * own and stays editable from any of their boards).
 */
const editableMemory = async (id: string, ctx: ToolContext) => {
  const rec = await ctx.memory?.get(id)
  if (!rec || rec.deleted) return { error: "no such memory" as const }
  if (rec.scope === "board" && rec.boardId !== (ctx.boardId ?? null)) return { error: "that memory belongs to another board" as const }
  return { rec }
}


export const saveMemory = defineTool({
  name: "save_memory",
  description:
    "Save a durable fact so you remember it in later turns and sessions. Use for stable user" +
    " preferences, decisions, or what a board is about. SKIP anything derivable from the board," +
    " trivial, ephemeral, or your own mid-turn scratch work. Scope 'board' = about this board;" +
    " 'global' = about the user across boards. Over the cap, the save is rejected with current" +
    " entries — consolidate (update/delete) and retry.",
  parameters: z.object({
    scope: MEMORY_SCOPE,
    kind: MEMORY_KIND.describe("user = who they are; feedback = how to work; project = what this is about; reference = a pointer."),
    title: z.string().describe("Short slug naming the fact."),
    summary: z.string().describe("ONE line — the retrieval key shown in the always-on index."),
    body: z.string().describe("The fact. For feedback/project, add **Why:** and **How to apply:** lines."),
  }),
  run: async ({ scope, kind, title, summary, body }, ctx) => {
    if (!ctx.memory) return { error: "memory unavailable" }
    if (scope === "board" && !ctx.boardId) return { error: "no board in context for a board-scoped memory" }
    const res = await ctx.memory.add({
      scope,
      boardId: scopeBoardId(scope, ctx),
      kind: kind as MemoryKind,
      title,
      summary,
      body,
      id: crypto.randomUUID(),
      now: Date.now(),
    })
    if (!res.ok) return overCapPayload(res.entries)
    return { ok: true, id: res.record.id, scope, title }
  },
})


export const updateMemory = defineTool({
  name: "update_memory",
  description: "Revise a saved memory by id (from the memory index or a recall). Use to consolidate or correct a fact.",
  parameters: z.object({
    id: z.string(),
    title: z.string().optional(),
    summary: z.string().optional(),
    body: z.string().optional(),
    kind: MEMORY_KIND.optional(),
  }),
  run: async ({ id, title, summary, body, kind }, ctx) => {
    if (!ctx.memory) return { error: "memory unavailable" }
    const owned = await editableMemory(id, ctx)
    if ("error" in owned) return { ok: false, error: owned.error }
    const res = await ctx.memory.update(id, { title, summary, body, kind: kind as MemoryKind | undefined }, Date.now())
    if (!res.ok) return res.reason === "over_cap" ? overCapPayload(res.entries) : { ok: false, error: "no such memory" }
    return { ok: true, id }
  },
})


export const deleteMemory = defineTool({
  name: "delete_memory",
  description: "Delete a saved memory by id (from the memory index or a recall). Use to drop a stale or wrong fact.",
  parameters: z.object({ id: z.string() }),
  run: async ({ id }, ctx) => {
    if (!ctx.memory) return { error: "memory unavailable" }
    const owned = await editableMemory(id, ctx)
    if ("error" in owned) return { ok: false, error: owned.error }
    const removed = await ctx.memory.remove(id, Date.now())
    return removed ? { ok: true, id } : { ok: false, error: "no such memory" }
  },
})


export const recallMemory = defineTool({
  name: "recall_memory",
  description:
    "Look up saved memories. The board + global index is already in your prompt, so recall is only" +
    " needed for a targeted lookup or when the set is large. Omit scope to search both.",
  parameters: z.object({
    scope: MEMORY_SCOPE.optional(),
    query: z.string().optional().describe("Case-insensitive substring over title/summary/body; omit to list all."),
  }),
  run: async ({ scope, query }, ctx) => {
    if (!ctx.memory) return { results: [] }
    const scopes: MemoryScope[] = scope ? [scope] : ["board", "global"]
    const q = query?.trim().toLowerCase()
    const records = (
      await Promise.all(scopes.map((s) => ctx.memory!.list(s, s === "board" ? (ctx.boardId ?? null) : null)))
    ).flat()
    const matched = q ? records.filter((r) => `${r.title} ${r.summary} ${r.body}`.toLowerCase().includes(q)) : records
    const hits = matched.slice(0, RECALL_MAX)
    return {
      results: hits.map((r) => ({ id: r.id, scope: r.scope, kind: r.kind, title: r.title, summary: r.summary, body: r.body })),
      truncated: matched.length > RECALL_MAX,
    }
  },
})


export const memoryTools: Tool[] = [saveMemory, updateMemory, deleteMemory, recallMemory]


export const localTools: Tool[] = [createNote, updateNote, linkNotes, searchNotes, listBoards]


/** The note-building tools the chat agent uses (matches the system prompt's vocabulary). */
export const agentBuildTools: Tool[] = [writeNote, editNote, getNote, linkNotes]
