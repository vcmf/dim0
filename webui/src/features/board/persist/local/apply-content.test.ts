import { describe, expect, it } from "vitest"
import { asNodeId } from "@canvas-harness/core"
import { freshStore } from "@/test/canvas"
import type { BoardContent, DimNode } from "@/features/board/model"
import { applyContentToStore } from "./apply-content"


const rectNode = (id: string, parentId?: string | null): DimNode =>
  ({
    id: asNodeId(id),
    type: "rect",
    x: 0, y: 0, w: 100, h: 50, angle: 0, groups: [],
    data: { meta: { v: 1, createdAt: 0, updatedAt: 0 }, parentId },
  }) as unknown as DimNode


const content = (nodes: DimNode[]): BoardContent =>
  ({ schemaVersion: 1, nodes, edges: [], groups: [] }) as unknown as BoardContent


describe("applyContentToStore", () => {
  it("projects only the root layer when rootId is null", () => {
    const store = freshStore("c")
    applyContentToStore(store, content([rectNode("a"), rectNode("child", "f1")]), null)
    expect(store.getAllNodes().map((n) => n.id)).toEqual(["a"])
  })


  it("replaces the previous layer on switch — no accumulation across layers", () => {
    const store = freshStore("c")
    const c = content([rectNode("root1"), rectNode("c1", "folder"), rectNode("c2", "folder")])

    applyContentToStore(store, c, null) // root layer
    expect(store.getAllNodes().map((n) => n.id)).toEqual(["root1"])

    applyContentToStore(store, c, "folder") // enter folder → old layer cleared
    expect(store.getAllNodes().map((n) => n.id).sort()).toEqual(["c1", "c2"])

    applyContentToStore(store, c, null) // back to root → folder layer cleared
    expect(store.getAllNodes().map((n) => n.id)).toEqual(["root1"])
  })


  it("hydrates the whole board when rootId is omitted", () => {
    const store = freshStore("c")
    applyContentToStore(store, content([rectNode("a"), rectNode("b", "f1")]))
    expect(store.getAllNodes().map((n) => n.id).sort()).toEqual(["a", "b"])
  })


  it("makes the (re)load non-undoable", () => {
    const store = freshStore("c")
    applyContentToStore(store, content([rectNode("a")]), null)
    expect(store.undo()).toBe(false) // history cleared
  })
})
