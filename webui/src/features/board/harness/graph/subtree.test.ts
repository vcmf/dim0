import { afterEach, describe, expect, it } from "vitest"
import { asNodeId, type OpBatch } from "@canvas-harness/core"
import { addEdge, freshStore, resetIdb } from "@/test/canvas"
import type { DimNode } from "@/features/board/model"
import { getLocalStores } from "@/features/local-stores"
import { BoardPersistence } from "@/features/board/persist/local/board-persistence"
import { InMemoryEngine } from "@/features/board/persist/local/in-memory-engine"
import { setBoardPersistenceRef } from "@/features/board/persist/local/board-persistence-ref"
import { setBoardSyncRef } from "@/features/board/harness/sync/board-sync-ref"
import type { BoardSyncHandle } from "@/features/board/harness/sync/board-sync"
import { useBoardAppStore } from "@/features/board/harness/store/board-app-store"
import { collectSubtreeIds, removeNodeSubtree, removeNodesSubtreeAsync } from "./subtree"


afterEach(() => {
  // The refs are module singletons — isolate tests.
  setBoardPersistenceRef(null)
  setBoardSyncRef(null)
  useBoardAppStore.setState({ boardId: null })
})


// Minimal DimNode for the pure BFS (only id + data.parentId are read).
const node = (id: string, parentId?: string): DimNode =>
  ({ id: asNodeId(id), data: { parentId, meta: { v: 1, createdAt: 0, updatedAt: 0 } } }) as unknown as DimNode


// Add a rect node carrying a parentId (test/canvas addNode has no parentId).
const addChild = (store: ReturnType<typeof freshStore>, id: string, parentId?: string): void => {
  addTyped(store, id, "rect", parentId)
}


// Add a node of an explicit type (durable-delete keys off node type).
const addTyped = (
  store: ReturnType<typeof freshStore>,
  id: string,
  type: string,
  parentId?: string,
): void => {
  store.addNode({
    id: asNodeId(id),
    type,
    x: 0, y: 0, w: 100, h: 50, angle: 0, groups: [],
    data: { meta: { v: 1, createdAt: 0, updatedAt: 0 }, parentId },
  })
}


describe("collectSubtreeIds", () => {
  it("collects a node and its transitive descendants", () => {
    // A → B → C, A → D, plus unrelated E.
    const nodes = [node("A"), node("B", "A"), node("C", "B"), node("D", "A"), node("E")]
    const ids = collectSubtreeIds(nodes, [asNodeId("A")])
    expect([...ids].sort()).toEqual(["A", "B", "C", "D"])
  })


  it("scopes to the given root (a mid-tree node)", () => {
    const nodes = [node("A"), node("B", "A"), node("C", "B"), node("D", "A")]
    expect([...collectSubtreeIds(nodes, [asNodeId("B")])].sort()).toEqual(["B", "C"])
  })


  it("returns just the node when it has no children", () => {
    expect([...collectSubtreeIds([node("A"), node("B")], [asNodeId("A")])]).toEqual(["A"])
  })


  it("de-dupes overlapping roots", () => {
    const nodes = [node("A"), node("B", "A"), node("C", "B")]
    // B is a descendant of A; passing both must not double-count.
    expect([...collectSubtreeIds(nodes, [asNodeId("A"), asNodeId("B")])].sort()).toEqual(["A", "B", "C"])
  })


  it("is cycle-safe (a mutual parent loop terminates)", () => {
    const nodes = [node("A", "B"), node("B", "A")]
    expect([...collectSubtreeIds(nodes, [asNodeId("A")])].sort()).toEqual(["A", "B"])
  })
})


describe("removeNodeSubtree", () => {
  it("removes a folder, its whole subtree, and their incident edges in one undo", () => {
    const store = freshStore("c")
    addChild(store, "F") // folder
    addChild(store, "c1", "F") // child of F
    addChild(store, "c2", "c1") // grandchild
    addChild(store, "s") // unrelated sibling (top-level)
    addEdge(store, "e1", "c1", "s") // edge crossing the subtree boundary

    removeNodeSubtree(store, asNodeId("F"))

    expect(store.getAllNodes().map((n) => n.id).sort()).toEqual(["s"])
    expect(store.getAllEdges()).toHaveLength(0) // incident edge cascaded out

    // One batch → one undo restores the entire subtree + edge.
    store.undo()
    expect(store.getAllNodes().map((n) => n.id).sort()).toEqual(["F", "c1", "c2", "s"])
    expect(store.getAllEdges().map((e) => e.id)).toEqual(["e1"])
  })


  it("deletes a durable-type node WITHOUT putting it on the undo stack", () => {
    const store = freshStore("c")
    addTyped(store, "d1", "document")
    store.clearHistory() // isolate: only the delete could touch the undo stack
    removeNodeSubtree(store, asNodeId("d1"))
    expect(store.getNode(asNodeId("d1"))).toBeUndefined()
    store.undo() // history-origin delete is off the stack — must not resurrect it
    expect(store.getNode(asNodeId("d1"))).toBeUndefined()
  })


  it("still cascades incident edges when deleting a durable folder subtree", () => {
    const store = freshStore("c")
    addTyped(store, "F", "folder")
    addChild(store, "c1", "F")
    addChild(store, "s")
    addEdge(store, "e1", "c1", "s") // edge crossing the subtree boundary
    removeNodeSubtree(store, asNodeId("F"))
    expect(store.getAllNodes().map((n) => n.id).sort()).toEqual(["s"])
    expect(store.getAllEdges()).toHaveLength(0) // incident edge cascaded out
  })


  it("removes only the node when it is a leaf", () => {
    const store = freshStore("c")
    addChild(store, "a")
    addChild(store, "b")
    removeNodeSubtree(store, asNodeId("a"))
    expect(store.getAllNodes().map((n) => n.id)).toEqual(["b"])
  })


  it("cascades DocRepo cleanup for a document in a deeper (unloaded) layer", async () => {
    // A PDF uploaded inside a folder lives in the folder's layer. Deleting the
    // folder from its parent layer removes the doc node via the oplog sweep only
    // (the store never sees it), so its DocRepo chunks must be cleaned here or
    // doc_search would keep citing a deleted document.
    resetIdb()
    useBoardAppStore.setState({ boardId: "b" })
    const { docs } = await getLocalStores()
    await docs.addDocument({ id: "d1", boardId: "b", title: "A.pdf", pages: 1, createdAt: 0 })
    await docs.addChunks([{ chunkId: "d1#0", docId: "d1", boardId: "b", index: 0, text: "hi" }])

    const engine = new InMemoryEngine()
    const persistence = new BoardPersistence("b", { engine })
    const full = freshStore("seed")
    const unsub = persistence.attach(full)
    addTyped(full, "F", "folder")
    addTyped(full, "d1", "document", "F") // doc in the folder's (deeper) layer
    await persistence.flush()
    unsub()

    const live = freshStore("live")
    addTyped(live, "F", "folder") // only the folder is loaded at the parent layer
    persistence.attach(live)
    setBoardPersistenceRef(persistence)

    await removeNodesSubtreeAsync(live, [asNodeId("F")])

    expect(await docs.getDocument("d1")).toBeUndefined()
    expect(await docs.chunksForDoc("d1")).toEqual([])
  })


  it("cascades to descendants in deeper (unloaded) layers via persistence", async () => {
    const engine = new InMemoryEngine()
    const persistence = new BoardPersistence("b", { engine })

    // Seed the WHOLE board (all layers) into the oplog via a full store.
    const full = freshStore("seed")
    const unsub = persistence.attach(full)
    addChild(full, "F") // folder at root
    addChild(full, "c1", "F") // child — a deeper layer
    addChild(full, "c2", "c1") // grandchild — deeper still
    addChild(full, "s") // sibling at root
    await persistence.flush()
    unsub()

    // Simulate the live ROOT-layer store: only F + s are loaded (children are deeper).
    const live = freshStore("live")
    addChild(live, "F")
    addChild(live, "s")
    persistence.attach(live)
    setBoardPersistenceRef(persistence)

    await removeNodesSubtreeAsync(live, [asNodeId("F")])

    // Loaded layer: F gone from the live store, sibling remains.
    expect(live.getAllNodes().map((n) => n.id).sort()).toEqual(["s"])
    // Whole board: the deeper descendants were swept from the oplog too.
    expect((await persistence.load()).nodes.map((n) => n.id).sort()).toEqual(["s"])
  })


  it("routes the deep-layer sweep through the sync intake (scene:false) on a synced board", async () => {
    const engine = new InMemoryEngine()
    const persistence = new BoardPersistence("b", { engine })

    // Seed the whole board: F at root, a deeper child c1 (an unloaded layer).
    const full = freshStore("seed")
    const unsub = persistence.attach(full)
    addChild(full, "F")
    addChild(full, "c1", "F")
    await persistence.flush()
    unsub()

    const live = freshStore("live")
    addChild(live, "F") // only the folder is loaded at the parent layer
    persistence.attach(live)
    setBoardPersistenceRef(persistence)

    // Spy sync ref: capture how the deep-layer batch enters the coordinator.
    const submitted: { batch: { ops: { type: string }[] }; scene?: boolean }[] = []
    setBoardSyncRef({
      submitLocalBatch: (batch: OpBatch, opts?: { scene?: boolean }) =>
        submitted.push({ batch: batch as unknown as { ops: { type: string }[] }, scene: opts?.scene }),
    } as unknown as BoardSyncHandle)

    await removeNodesSubtreeAsync(live, [asNodeId("F")])

    // The deep sweep entered submitLocalBatch exactly once, off-scene (not
    // rebase-tracked), carrying the deeper node's removal — so a synced board
    // pumps it to the relay instead of leaving it to ship opportunistically.
    expect(submitted).toHaveLength(1)
    expect(submitted[0].scene).toBe(false)
    expect(submitted[0].batch.ops.some((op) => op.type === "node.remove")).toBe(true)
  })
})
