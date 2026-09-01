import { describe, expect, it } from "vitest"
import type { BoardContentItem } from "@/features/board/api/list-board-contents"
import { buildNodePath } from "./build-node-path"


const item = (id: string, parentId: string | null, label?: string | null): BoardContentItem => ({
  id,
  label,
  kind: "sheet",
  parentId,
  iconData: null,
})


describe("buildNodePath", () => {
  it("returns [] for a null leaf or empty list", () => {
    expect(buildNodePath([], "a")).toEqual([])
    expect(buildNodePath([item("a", null)], null)).toEqual([])
    expect(buildNodePath(undefined, "a")).toEqual([])
  })

  it("walks parentId root→leaf", () => {
    const items = [item("a", null, "A"), item("b", "a", "B"), item("c", "b", "C")]
    expect(buildNodePath(items, "c").map((s) => s.id)).toEqual(["a", "b", "c"])
    expect(buildNodePath(items, "c").map((s) => s.label)).toEqual(["A", "B", "C"])
  })

  it("returns just the leaf for a direct child of the board root", () => {
    const items = [item("a", null, "A")]
    expect(buildNodePath(items, "a").map((s) => s.id)).toEqual(["a"])
  })

  it("falls back to Untitled for a blank label", () => {
    expect(buildNodePath([item("a", null, "  ")], "a")[0].label).toBe("Untitled")
    expect(buildNodePath([item("a", null, null)], "a")[0].label).toBe("Untitled")
  })

  it("returns [] when the leaf is absent from the list", () => {
    expect(buildNodePath([item("a", null)], "missing")).toEqual([])
  })

  it("is cycle-safe (a→b→a)", () => {
    const items = [item("a", "b", "A"), item("b", "a", "B")]
    const path = buildNodePath(items, "a")
    // Terminates and includes each node at most once.
    expect(new Set(path.map((s) => s.id)).size).toBe(path.length)
    expect(path.length).toBeLessThanOrEqual(2)
  })
})
