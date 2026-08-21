import { beforeEach, describe, expect, it } from "vitest"
import { asNodeId } from "@canvas-harness/core"
import type { CanvasStore, Node } from "@canvas-harness/core"
import { freshStore, resetIdb } from "@/test/canvas"
import type { DimEdgeData, DimNodeData } from "@/features/board/model"
import { labelText } from "@/features/board/model"
import { setBoardThemeMode } from "@/features/board/harness/theme/theme-mode-ref"
import { LocalSearchIndex } from "@/features/board/search/local-index"
import type { BoardRegistry } from "@/features/board/persist/local/board-registry"
import type { ToolContext } from "./types"
import { InMemoryEngine } from "@/features/board/persist/local/in-memory-engine"
import { MemoryRepo } from "@/features/board/persist/local/memory-repo"
import {
  createNote,
  updateNote,
  linkNotes,
  writeNote,
  getNote,
  editNote,
  searchNotes,
  listBoards,
  saveMemory,
  updateMemory,
  deleteMemory,
  recallMemory,
} from "./tools"


// A LocalSearchIndex that returns a fixed id list (we test the id→result mapping,
// not Orama ranking).
const fakeSearch = (ids: string[]): LocalSearchIndex =>
  ({ query: async () => ids }) as unknown as LocalSearchIndex


const fakeRegistry = (boards: { id: string; title: string }[]): BoardRegistry =>
  ({ listBoards: async () => boards }) as unknown as BoardRegistry


// Read helpers over the real store.
const label = (store: CanvasStore, id: string): string =>
  labelText((store.getNode(asNodeId(id))?.data as DimNodeData | undefined)?.label)
const parentOf = (store: CanvasStore, id: string): unknown =>
  (store.getNode(asNodeId(id))?.data as DimNodeData | undefined)?.parentId
const body = (store: CanvasStore, id: string): string | undefined => store.getNode(asNodeId(id))?.content


// Seed a rect node with a known label + content, bypassing the tools.
const seed = (store: CanvasStore, id: string, opts: { label?: string; content?: string } = {}): void => {
  store.addNode({
    id: asNodeId(id),
    type: "rect",
    x: 0, y: 0, w: 100, h: 50, angle: 0, groups: [],
    content: opts.content ?? "",
    data: { label: { markdown: opts.label ?? "" }, meta: { v: 1, createdAt: 0, updatedAt: 0 } } satisfies DimNodeData,
  })
}


let store: CanvasStore
let ctx: ToolContext


beforeEach(() => {
  resetIdb()
  store = freshStore("c")
  ctx = { store, rootId: null }
})


describe("createNote", () => {
  it("creates a rect node carrying title + body and returns {id, created}", async () => {
    const res = (await createNote.run({ title: "Cap", body: "Lima" }, ctx)) as { id: string; created: boolean }
    expect(res.created).toBe(true)
    const node = store.getNode(asNodeId(res.id))
    expect(node?.type).toBe("rect")
    expect(label(store, res.id)).toBe("Cap")
    expect(body(store, res.id)).toBe("Lima")
  })

  it("honors an explicit id and explicit x/y", async () => {
    const res = (await createNote.run({ id: "n1", title: "T", x: 42, y: 7 }, ctx)) as { id: string }
    expect(res.id).toBe("n1")
    expect(store.getNode(asNodeId("n1"))!.x).toBe(42)
    expect(store.getNode(asNodeId("n1"))!.y).toBe(7)
  })

  it("auto-generates an id when none is given", async () => {
    const res = (await createNote.run({ title: "T" }, ctx)) as { id: string }
    expect(res.id).toBeTruthy()
    expect(store.getNode(asNodeId(res.id))).toBeDefined()
  })

  it("stamps the current rootId as parentId", async () => {
    ctx = { store, rootId: "folder-1" }
    const res = (await createNote.run({ title: "T" }, ctx)) as { id: string }
    expect(parentOf(store, res.id)).toBe("folder-1")
  })

  it("has no parentId at the root layer (rootId null)", async () => {
    const res = (await createNote.run({ title: "T" }, { store, rootId: null })) as { id: string }
    expect(parentOf(store, res.id)).toBeUndefined()
  })

  it("gives the note a stored color triplet (theme-projectable)", async () => {
    const res = (await createNote.run({ title: "T" }, ctx)) as { id: string }
    const stored = (store.getNode(asNodeId(res.id))?.data as DimNodeData)._storedColors
    expect(stored?.backgroundColor).toBeTruthy()
  })

  it("stamps a canonical style so the live render matches the reloaded one", async () => {
    // Regression: a live rect with no `style` fell back to the lib's rounded
    // defaults, then snapped square on reload. The convert layer sets roundness 0.
    const res = (await createNote.run({ title: "T" }, ctx)) as { id: string }
    const style = store.getNode(asNodeId(res.id))?.style
    expect(style?.roundness).toBe(0)
    // Fill mirrors the stored color the note was born with.
    const stored = (store.getNode(asNodeId(res.id))?.data as DimNodeData)._storedColors
    expect(style?.backgroundColor).toBe(stored?.backgroundColor)
  })

  it("is a single undoable batch (INV-8)", async () => {
    const res = (await createNote.run({ title: "T" }, ctx)) as { id: string }
    expect(store.getNode(asNodeId(res.id))).toBeDefined()
    store.undo()
    expect(store.getNode(asNodeId(res.id))).toBeUndefined()
  })

  it("defaults title/body to empty strings when omitted", async () => {
    const res = (await createNote.run({}, ctx)) as { id: string }
    expect(label(store, res.id)).toBe("")
    expect(body(store, res.id)).toBe("")
  })
})


describe("updateNote", () => {
  it("updates title and body", async () => {
    seed(store, "n1", { label: "old", content: "oldbody" })
    await updateNote.run({ id: "n1", title: "new", body: "newbody" }, ctx)
    expect(label(store, "n1")).toBe("new")
    expect(body(store, "n1")).toBe("newbody")
  })

  it("leaves title unchanged when only body is given", async () => {
    seed(store, "n1", { label: "keep", content: "old" })
    await updateNote.run({ id: "n1", body: "changed" }, ctx)
    expect(label(store, "n1")).toBe("keep")
    expect(body(store, "n1")).toBe("changed")
  })

  it("leaves body unchanged when only title is given", async () => {
    seed(store, "n1", { label: "old", content: "keepbody" })
    await updateNote.run({ id: "n1", title: "changed" }, ctx)
    expect(label(store, "n1")).toBe("changed")
    expect(body(store, "n1")).toBe("keepbody")
  })

  it("returns an error for a missing note", async () => {
    expect(await updateNote.run({ id: "ghost", title: "x" }, ctx)).toEqual({ error: "note not found" })
  })
})


describe("linkNotes", () => {
  it("adds a directed edge between two notes, anchored at their centers", async () => {
    seed(store, "a")
    seed(store, "b")
    const res = (await linkNotes.run({ sourceId: "a", targetId: "b", label: "then" }, ctx)) as { id: string }
    const edges = store.getAllEdges()
    expect(edges).toHaveLength(1)
    const e = edges[0]
    // The tool always creates node-attached ends ({ nodeId, localOffset }).
    const src = e.source as { nodeId: string; localOffset: { x: number; y: number } }
    const tgt = e.target as { nodeId: string }
    expect(String(e.id)).toBe(res.id)
    expect(String(src.nodeId)).toBe("a")
    expect(String(tgt.nodeId)).toBe("b")
    // seeded nodes are 100x50 → center offset 50,25
    expect(src.localOffset).toEqual({ x: 50, y: 25 })
    expect((e.data as { label?: string }).label).toBe("then")
  })

  it("omits the edge label when none is given", async () => {
    seed(store, "a")
    seed(store, "b")
    await linkNotes.run({ sourceId: "a", targetId: "b" }, ctx)
    expect((store.getAllEdges()[0].data as { label?: string }).label).toBeUndefined()
  })

  it("stamps the current rootId as the edge parentId", async () => {
    seed(store, "a")
    seed(store, "b")
    ctx = { store, rootId: "folder-1" }
    await linkNotes.run({ sourceId: "a", targetId: "b" }, ctx)
    expect((store.getAllEdges()[0].data as { parentId?: string }).parentId).toBe("folder-1")
  })

  it("stamps a canonical edge style so the live edge matches the reloaded one", async () => {
    // Regression: a live edge with no `style` fell back to the lib defaults and
    // looked rougher until reload. The convert layer sets a filled arrowhead.
    seed(store, "a")
    seed(store, "b")
    await linkNotes.run({ sourceId: "a", targetId: "b" }, ctx)
    const edge = store.getAllEdges()[0]
    expect(edge.style?.targetArrowhead).toBe("arrow-filled")
    expect(edge.pathStyle).toBe("bezier")
  })

  it("stores canonical (theme-independent) edge colors so save round-trips across themes", async () => {
    // Regression: without _storedColors, a dark-mode edge persisted the
    // dark-adapted display hex as canonical and rendered wrong for a light peer.
    seed(store, "a")
    seed(store, "b")
    seed(store, "c")
    seed(store, "d")
    try {
      setBoardThemeMode("light")
      const r1 = (await linkNotes.run({ sourceId: "a", targetId: "b" }, ctx)) as { id: string }
      setBoardThemeMode("dark")
      const r2 = (await linkNotes.run({ sourceId: "c", targetId: "d" }, ctx)) as { id: string }
      const edges = store.getAllEdges()
      const light = edges.find((e) => String(e.id) === r1.id)!
      const dark = edges.find((e) => String(e.id) === r2.id)!
      const lightStored = (light.data as DimEdgeData)._storedColors?.strokeColor
      const darkStored = (dark.data as DimEdgeData)._storedColors?.strokeColor
      // Stored colors are the canonical source of truth — identical in both modes.
      expect(darkStored).toBe(lightStored)
      // But the dark edge's DISPLAY style is adapted away from the canonical value.
      expect(dark.style?.strokeColor).not.toBe(darkStored)
    } finally {
      setBoardThemeMode("light")
    }
  })
})


describe("writeNote", () => {
  it("creates a new note (no note_id) and maps note_type to a canvas type", async () => {
    const res = (await writeNote.run({ content: "body", label: "T", note_type: "rectangle" }, ctx)) as { id: string; created: boolean }
    expect(res.created).toBe(true)
    expect(store.getNode(asNodeId(res.id))?.type).toBe("rect")
    expect(body(store, res.id)).toBe("body")
  })

  it("falls back to rect for an unknown note_type", async () => {
    const res = (await writeNote.run({ content: "b", note_type: "bogus" }, ctx)) as { id: string }
    expect(store.getNode(asNodeId(res.id))?.type).toBe("rect")
  })

  it("disables autoFit for custom types (sheet) but not for rect", async () => {
    const sheet = (await writeNote.run({ content: "b", note_type: "sheet" }, ctx)) as { id: string }
    expect((store.getNode(asNodeId(sheet.id))?.style as { autoFit?: boolean } | undefined)?.autoFit).toBe(false)
    const rect = (await writeNote.run({ content: "b", note_type: "rectangle" }, ctx)) as { id: string }
    expect((store.getNode(asNodeId(rect.id))?.style as { autoFit?: boolean } | undefined)?.autoFit).not.toBe(false)
  })

  it("rewrites an existing note in place (created:false), preserving label when omitted", async () => {
    seed(store, "n1", { label: "keep", content: "old" })
    const res = (await writeNote.run({ content: "new", note_id: "n1" }, ctx)) as { id: string; created: boolean }
    expect(res).toEqual({ id: "n1", created: false })
    expect(body(store, "n1")).toBe("new")
    expect(label(store, "n1")).toBe("keep") // label omitted → previous kept
  })

  it("rewrite keeps the note's existing layer and position (doesn't move it)", async () => {
    // Create in folder-A at a fixed spot, then rewrite while standing in folder-B.
    const made = (await createNote.run({ title: "Orig", x: 500, y: 700 }, { store, rootId: "folder-A" })) as { id: string }
    const res = (await writeNote.run({ note_id: made.id, content: "new" }, { store, rootId: "folder-B" })) as { created: boolean }
    expect(res.created).toBe(false) // excluded from createdNodeIds → not re-arranged/recentered
    expect(parentOf(store, made.id)).toBe("folder-A") // layer unchanged
    const node = store.getNode(asNodeId(made.id))!
    expect({ x: node.x, y: node.y }).toEqual({ x: 500, y: 700 }) // unmoved
  })

  it("stamps the current rootId as parentId for a NEW note", async () => {
    const res = (await writeNote.run({ content: "b" }, { store, rootId: "folder-2" })) as { id: string }
    expect(parentOf(store, res.id)).toBe("folder-2")
  })

  it("creates a note with the given id when note_id doesn't exist yet", async () => {
    const res = (await writeNote.run({ content: "b", note_id: "brand-new" }, ctx)) as { id: string; created: boolean }
    expect(res).toEqual({ id: "brand-new", created: true })
    expect(store.getNode(asNodeId("brand-new"))).toBeDefined()
  })

  it("rejects an invalid mini-app without creating a node", async () => {
    const before = store.getAllNodes().length
    const res = (await writeNote.run({ content: "const x = 1", note_type: "mini-app" }, ctx)) as { error?: string }
    expect(res.error).toMatch(/mini-app invalid/)
    expect(store.getAllNodes().length).toBe(before)
  })

  it("accepts a valid mini-app", async () => {
    const res = (await writeNote.run(
      { content: "function Widget() { return <div>hi</div> }", note_type: "mini-app" },
      ctx,
    )) as { id?: string; error?: string }
    expect(res.error).toBeUndefined()
    expect(store.getNode(asNodeId(res.id!))?.type).toBe("mini-app")
  })
})


describe("getNote", () => {
  it("reads label, content, and type", async () => {
    seed(store, "n1", { label: "T", content: "body" })
    expect(await getNote.run({ note_id: "n1" }, ctx)).toEqual({
      id: "n1",
      label: "T",
      content: "body",
      note_type: "rect",
    })
  })

  it("returns an error for a missing note", async () => {
    expect(await getNote.run({ note_id: "ghost" }, ctx)).toEqual({ error: "note not found" })
  })

  it("reads a cross-folder note via boardNotes (not in the layer-scoped store)", async () => {
    const other = {
      id: asNodeId("other"), type: "rect", x: 0, y: 0, w: 100, h: 50, angle: 0, z: 0, groups: [],
      content: "body in another folder", data: { label: { markdown: "Elsewhere" }, meta: { v: 1, createdAt: 0, updatedAt: 0 } },
    } as unknown as Node
    const c = { store, rootId: null, boardNotes: new Map([["other", other]]) } as unknown as ToolContext
    expect(await getNote.run({ note_id: "other" }, c)).toEqual({
      id: "other", label: "Elsewhere", content: "body in another folder", note_type: "rect",
    })
  })

  it("returns the label as a plain string for both RichText and legacy-string labels", async () => {
    // RichText (production shape) — must be unwrapped to a string, not the object.
    seed(store, "rich", { label: "Rich Title", content: "b" })
    expect((await getNote.run({ note_id: "rich" }, ctx) as { label: string }).label).toBe("Rich Title")
    // Legacy bare-string label (older local board) — tolerated by labelText.
    store.addNode({
      id: asNodeId("legacy"), type: "rect", x: 0, y: 0, w: 100, h: 50, angle: 0, groups: [],
      data: { label: "Legacy Title" as unknown as { markdown: string }, meta: { v: 1, createdAt: 0, updatedAt: 0 } },
    })
    expect((await getNote.run({ note_id: "legacy" }, ctx) as { label: string }).label).toBe("Legacy Title")
  })
})


describe("editNote", () => {
  it("replaces a unique substring in content", async () => {
    seed(store, "n1", { content: "the quick brown fox" })
    const res = await editNote.run({ note_id: "n1", field: "content", old: "quick", new: "slow" }, ctx)
    expect(res).toEqual({ id: "n1" })
    expect(body(store, "n1")).toBe("the slow brown fox")
  })

  it("replaces in the label field", async () => {
    seed(store, "n1", { label: "draft report" })
    await editNote.run({ note_id: "n1", field: "label", old: "draft", new: "final" }, ctx)
    expect(label(store, "n1")).toBe("final report")
  })

  it("errors when `old` is not found", async () => {
    seed(store, "n1", { content: "abc" })
    expect(await editNote.run({ note_id: "n1", field: "content", old: "zzz", new: "x" }, ctx)).toEqual({
      error: "`old` not found in field",
    })
  })

  it("errors on a non-unique `old` unless replace_all is set", async () => {
    seed(store, "n1", { content: "a a a" })
    const res = (await editNote.run({ note_id: "n1", field: "content", old: "a", new: "b" }, ctx)) as { error?: string }
    expect(res.error).toMatch(/occurs multiple times/)
    expect(body(store, "n1")).toBe("a a a") // unchanged
  })

  it("replaces every occurrence with replace_all", async () => {
    seed(store, "n1", { content: "a a a" })
    await editNote.run({ note_id: "n1", field: "content", old: "a", new: "b", replace_all: true }, ctx)
    expect(body(store, "n1")).toBe("b b b")
  })

  it("returns an error for a missing note", async () => {
    expect(await editNote.run({ note_id: "ghost", field: "content", old: "x", new: "y" }, ctx)).toEqual({
      error: "note not found",
    })
  })
})


describe("searchNotes", () => {
  it("returns [] when no search index is wired", async () => {
    expect(await searchNotes.run({ query: "x" }, { store, rootId: null })).toEqual({ results: [] })
  })

  it("maps hit ids to {id, title, content, parentId} from the store", async () => {
    seed(store, "n1", { label: "Title one", content: "body one" })
    ctx = { store, rootId: null, search: fakeSearch(["n1"]) }
    expect(await searchNotes.run({ query: "one" }, ctx)).toEqual({
      results: [{ id: "n1", title: "Title one", content: "body one", parentId: null }],
    })
  })

  it("caps the content snippet at 600 chars", async () => {
    seed(store, "n1", { content: "x".repeat(1000) })
    ctx = { store, rootId: null, search: fakeSearch(["n1"]) }
    const res = (await searchNotes.run({ query: "x" }, ctx)) as { results: { content: string }[] }
    expect(res.results[0].content.length).toBe(600)
  })

  it("caps the number of hits at 8", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `n${i}`)
    ids.forEach((id) => seed(store, id, { content: id }))
    ctx = { store, rootId: null, search: fakeSearch(ids) }
    const res = (await searchNotes.run({ query: "n" }, ctx)) as { results: unknown[] }
    expect(res.results).toHaveLength(8)
  })

  it("drops a stale hit whose node no longer resolves (no phantom empty citation)", async () => {
    ctx = { store, rootId: null, search: fakeSearch(["missing"]) }
    expect(await searchNotes.run({ query: "x" }, ctx)).toEqual({ results: [] })
  })

  it("resolves a cross-folder hit via boardNotes (absent from the layer-scoped store)", async () => {
    // The note lives in another folder → not in the store; the whole-board map has it.
    const other = {
      id: asNodeId("other"), type: "rect", x: 0, y: 0, w: 100, h: 50, angle: 0, z: 0, groups: [],
      content: "cross folder body", data: { label: { markdown: "Other Folder Note" }, meta: { v: 1, createdAt: 0, updatedAt: 0 } },
    } as unknown as Node
    ctx = { store, rootId: null, search: fakeSearch(["other"]), boardNotes: new Map([["other", other]]) }
    expect(await searchNotes.run({ query: "cross" }, ctx)).toEqual({
      results: [{ id: "other", title: "Other Folder Note", content: "cross folder body", parentId: null }],
    })
  })

  it("finds notes by title/body via a REAL attached index (integration)", async () => {
    const index = new LocalSearchIndex()
    const detach = index.attach(store)
    const realCtx: ToolContext = { store, rootId: null, search: index }
    await createNote.run({ title: "Quarterly revenue", body: "growth numbers" }, realCtx)
    await createNote.run({ title: "Lunch menu", body: "tacos and salsa" }, realCtx)
    await index.idle() // let incremental indexing settle

    const { results } = (await searchNotes.run({ query: "revenue" }, realCtx)) as {
      results: { title: string }[]
    }
    expect(results.map((r) => r.title)).toContain("Quarterly revenue")
    expect(results.map((r) => r.title)).not.toContain("Lunch menu")
    detach()
  })
})


describe("listBoards", () => {
  it("returns [] when no registry is wired", async () => {
    expect(await listBoards.run({}, { store, rootId: null })).toEqual({ boards: [] })
  })

  it("maps the registry's boards to {id, title}", async () => {
    ctx = { store, rootId: null, registry: fakeRegistry([{ id: "b1", title: "Board 1" }]) }
    expect(await listBoards.run({}, ctx)).toEqual({ boards: [{ id: "b1", title: "Board 1" }] })
  })
})


describe("defineTool argument validation", () => {
  it("rejects a wrong-typed argument with a structured error (no throw)", async () => {
    const res = (await createNote.run({ x: "not-a-number" }, ctx)) as { error?: string }
    expect(res.error).toMatch(/invalid arguments/)
  })

  it("rejects an out-of-enum field for edit_note", async () => {
    const res = (await editNote.run({ note_id: "n1", field: "bogus", old: "a", new: "b" }, ctx)) as { error?: string }
    expect(res.error).toMatch(/invalid arguments/)
  })

  it("rejects a missing required argument", async () => {
    const res = (await linkNotes.run({ sourceId: "a" }, ctx)) as { error?: string }
    expect(res.error).toMatch(/invalid arguments/)
  })
})


describe("memory tools", () => {
  let memory: MemoryRepo
  let ctx: ToolContext


  beforeEach(() => {
    memory = new MemoryRepo(new InMemoryEngine())
    ctx = { boardId: "board-1", memory } as unknown as ToolContext
  })


  const save = (over: Record<string, unknown> = {}) =>
    saveMemory.run({ scope: "board", kind: "project", title: "t", summary: "s", body: "a durable fact", ...over }, ctx)


  it("saves a board memory bound to the context board (not a model-supplied one)", async () => {
    const res = (await save({ body: "board fact" })) as { ok: boolean; id: string }
    expect(res.ok).toBe(true)
    const list = await memory.list("board", "board-1")
    expect(list).toHaveLength(1)
    expect(list[0].boardId).toBe("board-1")
    expect(list[0].scope).toBe("board")
  })


  it("routes scope 'global' to the global bucket with boardId null", async () => {
    await save({ scope: "global", body: "global fact" })
    expect(await memory.list("board", "board-1")).toEqual([])
    const global = await memory.list("global", null)
    expect(global).toHaveLength(1)
    expect(global[0].boardId).toBe(null)
  })


  it("refuses a board-scoped save when there is no board in context", async () => {
    const noBoard = { memory } as unknown as ToolContext
    const res = (await saveMemory.run({ scope: "board", kind: "project", title: "t", summary: "s", body: "x" }, noBoard)) as { error?: string }
    expect(res.error).toMatch(/no board/)
    expect(await memory.list("board", "board-1")).toEqual([])
  })


  it("surfaces the over-cap retry payload with current entries", async () => {
    await save({ body: "x".repeat(3990) })
    const res = (await save({ body: "y".repeat(100) })) as { ok: boolean; reason?: string; entries?: unknown[] }
    expect(res.ok).toBe(false)
    expect(res.reason).toBe("over_cap")
    expect(res.entries).toHaveLength(1)
  })


  it("update and delete act on a saved id", async () => {
    const { id } = (await save({ body: "first" })) as { id: string }
    await updateMemory.run({ id, body: "revised" }, ctx)
    expect((await memory.list("board", "board-1"))[0].body).toBe("revised")
    await deleteMemory.run({ id }, ctx)
    expect(await memory.list("board", "board-1")).toEqual([])
  })


  it("recall filters board ∪ global by a case-insensitive query", async () => {
    await save({ body: "apples are red", title: "fruit" })
    await save({ scope: "global", body: "bananas are yellow", title: "other" })
    const res = (await recallMemory.run({ query: "BANANAS" }, ctx)) as { results: { title: string }[] }
    expect(res.results.map((r) => r.title)).toEqual(["other"])
  })


  it("refuses to update or delete another board's memory via a surfaced id", async () => {
    // A memory saved on board-2, then a board-1 turn tries to touch it by id.
    const other = { boardId: "board-2", memory } as unknown as ToolContext
    const { id } = (await saveMemory.run({ scope: "board", kind: "project", title: "t", summary: "s", body: "foreign" }, other)) as { id: string }
    const upd = (await updateMemory.run({ id, body: "hijacked" }, ctx)) as { ok: boolean; error?: string }
    const del = (await deleteMemory.run({ id }, ctx)) as { ok: boolean; error?: string }
    expect(upd.ok).toBe(false)
    expect(del.ok).toBe(false)
    expect((await memory.list("board", "board-2"))[0].body).toBe("foreign") // untouched
  })


  it("still lets a board turn edit global memory (the user's own, cross-board)", async () => {
    const { id } = (await save({ scope: "global", body: "global pref" })) as { id: string }
    const res = (await updateMemory.run({ id, body: "revised pref" }, ctx)) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect((await memory.list("global", null))[0].body).toBe("revised pref")
  })


  it("reports failure (not success) when updating/deleting an unknown id", async () => {
    const upd = (await updateMemory.run({ id: "ghost", body: "x" }, ctx)) as { ok: boolean }
    const del = (await deleteMemory.run({ id: "ghost" }, ctx)) as { ok: boolean }
    expect(upd.ok).toBe(false)
    expect(del.ok).toBe(false)
  })
})
