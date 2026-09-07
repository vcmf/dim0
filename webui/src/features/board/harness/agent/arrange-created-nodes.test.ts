import { beforeEach, describe, expect, it } from "vitest"
import { asNodeId } from "@canvas-harness/core"
import { addEdge, addNode, freshStore, resetIdb } from "@/test/canvas"
import { arrangeCreatedNodes, arrangeNodesInPlace } from "./arrange-created-nodes"


beforeEach(() => resetIdb())


const at = (store: ReturnType<typeof freshStore>, id: string) => {
  const n = store.getNode(asNodeId(id))!
  return { x: n.x, y: n.y }
}


// Bounding-box center over a set of node ids.
const bboxCenterOf = (store: ReturnType<typeof freshStore>, ids: string[]) => {
  const ns = ids.map((id) => store.getNode(asNodeId(id))!)
  const minX = Math.min(...ns.map((n) => n.x)), minY = Math.min(...ns.map((n) => n.y))
  const maxX = Math.max(...ns.map((n) => n.x + n.w)), maxY = Math.max(...ns.map((n) => n.y + n.h))
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
}


describe("arrangeCreatedNodes", () => {
  it("spreads linked nodes that all start at the origin", async () => {
    const store = freshStore("c")
    for (const id of ["n1", "n2", "n3"]) addNode(store, id, id) // all at (0,0)
    addEdge(store, "e1", "n1", "n2")
    addEdge(store, "e2", "n1", "n3")

    await arrangeCreatedNodes(store, ["n1", "n2", "n3"])

    const ps = ["n1", "n2", "n3"].map((id) => at(store, id))
    // No longer all coincident — at least two distinct positions.
    const distinct = new Set(ps.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`))
    expect(distinct.size).toBeGreaterThan(1)
  })


  it("leaves a single node untouched", async () => {
    const store = freshStore("c")
    addNode(store, "solo", "solo")
    await arrangeCreatedNodes(store, ["solo"])
    expect(at(store, "solo")).toEqual({ x: 0, y: 0 })
  })


  it("splits a many-child tree to both sides of the root (bidirectional)", async () => {
    const store = freshStore("c")
    for (const id of ["root", "c1", "c2", "c3", "c4"]) addNode(store, id, id)
    for (const c of ["c1", "c2", "c3", "c4"]) addEdge(store, `e-${c}`, "root", c)

    await arrangeCreatedNodes(store, ["root", "c1", "c2", "c3", "c4"])

    const rootX = at(store, "root").x
    const childX = ["c1", "c2", "c3", "c4"].map((c) => at(store, c).x)
    expect(childX.some((x) => x < rootX)).toBe(true) // some children left of root
    expect(childX.some((x) => x > rootX)).toBe(true) // some children right of root
  })


  it("places the cluster below existing content", async () => {
    const store = freshStore("c")
    // Existing note occupies y up to ~220.
    addNode(store, "old", "old")
    store.updateNode(asNodeId("old"), { x: 0, y: 100, w: 200, h: 120 })

    for (const id of ["a", "b"]) addNode(store, id, id)
    addEdge(store, "e", "a", "b")
    await arrangeCreatedNodes(store, ["a", "b"])

    const minNewY = Math.min(at(store, "a").y, at(store, "b").y)
    expect(minNewY).toBeGreaterThanOrEqual(220) // below old (100+120)
  })
})


describe("arrangeNodesInPlace", () => {
  it("tidies the nodes while keeping the cluster centered where it was", async () => {
    const store = freshStore("c")
    for (const id of ["a", "b", "c"]) addNode(store, id, id)
    // Move the cluster off-origin to a known region.
    store.updateNode(asNodeId("a"), { x: 1000, y: 1000 })
    store.updateNode(asNodeId("b"), { x: 1300, y: 1000 })
    store.updateNode(asNodeId("c"), { x: 1150, y: 1200 })
    addEdge(store, "e1", "a", "b")
    addEdge(store, "e2", "a", "c")
    const before = bboxCenterOf(store, ["a", "b", "c"])

    const n = await arrangeNodesInPlace(store, ["a", "b", "c"])
    expect(n).toBe(3)

    // Re-laid-out (not all coincident)...
    const positions = ["a", "b", "c"].map((id) => at(store, id))
    expect(new Set(positions.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)).size).toBeGreaterThan(1)
    // ...but the cluster stays centered where it was (in place, NOT shoved beneath).
    const after = bboxCenterOf(store, ["a", "b", "c"])
    expect(Math.abs(after.x - before.x)).toBeLessThan(2)
    expect(Math.abs(after.y - before.y)).toBeLessThan(2)
  })

  it("returns 0 and moves nothing for fewer than two nodes", async () => {
    const store = freshStore("c")
    addNode(store, "solo", "solo")
    store.updateNode(asNodeId("solo"), { x: 500, y: 500 })
    expect(await arrangeNodesInPlace(store, ["solo"])).toBe(0)
    expect(at(store, "solo")).toEqual({ x: 500, y: 500 })
  })
})
