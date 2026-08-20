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
import { asEdgeId, asNodeId } from "@canvas-harness/core"
import type { Node } from "@canvas-harness/core"
import type { DimEdgeData, DimNodeData } from "@/features/board/model"
import { labelText } from "@/features/board/model"
import { pickRandomColorOfShade } from "@/features/board/lib/colors/tailwind"
import { AUTOFIT_DISABLED_TYPES } from "@/features/board/harness/convert/note-to-node"
import { dim0LinkStyleToCanvas, dim0StyleToCanvas } from "@/features/board/harness/convert/style"
import {
  adaptEdgeColors,
  adaptNodeColors,
  applyColorsToEdgeStyle,
  applyColorsToStyle,
  pickStoredEdgeColors,
  type StoredColors,
  type StoredEdgeColors,
} from "@/features/board/harness/theme/color-adapter"
import { getBoardThemeMode } from "@/features/board/harness/theme/theme-mode-ref"
import { createDefaultLinkStyle, createDefaultStyle } from "@/features/board/types/style"
import { beneathBorderOrigin } from "@/features/board/harness/agent/beneath-border"
import { validateMiniAppSource } from "@/features/mini-app/validate"
import { defineTool } from "./types"
import type { Tool, ToolContext } from "./types"
import { estimateNoteSize } from "./note-size"
import type { MemoryKind, MemoryScope } from "@/features/board/persist/local/idb"


/**
 * A random Tailwind-200 fill per note (mirrors the backend's
 * `random.choice(TAILWIND_200_ADAPTED)` in notes/service.py). Stored as
 * `_storedColors` so the harness theme hooks project the display style for the
 * current mode — without this, agent notes render with the lib's non-theme-aware
 * default (always light). Black text reads on every light-200 swatch; the dark
 * variant is derived on theme flip.
 */
const randomNoteColors = (): StoredColors => ({
  backgroundColor: pickRandomColorOfShade(200)?.hex ?? "#dbeafe",
  strokeColor: "#00000000",
  textColor: "#000000",
})


// Default box size per canvas node type (mirrors backend get_default_note_size).
const DEFAULT_SIZE: Record<string, { w: number; h: number }> = {
  rect: { w: 320, h: 180 },
  ellipse: { w: 320, h: 320 },
  diamond: { w: 340, h: 340 },
  sheet: { w: 440, h: 440 },
  "mini-app": { w: 720, h: 440 },
  widget: { w: 480, h: 320 },
  "code-sandbox": { w: 560, h: 360 },
}


/** Content-fit size for a note, falling back to the type's default box. */
const noteGeometry = (nodeType: string, content: string): { w: number; h: number } => {
  const base = DEFAULT_SIZE[nodeType] ?? { w: 320, h: 180 }
  const fitted = estimateNoteSize(nodeType, base.w, content)
  return fitted ? { w: fitted.width, h: fitted.height } : base
}


/** Fresh SyncMeta stamp for a created/updated entity. */
const meta = (): DimNodeData["meta"] => {
  const t = Date.now()
  return { v: 1, createdAt: t, updatedAt: t }
}


/**
 * Canonical canvas style for a live-created rectangle / edge — mirrors the
 * convert layer (`noteToNode` / `linkToEdge`) so a freshly inserted object
 * renders identically to its reloaded / peer-synced form. Without it the harness
 * paints with its own library defaults (rounded corners, extra roughness), so
 * the live board drifted from the persisted one until reload. Keep the field
 * logic in sync with note-to-node.ts / link-to-edge.ts.
 */
const canonicalNodeStyle = (colors: StoredColors) => {
  const base = dim0StyleToCanvas(createDefaultStyle({ type: "rectangle" }))
  const mode = getBoardThemeMode()
  const display = mode === "dark" ? adaptNodeColors(colors, "dark") : colors
  return applyColorsToStyle(base, display)
}


/**
 * Canonical edge `style` (theme-adapted for display) plus the canonical
 * light-space `_storedColors` that must ride on `data` — mirrors `linkToEdge`.
 * The stored colors are the source of truth on save; without them `edgeToLink`
 * would persist the dark-adapted display hex as canonical and corrupt the color
 * for a light-mode peer / on reload.
 */
const canonicalEdge = (): { style: ReturnType<typeof dim0LinkStyleToCanvas>; storedColors: StoredEdgeColors } => {
  const base = dim0LinkStyleToCanvas(createDefaultLinkStyle())
  const storedColors = pickStoredEdgeColors(base)
  const mode = getBoardThemeMode()
  const style = mode === "light" ? base : applyColorsToEdgeStyle(base, adaptEdgeColors(storedColors, mode))
  return { style, storedColors }
}


// Map a prompt-level note_type to a canvas node type. Shapes the agent can't
// render distinctly (ellipse/diamond) fall back to the default rectangle.
const NODE_TYPE: Record<string, string> = {
  rectangle: "rect",
  rect: "rect",
  sheet: "sheet",
  "mini-app": "mini-app",
  widget: "widget",
  "code-sandbox": "code-sandbox",
}
const toNodeType = (t: string): string => NODE_TYPE[t] ?? "rect"


/**
 * Resolve a note by id across the WHOLE board: the layer-scoped `store` (freshest,
 * for the current folder's live edits) first, then the per-turn whole-board
 * `boardNotes` snapshot for notes in other folders. Without the fallback,
 * search_notes / get_note can't read a cross-folder hit.
 */
const resolveBoardNode = (ctx: ToolContext, id: string): Node | undefined =>
  ctx.store.getNode(asNodeId(id)) ?? ctx.boardNotes?.get(id)


export const createNote = defineTool({
  name: "create_note",
  description: "Create a note on the board with a title and optional body.",
  parameters: z.object({
    id: z.string().optional().describe("Optional explicit id; omit to auto-generate."),
    title: z.string().optional().describe("Short note title (the heading, stored separately from the body)."),
    body: z.string().optional().describe("The note body — prose or markdown."),
    x: z.number().optional().describe("Optional x canvas position; defaults beneath existing content (auto-arranged after the turn)."),
    y: z.number().optional().describe("Optional y canvas position; defaults beneath existing content (auto-arranged after the turn)."),
  }),
  run: async ({ id, title = "", body = "", x, y }, ctx) => {
    const nodeId = asNodeId(id || ctx.store.generateId())
    const { w, h } = noteGeometry("rect", body)
    // Default new notes beneath the current graph border (mirrors the backend's
    // compute_note_position); explicit coords from the model still win.
    const origin = beneathBorderOrigin(ctx.store)
    const storedColors = randomNoteColors()
    ctx.store.batch(() => {
      ctx.store.addNode({
        id: nodeId,
        type: "rect",
        x: x ?? origin.x,
        y: y ?? origin.y,
        w,
        h,
        angle: 0,
        groups: [],
        content: body,
        style: canonicalNodeStyle(storedColors),
        data: { label: { markdown: title }, parentId: ctx.rootId ?? undefined, meta: meta(), _storedColors: storedColors } satisfies DimNodeData,
      })
    })
    return { id: String(nodeId), created: true }
  },
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
    const nid = asNodeId(id)
    const node = ctx.store.getNode(nid)
    if (!node) return { error: "note not found" }

    const patch: Partial<Node> = {}
    if (typeof body === "string") patch.content = body
    if (typeof title === "string") {
      patch.data = { ...(node.data as DimNodeData | undefined), label: { markdown: title }, meta: meta() }
    }
    ctx.store.batch(() => ctx.store.updateNode(nid, patch))
    return { id: String(nid) }
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
    const id = asEdgeId(ctx.store.generateId())
    const src = asNodeId(sourceId)
    const tgt = asNodeId(targetId)
    // Attach at each node's CENTER (local frame is from top-left). canvas-harness
    // auto-clips the center→center line to each node's border, so the endpoint
    // lands at the border facing the peer — the backend's _edge_anchor_offset,
    // for free, and it re-clips live as `arrangeCreatedNodes` moves the nodes.
    const center = (nodeId: typeof src): { x: number; y: number } => {
      const node = ctx.store.getNode(nodeId)
      return node ? { x: node.w / 2, y: node.h / 2 } : { x: 0, y: 0 }
    }
    // Canonical edge style (arrowhead, stroke, roughness) so the live edge
    // matches its reloaded form — the lib default is otherwise rougher — plus the
    // canonical stored colors so a dark-mode edge saves the right (light) color.
    const { style, storedColors } = canonicalEdge()
    ctx.store.batch(() => {
      ctx.store.addEdge({
        id,
        source: { nodeId: src, localOffset: center(src) },
        target: { nodeId: tgt, localOffset: center(tgt) },
        pathStyle: "bezier",
        groups: [],
        style,
        data: {
          label: label || undefined,
          parentId: ctx.rootId ?? undefined,
          meta: meta(),
          _storedColors: storedColors,
        } satisfies DimEdgeData,
      })
    })
    return { id: String(id) }
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
  }),
  run: async ({ content, label, note_type, note_id }, ctx) => {
    const nodeType = toNodeType(note_type ?? "")

    // Custom types render only a preview of `content`, so disable the lib's
    // grow-to-fit AT CREATION (mirrors backend note_to_wire_node). Setting it
    // here — not just via the reactive stamp hook — means the node is born with
    // autoFit off and the lib never grows it before the flag lands.
    const autoFitStyle = AUTOFIT_DISABLED_TYPES.has(nodeType) ? { autoFit: false } : undefined

    // Validate a mini-app before persisting, so a malformed one is rejected with
    // line/col for the agent to fix this turn (not a silently-broken note).
    if (nodeType === "mini-app") {
      const v = validateMiniAppSource(content)
      if (!v.ok) {
        return { error: `mini-app invalid: ${v.message}${v.line ? ` (line ${v.line}:${v.column})` : ""}` }
      }
    }

    if (note_id) {
      const id = asNodeId(note_id)
      const node = ctx.store.getNode(id)
      if (node) {
        const prev = node.data as DimNodeData | undefined
        ctx.store.batch(() =>
          ctx.store.updateNode(id, {
            type: nodeType,
            content,
            data: { ...prev, label: label ? { markdown: label } : (prev?.label ?? { markdown: "" }), meta: meta() },
            ...(autoFitStyle ? { style: { ...(node.style ?? {}), ...autoFitStyle } } : {}),
          }),
        )
        // Rewrote an existing (user-placed) note — NOT a creation, so the turn
        // must not re-arrange or recenter it.
        return { id: String(id), created: false }
      }
    }

    const id = asNodeId(note_id || ctx.store.generateId())
    const { w, h } = noteGeometry(nodeType, content)
    // Born beneath the current graph border (mirrors the backend's
    // compute_note_position); a multi-note turn is re-laid-out afterward.
    const origin = beneathBorderOrigin(ctx.store)
    const storedColors = randomNoteColors()
    // Plain rectangles are painted by the lib from `style`, so give them the same
    // canonical style the convert layer would (else the live render uses the lib's
    // rounded/rough defaults until reload). Custom types paint via their own
    // node-type view, so they only need autoFit disabled at birth.
    const style = nodeType === "rect"
      ? { ...canonicalNodeStyle(storedColors), ...(autoFitStyle ?? {}) }
      : autoFitStyle
    ctx.store.batch(() => {
      ctx.store.addNode({
        id,
        type: nodeType,
        x: origin.x,
        y: origin.y,
        w,
        h,
        angle: 0,
        groups: [],
        content,
        ...(style ? { style } : {}),
        data: { label: { markdown: label ?? "" }, parentId: ctx.rootId ?? undefined, meta: meta(), _storedColors: storedColors } satisfies DimNodeData,
      })
    })
    return { id: String(id), created: true }
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
    const id = asNodeId(note_id)
    const node = ctx.store.getNode(id)
    if (!node) return { error: "note not found" }

    const prev = node.data as DimNodeData | undefined
    const current = field === "label" ? labelText(prev?.label) : node.content ?? ""

    const occurrences = old ? current.split(old).length - 1 : 0
    if (occurrences === 0) return { error: "`old` not found in field" }
    if (occurrences > 1 && replace_all !== true) {
      return { error: "`old` occurs multiple times; expand it for uniqueness or set replace_all" }
    }
    const updated = replace_all === true ? current.split(old).join(replacement) : current.replace(old, replacement)

    ctx.store.batch(() =>
      field === "label"
        ? ctx.store.updateNode(id, { data: { ...prev, label: { markdown: updated }, meta: meta() } })
        : ctx.store.updateNode(id, { content: updated }),
    )
    return { id: String(id) }
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
    const results = ids.map((id) => {
      // Resolve whole-board: a cross-folder hit isn't in the layer-scoped store.
      const node = resolveBoardNode(ctx, id)
      // Title is `data.label`; the body lives in the native `node.content`.
      const title = labelText((node?.data as DimNodeData | undefined)?.label)
      const content = asText(node?.content).slice(0, SEARCH_SNIPPET_CHARS)
      return { id, title, content }
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
