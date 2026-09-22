import { describe, expect, it } from "vitest"
import type { BatchId, CanvasStore, ClientId, Node, NodeId, Op } from "@canvas-harness/core"
import type { NoteNodeData } from "@/features/board/harness/convert/note-to-node"
import type { OplogRecord } from "@/features/board/persist/local/idb"
import { InMemoryEngine } from "@/features/board/persist/local/in-memory-engine"
import { buildBoardSnapshot, readRecentOps, renderBoardSnapshot } from "./board-snapshot"


type NodeOpts = { kind?: NoteNodeData["styleType"] | "document"; label?: string; parentId?: string; content?: string }


const mkNode = (id: string, opts: NodeOpts = {}): Node => {
  const isDoc = opts.kind === "document"
  const structural = opts.kind && opts.kind !== "document" ? opts.kind : "rectangle"
  const data: NoteNodeData = {
    noteType: isDoc ? "document" : "note",
    styleType: structural,
    version: 1,
    graphUid: "g",
    parentId: opts.parentId,
    label: opts.label !== undefined ? { markdown: opts.label } : undefined,
    properties: {},
  }
  return { id: id as NodeId, type: "rect", x: 0, y: 0, w: 100, h: 100, angle: 0, z: 0, groups: [], content: opts.content, data }
}


// A freshly-drawn ink stroke as it lives in the store BEFORE any persist
// round-trip: the engine sets node.type="ink" + data.ink but no dim0 styleType.
const mkLiveInk = (id: string): Node => ({
  id: id as NodeId,
  type: "ink",
  x: 0, y: 0, w: 10, h: 10, angle: 0, z: 0, groups: [],
  content: undefined,
  data: { noteType: "note", version: 1, graphUid: "g", properties: {} } as NoteNodeData,
})


const fakeStore = (nodes: Node[], selection: string[] = []): CanvasStore =>
  ({ getAllNodes: () => nodes, getSelection: () => selection as unknown as NodeId[] }) as unknown as CanvasStore


const opRec = (boardId: string, seq: number, ops: Op[]): OplogRecord => ({
  boardId,
  seq,
  batch: { id: "b" as BatchId, clientId: "c" as ClientId, ts: 0, origin: "local", ops },
})


const render = (nodes: Node[], rootId: string | null = null, selection: string[] = [], recent: OplogRecord[] = []) =>
  renderBoardSnapshot(buildBoardSnapshot(fakeStore(nodes, selection), rootId, recent), { title: "Test board" })


describe("buildBoardSnapshot", () => {
  it("returns an empty snapshot for an empty board", () => {
    const snap = buildBoardSnapshot(fakeStore([]), null, [])
    expect(snap.total).toBe(0)
    expect(snap.counts).toEqual({})
    expect(snap.layers).toEqual([])
  })


  it("counts nodes by structural kind (styleType), not noteType", () => {
    const snap = buildBoardSnapshot(
      fakeStore([
        mkNode("a"),
        mkNode("b"),
        mkNode("f", { kind: "folder" }),
        mkNode("s", { kind: "sheet" }),
        mkNode("m", { kind: "mini-app" }),
        mkNode("d", { kind: "document" }),
      ]),
      null,
      [],
    )
    expect(snap.counts).toEqual({ note: 2, folder: 1, sheet: 1, "mini-app": 1, document: 1 })
    expect(snap.total).toBe(6)
  })


  it("counts freshly-drawn ink (node.type='ink', no styleType) as its own kind", () => {
    const snap = buildBoardSnapshot(
      fakeStore([mkNode("a", { label: "a note" }), mkLiveInk("k1"), mkLiveInk("k2")]),
      null,
      [],
    )
    // Classified via the node.type fallback, not lumped into "note".
    expect(snap.counts).toEqual({ note: 1, ink: 2 })
    // Ink carries no title signal: excluded from per-layer samples so it can't
    // crowd out real note titles — only the note appears.
    expect(snap.layers[0].sampleTitles).toEqual(["a note"])
  })


  it("also classifies persisted ink (styleType='ink') as ink", () => {
    const snap = buildBoardSnapshot(fakeStore([mkNode("k", { kind: "ink" })]), null, [])
    expect(snap.counts).toEqual({ ink: 1 })
  })


  it("shows a selected ink stroke as '(ink)', not a blank '(untitled)'", () => {
    const snap = buildBoardSnapshot(fakeStore([mkLiveInk("k1")], ["k1"]), null, [])
    expect(snap.selection).toEqual(["(ink)"])
  })


  it("derives titles: label → first content line → (untitled)", () => {
    const snap = buildBoardSnapshot(
      fakeStore([
        mkNode("a", { label: "My label" }),
        mkNode("b", { content: "\n  first content line\nsecond" }),
        mkNode("c"),
      ]),
      null,
      [],
    )
    const titles = snap.layers[0].sampleTitles
    expect(titles).toContain("My label")
    expect(titles).toContain("first content line")
    expect(titles).toContain("(untitled)")
  })


  it("is flat when every node is at root, foldered otherwise", () => {
    expect(buildBoardSnapshot(fakeStore([mkNode("a"), mkNode("b")]), null, []).flat).toBe(true)
    const foldered = buildBoardSnapshot(
      fakeStore([mkNode("f", { kind: "folder" }), mkNode("a", { parentId: "f" })]),
      null,
      [],
    )
    expect(foldered.flat).toBe(false)
  })


  it("groups nodes into layers by parentId and marks the current layer", () => {
    const snap = buildBoardSnapshot(
      fakeStore([
        mkNode("f", { kind: "folder", label: "Papers" }),
        mkNode("a", { parentId: "f" }),
        mkNode("b", { parentId: "f" }),
        mkNode("root1"),
      ]),
      "f",
      [],
    )
    const papers = snap.layers.find((l) => l.rootId === "f")
    expect(papers?.title).toBe("Papers")
    expect(papers?.count).toBe(2)
    expect(snap.currentLayer).toBe("f")
  })


  it("lands orphan nodes (dangling parentId) at root rather than a phantom layer", () => {
    const snap = buildBoardSnapshot(fakeStore([mkNode("a", { parentId: "ghost" }), mkNode("b")]), null, [])
    // Only the root layer exists; the orphan is merged into it.
    expect(snap.layers.map((l) => l.rootId)).toEqual([null])
    expect(snap.layers[0].count).toBe(2)
  })


  it("resolves selection to titles and ignores stale selection ids", () => {
    const snap = buildBoardSnapshot(
      fakeStore([mkNode("a", { label: "Alpha" }), mkNode("b", { label: "Beta" })], ["a", "missing"]),
      null,
      [],
    )
    expect(snap.selection).toEqual(["Alpha"])
  })
})


describe("recent-changes collapse", () => {
  const board = "bd"

  it("collapses add+edit to a single add, and add+remove cancels", () => {
    const ops: OplogRecord[] = [
      opRec(board, 1, [{ type: "node.add", node: mkNode("a", { label: "A" }) }]),
      opRec(board, 2, [{ type: "node.update", id: "a" as NodeId, patch: {}, prev: {} }]),
      opRec(board, 3, [{ type: "node.add", node: mkNode("b", { label: "B" }) }]),
      opRec(board, 4, [{ type: "node.remove", node: mkNode("b", { label: "B" }) }]),
    ]
    const snap = buildBoardSnapshot(fakeStore([mkNode("a", { label: "A" })]), null, ops)
    expect(snap.recent).toEqual([{ id: "a", op: "add", label: "A" }])
  })


  it("renders a recent change's title from a LEGACY bare-string label in the oplog", () => {
    // Oplog ops aren't normalized-on-load; a pre-upgrade agent add carries a
    // string label. It must still render the title, not "(untitled)".
    const legacy = mkNode("a", { label: "A" })
    ;(legacy.data as { label?: unknown }).label = "Legacy Title"
    const snap = buildBoardSnapshot(fakeStore([legacy]), null, [opRec(board, 1, [{ type: "node.add", node: legacy }])])
    expect(snap.recent).toEqual([{ id: "a", op: "add", label: "Legacy Title" }])
  })


  it("edit+remove becomes a delete, with the label from the remove op payload", () => {
    const ops: OplogRecord[] = [
      opRec(board, 1, [{ type: "node.update", id: "x" as NodeId, patch: {}, prev: {} }]),
      opRec(board, 2, [{ type: "node.remove", node: mkNode("x", { label: "Gone" }) }]),
    ]
    const snap = buildBoardSnapshot(fakeStore([]), null, ops)
    expect(snap.recent).toEqual([{ id: "x", op: "delete", label: "Gone" }])
  })


  it("keeps a delete when a stray update op follows a remove for the same node", () => {
    const ops: OplogRecord[] = [
      opRec(board, 1, [{ type: "node.remove", node: mkNode("x", { label: "X" }) }]),
      opRec(board, 2, [{ type: "node.update", id: "x" as NodeId, patch: {}, prev: {} }]),
    ]
    const snap = buildBoardSnapshot(fakeStore([]), null, ops)
    expect(snap.recent).toEqual([{ id: "x", op: "delete", label: "X" }])
  })


  it("drops a phantom edit for a node added+removed (cancelled) then stray-updated", () => {
    const ops: OplogRecord[] = [
      opRec(board, 1, [{ type: "node.add", node: mkNode("y", { label: "Y" }) }]),
      opRec(board, 2, [{ type: "node.remove", node: mkNode("y", { label: "Y" }) }]),
      opRec(board, 3, [{ type: "node.update", id: "y" as NodeId, patch: {}, prev: {} }]),
    ]
    // "y" isn't on the board now, so the net change is dropped (no phantom edit).
    expect(buildBoardSnapshot(fakeStore([]), null, ops).recent).toEqual([])
  })


  it("ignores edge ops", () => {
    const ops: OplogRecord[] = [
      opRec(board, 1, [{ type: "edge.add", edge: { id: "e" } as never }]),
    ]
    expect(buildBoardSnapshot(fakeStore([]), null, ops).recent).toEqual([])
  })
})


describe("renderBoardSnapshot", () => {
  it("renders the one-line empty form", () => {
    expect(render([])).toBe("Board snapshot: empty board — no nodes yet.")
  })


  it("renders a flat board with a Nodes line and no Layers heading", () => {
    const out = render([mkNode("a", { label: "One" }), mkNode("b", { label: "Two" })])
    expect(out).toContain("all at root (flat)")
    expect(out).toContain("- Nodes: ")
    expect(out).not.toContain("Layers (")
  })


  it("caps the Nodes list and notes the truncation", () => {
    const many = Array.from({ length: 40 }, (_, i) => mkNode(`n${i}`, { label: `Note ${i}` }))
    const out = render(many)
    expect(out).toMatch(/showing \d+ of 40/)
  })


  it("includes the current layer outside top-K without dropping the displaced folder or double-counting", () => {
    // 8 folders sized distinctly and all > the root layer (8 folder nodes) except
    // the current one (F7, size 1), so F7 is outside the top-6 by size.
    const nodes: Node[] = []
    for (let f = 0; f < 8; f++) {
      nodes.push(mkNode(`f${f}`, { kind: "folder", label: `F${f}` }))
      const size = f === 7 ? 1 : 20 - f // F0=20 … F6=14, F7=1
      for (let i = 0; i < size; i++) nodes.push(mkNode(`f${f}-n${i}`, { parentId: `f${f}` }))
    }
    const out = renderBoardSnapshot(buildBoardSnapshot(fakeStore(nodes), "f7", []), { title: "T" })
    const moreLine = out.split("\n").find((l) => l.includes(" more (")) ?? ""
    expect(out).toContain("/F7 (current)") // current is shown
    expect(moreLine).toContain("F5") // the displaced 6th-largest folder is kept (not dropped)
    expect(moreLine).not.toContain("F7") // current is not re-listed / double-counted
    // The Layers section counts layers, not folders (root is a layer): the header
    // says "N total", and root appears in "+ more (…)" without being called a folder.
    expect(out).toContain("Layers (9 total")
    expect(moreLine).not.toContain("folder")
  })


  it("caps the selection list", () => {
    const nodes = Array.from({ length: 12 }, (_, i) => mkNode(`s${i}`, { label: `Sel ${i}` }))
    const out = render(
      nodes,
      null,
      nodes.map((n) => n.id as unknown as string),
    )
    expect(out).toContain("Selection: 12 selected")
    expect(out).toContain("+4 more") // 12 selected, 8 shown
  })


  it("shows the current layer even when it is an empty folder", () => {
    // A folder node at root with no children; the user is inside it.
    const out = render([mkNode("f", { kind: "folder", label: "Empty" }), mkNode("n")], "f")
    expect(out).toContain("Layers (")
    expect(out).toContain("/Empty (current): 0 nodes")
  })


  it("surfaces recent changes even when the board is now empty (everything deleted)", () => {
    const out = renderBoardSnapshot(
      buildBoardSnapshot(fakeStore([]), null, [
        opRec("b", 1, [{ type: "node.remove", node: mkNode("a", { label: "Gone" }) }]),
      ]),
      { title: "T" },
    )
    expect(out).toContain("empty board")
    expect(out).toContain("Recent changes since you last checked: -1 deleted")
  })


  it("renders a Selection line only when something is selected", () => {
    expect(render([mkNode("a", { label: "A" })])).not.toContain("Selection:")
    expect(render([mkNode("a", { label: "A" })], null, ["a"])).toContain('Selection: 1 selected — "A"')
  })


  it("omits recent changes when nothing changed, and lists them when present", () => {
    const out = renderBoardSnapshot(buildBoardSnapshot(fakeStore([mkNode("a")]), null, []), { title: "T" })
    expect(out).not.toContain("Recent changes")
    const changed = renderBoardSnapshot(
      buildBoardSnapshot(fakeStore([mkNode("a", { label: "A" })]), null, [
        opRec("b", 1, [{ type: "node.add", node: mkNode("a", { label: "A" }) }]),
      ]),
      { title: "T" },
    )
    expect(changed).toContain("Recent changes since you last checked: +1 added")
  })
})


describe("readRecentOps", () => {
  it("reads only oplog records past the given seq for the board", async () => {
    const engine = new InMemoryEngine()
    for (let seq = 1; seq <= 5; seq++) {
      await engine.put("oplog", opRec("board-a", seq, []))
    }
    await engine.put("oplog", opRec("board-b", 1, []))

    const since2 = await readRecentOps(engine, "board-a", 2)
    expect(since2.map((r) => r.seq)).toEqual([3, 4, 5])

    const all = await readRecentOps(engine, "board-a", 0)
    expect(all.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5])
    engine.close()
  })


  it("round-trips the per-device snapshot_meta cursor", async () => {
    const engine = new InMemoryEngine()
    await engine.put("snapshot_meta", { boardId: "b", seenSeq: 42 })
    expect(await engine.get("snapshot_meta", "b")).toEqual({ boardId: "b", seenSeq: 42 })
    engine.close()
  })
})
