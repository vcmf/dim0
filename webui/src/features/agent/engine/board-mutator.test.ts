import { beforeEach, describe, expect, it } from "vitest"
import { asNodeId } from "@canvas-harness/core"
import type { CanvasStore } from "@canvas-harness/core"
import { freshStore, resetIdb } from "@/test/canvas"
import type { DimNodeData } from "@/features/board/model"
import { labelText } from "@/features/board/model"
import { resolveFamilyShade } from "@/features/board/lib/colors/tailwind"
import { StoreMutator } from "./board-mutator"


beforeEach(() => resetIdb())


const label = (store: CanvasStore, id: string): string =>
  labelText((store.getNode(asNodeId(id))?.data as DimNodeData | undefined)?.label)
const body = (store: CanvasStore, id: string): string => store.getNode(asNodeId(id))?.content ?? ""
const stored = (store: CanvasStore, id: string) =>
  (store.getNode(asNodeId(id))?.data as DimNodeData | undefined)?._storedColors


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

  it("createNote honors an explicit id and position", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    const res = await m.createNote({ id: "n-explicit", content: "x", x: 500, y: 640 })
    expect(res.id).toBe("n-explicit")
    const node = store.getNode(asNodeId("n-explicit"))
    expect({ x: node?.x, y: node?.y }).toEqual({ x: 500, y: 640 })
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

  it("createLink is straight (no control points) by default", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    const a = await m.createNote({ content: "A" })
    const c = await m.createNote({ content: "C" })
    const { id } = await m.createLink({ sourceId: a.id, targetId: c.id })
    const edge = store.getAllEdges().find((e) => String(e.id) === id)
    expect(edge?.control).toBeUndefined()
  })

  it("createLink with curve sets a bent control pair off the straight midpoint", async () => {
    const store = freshStore("b")
    const m = new StoreMutator(store, null)
    // Two nodes on a horizontal line so the perpendicular bend is purely vertical.
    const a = await m.createNote({ id: "a", content: "A", x: 0, y: 0 })
    const c = await m.createNote({ id: "c", content: "C", x: 1000, y: 0 })
    const { id } = await m.createLink({ sourceId: a.id, targetId: c.id, curve: 80 })
    const edge = store.getAllEdges().find((e) => String(e.id) === id)
    expect(edge?.control).toHaveLength(2)
    // Both nodes sit on the same horizontal center line (centerY); a straight
    // bezier keeps its controls on that line. A +80 bend must push at least one
    // control point strictly BELOW it (greater y), proving the curve took effect.
    const node = store.getNode(asNodeId("a"))!
    const centerY = node.y + node.h / 2
    const ys = edge?.control?.map((p) => p.y) ?? []
    expect(Math.max(...ys)).toBeGreaterThan(centerY)
  })
})
