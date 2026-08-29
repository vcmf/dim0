import { describe, expect, it } from "vitest"
import type { OpBatch } from "@canvas-harness/core"
import { affectsSurfaceTree } from "./use-sidebar-contents-sync"


/** Build a minimal batch; op shapes are asserted loosely (the predicate only reads a few fields). */
const batch = (ops: unknown[]): OpBatch => ({ id: "b", origin: "local", ops } as unknown as OpBatch)


describe("affectsSurfaceTree", () => {
  it("is true when a surface node (sheet/folder/code-sandbox/widget) is added", () => {
    for (const styleType of ["sheet", "folder", "code-sandbox", "widget"]) {
      expect(affectsSurfaceTree(batch([{ type: "node.add", node: { id: "n", data: { styleType } } }]))).toBe(true)
    }
  })

  it("is false when a non-surface node (sticky/shape) is added", () => {
    expect(affectsSurfaceTree(batch([{ type: "node.add", node: { id: "n", data: { styleType: "note" } } }]))).toBe(false)
    expect(affectsSurfaceTree(batch([{ type: "node.add", node: { id: "n", data: {} } }]))).toBe(false)
  })

  it("falls back to node.type for an agent surface (canonical type, no styleType)", () => {
    // Agent-authored sheets set node.type but not the display styleType.
    expect(affectsSurfaceTree(batch([{ type: "node.add", node: { id: "n", type: "sheet", data: { meta: {} } } }]))).toBe(true)
    expect(affectsSurfaceTree(batch([{ type: "node.add", node: { id: "n", type: "rect", data: {} } }]))).toBe(false)
  })

  it("is true when a surface node is removed, false for a non-surface removal", () => {
    // The remove op carries the full node, so its kind is checkable (like add).
    expect(affectsSurfaceTree(batch([{ type: "node.remove", node: { id: "n", data: { styleType: "sheet" } } }]))).toBe(true)
    expect(affectsSurfaceTree(batch([{ type: "node.remove", node: { id: "n", data: { styleType: "note" } } }]))).toBe(false)
  })

  it("is true when an update touches label / parent / icon / kind", () => {
    expect(affectsSurfaceTree(batch([{ type: "node.update", id: "n", patch: { data: { label: { markdown: "x" } } } }]))).toBe(true)
    expect(affectsSurfaceTree(batch([{ type: "node.update", id: "n", patch: { data: { parentId: "f" } } }]))).toBe(true)
    expect(affectsSurfaceTree(batch([{ type: "node.update", id: "n", patch: { data: { properties: { iconData: { icon: "x" } } } } }]))).toBe(true)
    expect(affectsSurfaceTree(batch([{ type: "node.update", id: "n", patch: { data: { styleType: "folder" } } }]))).toBe(true)
  })

  it("is false for a pure position/style update (drag/resize)", () => {
    expect(affectsSurfaceTree(batch([{ type: "node.update", id: "n", patch: { x: 10, y: 20 } }]))).toBe(false)
    expect(affectsSurfaceTree(batch([{ type: "node.update", id: "n", patch: { style: { backgroundColor: "#fff" } } }]))).toBe(false)
  })

  it("is false for an empty or edge-only batch", () => {
    expect(affectsSurfaceTree(batch([]))).toBe(false)
    expect(affectsSurfaceTree(batch([{ type: "edge.add", edge: { id: "e" } }]))).toBe(false)
  })
})
