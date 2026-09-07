import { beforeEach, describe, expect, it } from "vitest"
import { asNodeId } from "@canvas-harness/core"
import { addNode, freshStore, resetIdb } from "@/test/canvas"
import { NOTE_TAIL_GAP, beneathBorderOrigin, offsetToOrigin, originBeneath } from "./beneath-border"


beforeEach(() => resetIdb())


describe("beneathBorderOrigin", () => {
  it("returns (0,0) on an empty board", () => {
    expect(beneathBorderOrigin(freshStore("c"))).toEqual({ x: 0, y: 0 })
  })

  it("left-aligns to the leftmost node, one gap below the lowest bottom edge", () => {
    const store = freshStore("c")
    addNode(store, "a")
    addNode(store, "b")
    store.updateNode(asNodeId("a"), { x: 40, y: 0, w: 200, h: 100 }) // bottom 100, leftmost x
    store.updateNode(asNodeId("b"), { x: 300, y: 60, w: 200, h: 180 }) // bottom 240
    expect(beneathBorderOrigin(store)).toEqual({ x: 40, y: 240 + NOTE_TAIL_GAP })
  })
})


describe("originBeneath", () => {
  it("returns (0,0) for no nodes", () => {
    expect(originBeneath([])).toEqual({ x: 0, y: 0 })
  })

  it("takes min x and max bottom + gap across the given nodes", () => {
    const nodes = [
      { x: 40, y: 0, h: 100 }, // bottom 100, leftmost
      { x: 300, y: 60, h: 180 }, // bottom 240
    ]
    expect(originBeneath(nodes)).toEqual({ x: 40, y: 240 + NOTE_TAIL_GAP })
  })
})


describe("offsetToOrigin", () => {
  it("no move for an empty cluster", () => {
    expect(offsetToOrigin([], { x: 100, y: 500 })).toEqual({ x: 0, y: 0 })
  })

  it("shifts the cluster's top-left corner onto the origin", () => {
    // Cluster min corner is (10, 20); moving it to (100, 500) is (+90, +480).
    const cluster = [
      { x: 10, y: 40 },
      { x: 60, y: 20 },
    ]
    expect(offsetToOrigin(cluster, { x: 100, y: 500 })).toEqual({ x: 90, y: 480 })
  })

  it("places a cluster beneath existing content when composed with originBeneath", () => {
    // Existing content bottoms out at y=240; a new cluster anchored near the
    // origin must shift below it, not overlap.
    const existing = [{ x: 40, y: 0, h: 100 }, { x: 300, y: 60, h: 180 }]
    const cluster = [{ x: 0, y: 0 }, { x: 0, y: 120 }]
    const shift = offsetToOrigin(cluster, originBeneath(existing))
    expect(shift).toEqual({ x: 40, y: 240 + NOTE_TAIL_GAP })
    // Applied: the cluster's top now sits one gap below the lowest existing bottom.
    expect(Math.min(...cluster.map((n) => n.y + shift.y))).toBe(240 + NOTE_TAIL_GAP)
  })
})
