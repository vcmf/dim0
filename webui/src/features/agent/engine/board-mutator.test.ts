import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { asNodeId, type OpBatch } from "@canvas-harness/core"
import type { CanvasStore } from "@canvas-harness/core"
import { freshStore, resetIdb } from "@/test/canvas"
import type { DimNodeData } from "@/features/board/model"
import { labelText } from "@/features/board/model"
import { resolveFamilyShade } from "@/features/board/lib/colors/tailwind"
import { InMemoryEngine } from "@/features/board/persist/local/in-memory-engine"
import { BoardPersistence } from "@/features/board/persist/local/board-persistence"
import { setBoardPersistenceRef } from "@/features/board/persist/local/board-persistence-ref"
import { setBoardSyncRef } from "@/features/board/harness/sync/board-sync-ref"
import type { BoardSyncHandle } from "@/features/board/harness/sync/board-sync"
import { StoreMutator, HeadlessMutator } from "./board-mutator"


beforeEach(() => resetIdb())
afterEach(() => {
  // Module-singleton refs — isolate the HeadlessMutator tests.
  setBoardPersistenceRef(null)
  setBoardSyncRef(null)
})


const label = (store: CanvasStore, id: string): string =>
  labelText((store.getNode(asNodeId(id))?.data as DimNodeData | undefined)?.label)
const body = (store: CanvasStore, id: string): string => store.getNode(asNodeId(id))?.content ?? ""
const stored = (store: CanvasStore, id: string) =>
  (store.getNode(asNodeId(id))?.data as DimNodeData | undefined)?._storedColors
const nodeMeta = (store: CanvasStore, id: string) =>
  (store.getNode(asNodeId(id))?.data as DimNodeData | undefined)?.meta


describe("StoreMutator", () => {
  it("createNote adds a rect note with label/content/parentId and returns created:true", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, "folder-1")
    const res = await m.createNote({ content: "the body", label: "Title", type: "rectangle" })

    expect(res.created).toBe(true)
    const node = store.getNode(asNodeId(res.id))
    expect(node?.type).toBe("rect")
    expect(body(store, res.id)).toBe("the body")
    expect(label(store, res.id)).toBe("Title")
    expect((node?.data as DimNodeData | undefined)?.parentId).toBe("folder-1")
  })

  it("createNote honors an explicit id and position (pinned)", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    const res = await m.createNote({ id: "n-explicit", content: "x", x: 500, y: 640 })
    expect(res.id).toBe("n-explicit")
    expect(res.placed).toBe(true) // explicit position → pinned (excluded from arrange)
    const node = store.getNode(asNodeId("n-explicit"))
    expect({ x: node?.x, y: node?.y }).toEqual({ x: 500, y: 640 })
  })

  it("auto placement (no position/near) is NOT pinned", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    const res = await m.createNote({ content: "x" })
    expect(res.placed).toBe(false)
  })

  it("near places the note adjacent to its anchor and pins it", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    await m.createNote({ id: "a", content: "A", x: 100, y: 100 })
    const anchor = store.getNode(asNodeId("a"))!
    const res = await m.createNote({ content: "B", near: { nodeId: "a", dir: "right", gap: 40 } })
    expect(res.placed).toBe(true)
    const b = store.getNode(asNodeId(res.id))!
    expect(b.x).toBe(anchor.x + anchor.w + 40) // right edge + gap
  })

  it("near nudges past an occupying note, staying on the requested side", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    await m.createNote({ id: "a", content: "A", x: 0, y: 0 })
    const anchor = store.getNode(asNodeId("a"))!
    // Blocker sits exactly where "right of A" would land.
    await m.createNote({ id: "blk", content: "B", x: anchor.x + anchor.w + 40, y: 0 })
    const blk = store.getNode(asNodeId("blk"))!
    const res = await m.createNote({ content: "C", near: { nodeId: "a", dir: "right", gap: 40 } })
    const c = store.getNode(asNodeId(res.id))!
    expect(c.x).toBeGreaterThanOrEqual(blk.x + blk.w) // pushed past the blocker
  })

  it("near falls back to auto placement when the anchor is missing", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    const res = await m.createNote({ content: "x", near: { nodeId: "ghost", dir: "right" } })
    expect(res.placed).toBe(false)
  })

  it("rewriteNote replaces content + label of an existing note (created:false)", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    const { id } = await m.createNote({ content: "old", label: "Old" })
    const res = await m.rewriteNote(id, { content: "new body", label: "New" })
    expect(res.created).toBe(false)
    expect(body(store, id)).toBe("new body")
    expect(label(store, id)).toBe("New")
  })

  it("rewriteNote on a missing id falls through to a create", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    const res = await m.rewriteNote("ghost", { content: "born here" })
    expect(res.created).toBe(true)
    expect(res.id).toBe("ghost")
    expect(body(store, "ghost")).toBe("born here")
  })

  it("rewriteNote preserves the existing type when note_type is omitted", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    const { id } = await m.createNote({ content: "x", type: "sheet" })
    expect(store.getNode(asNodeId(id))?.type).toBe("sheet")
    await m.rewriteNote(id, { content: "rewritten" }) // no type → must stay a sheet
    expect(store.getNode(asNodeId(id))?.type).toBe("sheet")
  })

  it("rewriteNote recolors an existing note when a color is passed", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    const { id } = await m.createNote({ content: "x" })
    await m.rewriteNote(id, { content: "x", colors: { background: "amber" } })
    expect(stored(store, id)?.backgroundColor).toBe(resolveFamilyShade("amber", 200))
  })

  it("rewriteNote recolors a sheet at the light shade and projects it onto style", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    const { id } = await m.createNote({ content: "x", type: "sheet" })
    await m.rewriteNote(id, { content: "x", colors: { background: "sky" } }) // type preserved → sheet
    expect(stored(store, id)?.backgroundColor).toBe(resolveFamilyShade("sky", 100))
    expect(store.getNode(asNodeId(id))?.style?.backgroundColor).toBeTruthy()
  })

  it("recolor overrides only the named channel, preserving the others", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    const { id } = await m.createNote({ content: "x", colors: { background: "amber" } })
    const bgBefore = stored(store, id)?.backgroundColor
    await m.rewriteNote(id, { content: "x", colors: { border: "black" } }) // border only
    const after = stored(store, id)
    expect(after?.backgroundColor).toBe(bgBefore) // fill preserved, not randomized
    expect(after?.strokeColor).toBe("#000000") // border applied
  })

  it("a border-only color on a sheet does not project a (random) background", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    const { id } = await m.createNote({ content: "x", type: "sheet", colors: { border: "black" } })
    // Sheets honor only a fill tint; a border-only request must not paint style.
    expect(store.getNode(asNodeId(id))?.style?.backgroundColor).toBeUndefined()
  })

  it("resolves the transparent and white specials (transparent fill → black text)", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    const t = await m.createNote({ content: "x", colors: { background: "transparent" } })
    expect(stored(store, t.id)?.backgroundColor).toBe("#00000000")
    expect(stored(store, t.id)?.textColor).toBe("#000000") // transparent sits on the light board
    const w = await m.createNote({ content: "x", colors: { background: "white" } })
    expect(stored(store, w.id)?.backgroundColor).toBe("#ffffff")
    expect(stored(store, w.id)?.textColor).toBe("#000000")
  })

  it("patchNote updates only the fields provided", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    const { id } = await m.createNote({ content: "keep", label: "Keep" })
    await m.patchNote(id, { content: "changed" })
    expect(body(store, id)).toBe("changed")
    expect(label(store, id)).toBe("Keep") // untouched
    await m.patchNote(id, { label: "Renamed" })
    expect(label(store, id)).toBe("Renamed")
    expect(body(store, id)).toBe("changed") // untouched
  })

  it("createNote resolves named colors to _storedColors (family→shade-200, border, black text)", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    const { id } = await m.createNote({ content: "x", colors: { background: "amber", border: "black" } })
    expect(stored(store, id)).toEqual({
      backgroundColor: resolveFamilyShade("amber", 200),
      strokeColor: "#000000",
      textColor: "#000000",
    })
  })

  it("createNote falls back to a random fill for an unknown color name (never throws)", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    const { id } = await m.createNote({ content: "x", colors: { background: "not-a-color" } })
    const colors = stored(store, id)
    expect(colors?.backgroundColor).toMatch(/^#/) // some hex, not empty
    expect(colors?.strokeColor).toBe("#00000000") // border omitted → transparent
  })

  it("resolves a sheet's color at the light shade (100) and projects it onto style so the sheet view honors it", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    const { id } = await m.createNote({ content: "x", type: "sheet", colors: { background: "amber" } })
    // Sheets honor only a shade-100 tint → resolve there, not 200.
    expect(stored(store, id)?.backgroundColor).toBe(resolveFamilyShade("amber", 100))
    // Projected onto node.style so the sheet view's honoredBg path paints it.
    expect(store.getNode(asNodeId(id))?.style?.backgroundColor).toBeTruthy()
  })

  it("derives white text on a dark fill for contrast (background=black)", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    const { id } = await m.createNote({ content: "x", colors: { background: "black" } })
    expect(stored(store, id)?.textColor).toBe("#ffffff")
  })

  it("createNote stamps fresh meta (v:1, createdAt == updatedAt) so the note shows a 'Created' stamp", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    const { id } = await m.createNote({ content: "x" })
    const meta = nodeMeta(store, id)
    expect(meta?.v).toBe(1)
    expect(meta?.createdAt).toBeTypeOf("number")
    expect(meta?.updatedAt).toBe(meta?.createdAt) // brand new → same instant
  })

  it("rewriteNote preserves createdAt and advances the version so the note reads as 'Edited'", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    const { id } = await m.createNote({ content: "old" })
    const before = nodeMeta(store, id)
    await m.rewriteNote(id, { content: "new" })
    const after = nodeMeta(store, id)
    expect(after?.createdAt).toBe(before?.createdAt) // original creation time kept
    expect(after?.v).toBe((before?.v ?? 0) + 1)
    expect(after?.updatedAt).toBeGreaterThanOrEqual(before?.updatedAt ?? 0)
  })

  it("patchNote bumps meta (createdAt preserved) on a content-only edit", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    const { id } = await m.createNote({ content: "old", label: "Keep" })
    const before = nodeMeta(store, id)
    await m.patchNote(id, { content: "changed" })
    const after = nodeMeta(store, id)
    expect(after?.createdAt).toBe(before?.createdAt)
    expect(after?.v).toBe((before?.v ?? 0) + 1)
  })

  it("patchNote with an empty patch is a no-op (no spurious 'Edited' bump)", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    const { id } = await m.createNote({ content: "keep" })
    const before = nodeMeta(store, id)
    await m.patchNote(id, {}) // neither content nor label
    const after = nodeMeta(store, id)
    expect(after?.v).toBe(before?.v) // unchanged → still reads as 'Created'
    expect(after?.updatedAt).toBe(before?.updatedAt)
  })

  it("createLink attaches an edge at node centers with the parent layer", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, "folder-1")
    const a = await m.createNote({ content: "A" })
    const c = await m.createNote({ content: "C" })
    const { id } = await m.createLink({ sourceId: a.id, targetId: c.id, label: "then" })

    const edge = store.getAllEdges().find((e) => String(e.id) === id)
    expect(edge).toBeTruthy()
    expect((edge?.data as { parentId?: string } | undefined)?.parentId).toBe("folder-1")
  })

  it("createFolder adds a folder node carrying the label + working-folder parentId", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, "parent-1")
    const { id } = await m.createFolder("Ideas")
    const node = store.getNode(asNodeId(id))
    expect(node?.type).toBe("folder")
    expect(label(store, id)).toBe("Ideas")
    expect((node?.data as DimNodeData).parentId).toBe("parent-1")
  })
})


describe("HeadlessMutator", () => {
  // A synced-board fixture: whole-board persistence + a spy sync ref that records
  // how each off-scene batch enters the coordinator.
  const setup = () => {
    const engine = new InMemoryEngine()
    const persistence = new BoardPersistence("b", { engine })
    setBoardPersistenceRef(persistence)
    const submitted: { scene?: boolean }[] = []
    setBoardSyncRef({
      submitLocalBatch: (_b: OpBatch, opts?: { scene?: boolean }) => submitted.push({ scene: opts?.scene }),
    } as unknown as BoardSyncHandle)
    const scene = freshStore("scene") // the user's visible layer (root)
    return { persistence, submitted, scene }
  }

  it("createNote writes into the target layer off-scene — not in the visible store, synced scene:false", async () => {
    const { persistence, submitted, scene } = setup()
    const m = new HeadlessMutator(scene, "folder-1")
    const res = await m.createNote({ content: "hi", label: "H" })
    await persistence.flush()

    expect(res.offScene).toBe(true)
    // Never enters the user's visible store.
    expect(scene.getNode(asNodeId(res.id))).toBeUndefined()
    // Landed in the whole-board oplog, stamped into the target layer.
    const whole = await persistence.load()
    const node = whole.nodes.find((n) => String(n.id) === res.id)
    expect(node?.data?.parentId).toBe("folder-1")
    // Entered the sync intake as an off-scene batch (never the rebase set).
    expect(submitted.length).toBeGreaterThan(0)
    expect(submitted.every((s) => s.scene === false)).toBe(true)
  })

  it("accumulates within a session so a second note places below the first (shared off-scene store)", async () => {
    const { scene } = setup()
    const m = new HeadlessMutator(scene, "folder-1")
    const a = await m.createNote({ content: "A" }) // auto-placed at origin
    const b = await m.createNote({ content: "B" }) // auto-placed BENEATH A
    expect(await m.hasNode(a.id)).toBe(true)
    expect(await m.hasNode(b.id)).toBe(true)
    expect(await m.hasNode("nope")).toBe(false)
  })

  it("createLink joins two off-scene notes in the target layer", async () => {
    const { persistence, scene } = setup()
    const m = new HeadlessMutator(scene, "folder-1")
    const a = await m.createNote({ content: "A" })
    const b = await m.createNote({ content: "B" })
    const { id } = await m.createLink({ sourceId: a.id, targetId: b.id, label: "then" })
    await persistence.flush()
    const whole = await persistence.load()
    const edge = whole.edges.find((e) => String(e.id) === id)
    expect((edge?.data as { parentId?: string } | undefined)?.parentId).toBe("folder-1")
  })

  it("createFolder makes a subfolder off-scene (in the whole-board oplog, not the visible store)", async () => {
    const { persistence, scene } = setup()
    const m = new HeadlessMutator(scene, "F")
    const { id } = await m.createFolder("Sub")
    await persistence.flush()
    expect(scene.getNode(asNodeId(id))).toBeUndefined()
    const whole = await persistence.load()
    const node = whole.nodes.find((n) => String(n.id) === id)
    expect(node?.type).toBe("folder")
    expect(node?.data?.parentId).toBe("F")
  })

  it("seeds from the existing layer so it can edit a note already in that folder", async () => {
    const { persistence, scene } = setup()
    // Seed a note into folder-1 via a separate headless session (as a prior turn would).
    const seeded = await new HeadlessMutator(scene, "folder-1").createNote({ content: "old", label: "Old" })
    await persistence.flush()
    // A fresh session must see it (loaded from the oplog) and rewrite it in place.
    const m = new HeadlessMutator(scene, "folder-1")
    expect(await m.hasNode(seeded.id)).toBe(true)
    await m.rewriteNote(seeded.id, { content: "new" })
    await persistence.flush()
    const whole = await persistence.load()
    const node = whole.nodes.find((n) => String(n.id) === seeded.id)
    expect(node?.content).toBe("new")
  })
})
