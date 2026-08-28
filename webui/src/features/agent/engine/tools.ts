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
import type { CanvasStore, Node } from "@canvas-harness/core"
import type { DimNode, DimNodeData } from "@/features/board/model"
import { labelText } from "@/features/board/model"
import { buildLayerPath } from "@/features/board/model/layer"
import { MAX_BOARD_DEPTH, canCreateSubBoard } from "@/features/board/lib/board-limit"
import { validateMiniAppSource } from "@/features/mini-app/validate"
import { defineTool } from "./types"
import type { Tool, ToolContext } from "./types"
import { StoreMutator, HeadlessMutator, type BoardMutator } from "./board-mutator"
import { arrangeNodesInPlace } from "@/features/board/harness/agent/arrange-created-nodes"
import type { MemoryKind, MemoryScope } from "@/features/board/persist/local/idb"


/**
 * The board write port for a tool call: the ctx-provided `BoardMutator`, or a
 * default `StoreMutator` over the live store when absent (tests / lean ctx).
 * Tools write through this — never `store` directly — so the runtime stays
 * decoupled from the collab op pipeline (see board-mutator.ts).
 */
const mutatorFor = (ctx: ToolContext): BoardMutator => ctx.board ?? new StoreMutator(ctx.store, ctx.rootId ?? null)


/**
 * The store for the agent's WORKING FOLDER: the off-scene layer store when the
 * working folder isn't the user's visible layer (navigated away), else the
 * visible `store`. Read/edit/arrange tools resolve through this so they act on
 * the folder the agent is working in — including notes it authored this turn —
 * and never touch the user's on-screen layer while navigated away.
 */
const workingLayerStore = async (ctx: ToolContext): Promise<CanvasStore> => {
  const board = mutatorFor(ctx)
  return board instanceof HeadlessMutator ? board.layerStore() : ctx.store
}


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


// Relational placement — the LLM-friendly alternative to raw coordinates.
const NEAR_DESC = "Place next to an existing note instead of auto-placing: give its node_id and a direction. Nudged to avoid overlap, staying on that side. Prefer this over raw x/y. Omit for automatic tidy placement."
const NEAR_SCHEMA = z.object({
  node_id: z.string().describe("Id of the existing note to anchor to."),
  dir: z.enum(["above", "below", "left", "right"]).describe("Which side of the anchor to place on."),
  gap: z.number().optional().describe("Px gap from the anchor; defaults to a small gap."),
})
const nearFor = (
  near?: { node_id: string; dir: "above" | "below" | "left" | "right"; gap?: number },
): { nodeId: string; dir: "above" | "below" | "left" | "right"; gap?: number } | undefined =>
  near ? { nodeId: near.node_id, dir: near.dir, gap: near.gap } : undefined


export const createNote = defineTool({
  name: "create_note",
  description: "Create a note on the board with a title and optional body.",
  parameters: z.object({
    id: z.string().optional().describe("Optional explicit id; omit to auto-generate."),
    title: z.string().optional().describe("Short note title (the heading, stored separately from the body)."),
    body: z.string().optional().describe("The note body — prose or markdown."),
    x: z.number().optional().describe("Explicit x canvas position; pins the note here (kept as-is, not auto-arranged). Omit for automatic placement or use `near`."),
    y: z.number().optional().describe("Explicit y canvas position; pins the note here (kept as-is, not auto-arranged). Omit for automatic placement or use `near`."),
    background_color: z.string().optional().describe(BG_COLOR_DESC),
    border_color: z.string().optional().describe(BORDER_COLOR_DESC),
    near: NEAR_SCHEMA.optional().describe(NEAR_DESC),
  }),
  run: async ({ id, title = "", body = "", x, y, background_color, border_color, near }, ctx) =>
    mutatorFor(ctx).createNote({ id, content: body, label: title, type: "rect", x, y, near: nearFor(near), colors: colorsFor(background_color, border_color) }),
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
  run: async ({ sourceId, targetId, label }, ctx) => {
    // Both endpoints must exist in the working folder (edges are layer-scoped) —
    // otherwise the edge would dangle at (0,0) on a phantom node. Fail clearly.
    // When the working folder is off-scene, check its layer, not the visible store.
    const board = mutatorFor(ctx)
    const bothExist =
      board instanceof HeadlessMutator
        ? (await board.hasNode(sourceId)) && (await board.hasNode(targetId))
        : !!ctx.store.getNode(asNodeId(sourceId)) && !!ctx.store.getNode(asNodeId(targetId))
    if (!bothExist) {
      return { error: "link_notes: source or target note not found in the current working folder." }
    }
    return board.createLink({ sourceId, targetId, label })
  },
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
    near: NEAR_SCHEMA.optional().describe(NEAR_DESC),
  }),
  run: async ({ content, label, note_type, note_id, background_color, border_color, near }, ctx) => {
    const board = mutatorFor(ctx)
    // Resolve existence in the WORKING folder (off-scene when navigated away), so a
    // rewrite / re-edit of a note in that folder — incl. one created this turn —
    // targets it instead of erroring or duplicating.
    const store = await workingLayerStore(ctx)
    const existing = note_id ? store.getNode(asNodeId(note_id)) : undefined
    // Validate a mini-app before persisting, so a malformed one is rejected with
    // line/col for the agent to fix this turn (not a silently-broken note). Key off
    // the RESULTING type: an explicit mini-app, OR a bare rewrite of an existing
    // mini-app (rewriteNote preserves the type when note_type is omitted).
    const willBeMiniApp = note_type === "mini-app" || (!note_type && existing?.type === "mini-app")
    if (willBeMiniApp) {
      const v = validateMiniAppSource(content)
      if (!v.ok) {
        return { error: `mini-app invalid: ${v.message}${v.line ? ` (line ${v.line}:${v.column})` : ""}` }
      }
    }

    const spec = { content, label, type: note_type, near: nearFor(near), colors: colorsFor(background_color, border_color) }
    if (note_id) {
      // In the working folder → full rewrite (NOT a creation; the turn won't
      // re-arrange/recenter it). Existing but in ANOTHER folder → refuse rather
      // than create a colliding duplicate (navigate there first). Nowhere → a
      // brand-new note with this explicit id.
      if (existing) return board.rewriteNote(note_id, spec)
      if (ctx.boardNotes?.get(note_id)) return { error: "That note is in another folder. Navigate into that folder before editing it." }
      return board.createNote({ ...spec, id: note_id })
    }
    return board.createNote(spec)
  },
})


// Cap the whole-view arrange so a huge board isn't mass-relocated / re-laid-out on
// the hot agent path in one shot. Prefer targeting a specific cluster via note_ids.
const MAX_ARRANGE = 60


export const arrangeNotes = defineTool({
  name: "arrange_notes",
  description:
    "Tidy notes into a clean auto-arranged layout, kept centered where they already sit. Prefer passing note_ids to arrange a specific cluster; omitting them re-lays-out the whole current board/folder (capped). Use after creating or editing notes that ended up cluttered or overlapping.",
  parameters: z.object({
    note_ids: z.array(z.string()).optional().describe("Ids of the notes to arrange (a cluster). Omit to arrange all notes in the current view."),
  }),
  run: async ({ note_ids }, ctx) => {
    // Arrange within the WORKING folder — the off-scene layer store when navigated
    // away — so tidying a subfolder never relocates the user's on-screen notes.
    const store = await workingLayerStore(ctx)
    const ids = note_ids && note_ids.length > 0 ? note_ids : store.getAllNodes().map((n) => String(n.id))
    if (ids.length > MAX_ARRANGE) {
      return { error: `Too many notes to arrange at once (${ids.length}). Pass a note_ids set for the specific cluster to tidy.` }
    }
    const arranged = await arrangeNodesInPlace(store, ids)
    return { arranged }
  },
})


export const navigate = defineTool({
  name: "navigate",
  description:
    "Set your working folder — like `cd`. Afterward, create_note / write_note / link_notes write INTO this folder without moving the user's on-screen view. Returns the folder's current notes, so it doubles as looking inside a folder. target: a folder node's id to enter it, \"root\" for the top level, or \"up\" for the parent folder.",
  parameters: z.object({
    target: z
      .string()
      .describe('A folder node id to enter, "root" for the top level, or "up" to go to the parent folder.'),
  }),
  run: async ({ target }, ctx) => {
    const nodes = ctx.boardNotes
    const current = ctx.rootId ?? null
    // Resolve a node across every place it might live: the current working-folder
    // store (a folder just created off-scene this turn), the visible store (one
    // created at the user's layer this turn), then the pre-turn whole-board
    // snapshot — so `navigate` can enter a folder `create_folder` just returned.
    const workingStore = ctx.board instanceof HeadlessMutator ? await ctx.board.layerStore() : ctx.store
    const lookup = (id: string): Node | undefined =>
      workingStore.getNode(asNodeId(id)) ?? ctx.store.getNode(asNodeId(id)) ?? nodes?.get(id)
    // Resolve the destination layer id (null = root).
    let dest: string | null
    if (target === "root") {
      dest = null
    } else if (target === "up") {
      const node = current ? lookup(current) : undefined
      dest = (node?.data as DimNodeData | undefined)?.parentId ?? null
    } else {
      const node = lookup(target)
      if (!node) return { error: `navigate: no node with id ${target}` }
      if (node.type !== "folder") return { error: `navigate: ${target} is not a folder` }
      dest = target
    }
    // Switch the working folder + write routing. Release any prior off-scene
    // session, then pick store (dest is the visible layer → renders) vs headless.
    if (ctx.board instanceof HeadlessMutator) ctx.board.dispose()
    ctx.rootId = dest
    const sceneRoot = ctx.sceneRootId ?? null
    ctx.board =
      dest === sceneRoot ? new StoreMutator(ctx.store, dest) : new HeadlessMutator(ctx.store, dest)
    // ls: the destination layer's notes from the whole-board snapshot (may lag
    // this turn's own writes into the same folder).
    const notes = [...(nodes?.values() ?? [])]
      .filter((n) => ((n.data as DimNodeData | undefined)?.parentId ?? null) === dest)
      .map((n) => ({
        id: String(n.id),
        title: labelText((n.data as DimNodeData | undefined)?.label),
        type: n.type,
      }))
    const label = dest
      ? labelText((nodes?.get(dest)?.data as DimNodeData | undefined)?.label) || "Folder"
      : "root"
    return { working_folder: dest ?? "root", label, note_count: notes.length, notes }
  },
})


export const createFolder = defineTool({
  name: "create_folder",
  description:
    "Create a folder (a nested sub-board) in your current working folder. Returns its id. Typical flow: create_folder → navigate(folder_id) → author notes inside → navigate(\"up\"). The folder appears in the user's view when created at their current layer.",
  parameters: z.object({
    label: z.string().describe("The folder's name."),
  }),
  run: async ({ label }, ctx) => {
    // Same nesting cap as the folder tool: root(0) → child(1) → grandchild(2); a
    // 4th level isn't allowed. Depth = the working folder's distance from root.
    const nodes = [...(ctx.boardNotes?.values() ?? [])] as unknown as DimNode[]
    const depth = buildLayerPath(nodes, ctx.rootId ?? null).length
    if (!canCreateSubBoard(depth)) {
      return { error: `Maximum folder nesting depth reached (${MAX_BOARD_DEPTH + 1} levels).` }
    }
    const { id } = await mutatorFor(ctx).createFolder(label)
    return { folder_id: id, label }
  },
})


export const getNote = defineTool({
  name: "get_note",
  description: "Read an existing note's label, content, and type.",
  parameters: z.object({
    note_id: z.string().describe("Id of the note to read."),
  }),
  run: async ({ note_id }, ctx) => {
    // Working folder first (its notes, incl. ones authored this turn off-scene),
    // then the whole-board snapshot so a cross-folder id (e.g. from search_notes)
    // is still readable.
    const store = await workingLayerStore(ctx)
    const node = store.getNode(asNodeId(note_id)) ?? ctx.boardNotes?.get(note_id)
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
    // Edit within the working folder (off-scene when navigated away).
    const store = await workingLayerStore(ctx)
    const node = store.getNode(asNodeId(note_id))
    if (!node) {
      // A cross-folder note (resolvable whole-board but not in this working folder)
      // can't be edited from here — say so, consistent with write_note.
      return ctx.boardNotes?.get(note_id)
        ? { error: "That note is in another folder. Navigate into that folder before editing it." }
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
export const agentBuildTools: Tool[] = [writeNote, editNote, getNote, linkNotes, arrangeNotes, navigate, createFolder]
