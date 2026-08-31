import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { asNodeId, type OpBatch } from "@canvas-harness/core"
import { freshStore, resetIdb } from "@/test/canvas"
import { getLocalStores } from "@/features/local-stores"
import { BoardPersistence } from "@/features/board/persist/local/board-persistence"
import { setBoardPersistenceRef } from "@/features/board/persist/local/board-persistence-ref"
import { setBoardSyncRef } from "@/features/board/harness/sync/board-sync-ref"
import type { BoardSyncHandle } from "@/features/board/harness/sync/board-sync"
import { noteToNode } from "../../convert/note-to-node"
import { createDefaultNote } from "@/features/board/types/note"
import { openOffSceneNoteStore } from "./use-off-scene-note"


beforeEach(() => resetIdb())
afterEach(() => {
  setBoardPersistenceRef(null)
  setBoardSyncRef(null)
})


// Seed a sub-page (sheet with parentId = a parent note) into the whole-board
// replica, as `/subpage` off-scene creation does.
const seedSubpage = async (boardId: string, id: string, parentId: string, opts: { label?: string; content?: string } = {}) => {
  const { engine } = await getLocalStores()
  const persistence = new BoardPersistence(boardId, { engine })
  const store = freshStore("seed")
  const unsub = persistence.attach(store)
  const note = createDefaultNote({ boardId, nodeType: "sheet" })
  note.id = id
  note.parentId = parentId
  note.label = { markdown: opts.label ?? "Sub" }
  note.content = { markdown: opts.content ?? "body" }
  store.addNode(noteToNode(note))
  await persistence.flush()
  unsub()
  return persistence
}


describe("openOffSceneNoteStore", () => {
  it("loads an off-scene sub-page from the replica into an editable store", async () => {
    const persistence = await seedSubpage("b", "sub1", "parent1", { label: "Deep", content: "hello" })
    setBoardPersistenceRef(persistence)
    setBoardSyncRef(null)

    const live = freshStore("live") // the visible canvas (does NOT contain the sub-page)
    const { store, node, dispose } = await openOffSceneNoteStore(live, "b", "sub1")

    expect(live.getNode(asNodeId("sub1"))).toBeUndefined() // not on the visible canvas
    expect(node?.type).toBe("sheet")
    expect(node?.content).toBe("hello")
    expect(store?.getNode(asNodeId("sub1"))).toBeTruthy() // present in the off-scene store
    dispose()
  })

  it("builds the ancestor chain (root -> note) for the breadcrumb + stack", async () => {
    const { engine } = await getLocalStores()
    const persistence = new BoardPersistence("b", { engine })
    const store = freshStore("seed")
    const unsub = persistence.attach(store)
    // A parent sheet at root, then a sub-page nested under it.
    const parent = createDefaultNote({ boardId: "b", nodeType: "sheet" })
    parent.id = "parent1"
    parent.label = { markdown: "Parent" }
    const child = createDefaultNote({ boardId: "b", nodeType: "sheet" })
    child.id = "sub1"
    child.parentId = "parent1"
    child.label = { markdown: "Child" }
    store.addNode(noteToNode(parent))
    store.addNode(noteToNode(child))
    await persistence.flush()
    unsub()
    setBoardPersistenceRef(persistence)
    setBoardSyncRef(null)

    const { path, dispose } = await openOffSceneNoteStore(freshStore("live"), "b", "sub1")
    // Ordered root -> note, so ancestors = path.slice(0, -1) and depth = 1.
    expect(path.map((n) => n.id)).toEqual(["parent1", "sub1"])
    expect(path.map((n) => n.label?.markdown)).toEqual(["Parent", "Child"])
    expect(path.map((n) => n.style.type)).toEqual(["sheet", "sheet"])
    dispose()
  })

  it("returns a null store when the note isn't in the replica (falls back to REST)", async () => {
    const persistence = await seedSubpage("b", "sub1", "parent1")
    setBoardPersistenceRef(persistence)
    setBoardSyncRef(null)

    const { store, node, dispose } = await openOffSceneNoteStore(freshStore("live"), "b", "ghost")
    expect(store).toBeNull() // no doomed store built for a not-in-replica note
    expect(node).toBeNull()
    dispose()
  })

  it("forwards an edit to the sync intake off-scene (record + submitLocalBatch scene:false)", async () => {
    const persistence = await seedSubpage("b", "sub1", "parent1", { content: "old" })
    setBoardPersistenceRef(persistence)
    const submitted: { scene?: boolean }[] = []
    setBoardSyncRef({
      submitLocalBatch: (_b: OpBatch, o?: { scene?: boolean }) => submitted.push({ scene: o?.scene }),
    } as unknown as BoardSyncHandle)

    const live = freshStore("live")
    const { store, dispose } = await openOffSceneNoteStore(live, "b", "sub1")
    store!.updateNode(asNodeId("sub1"), { content: "edited" })
    await persistence.flush()

    // Edit entered the sync intake off-scene, and landed in the whole-board oplog.
    expect(submitted.length).toBeGreaterThan(0)
    expect(submitted.every((s) => s.scene === false)).toBe(true)
    const whole = await persistence.load()
    expect(whole.nodes.find((n) => String(n.id) === "sub1")?.content).toBe("edited")
    dispose()
  })
})
