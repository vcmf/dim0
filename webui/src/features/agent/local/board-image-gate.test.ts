import { afterEach, describe, expect, it } from "vitest"
import type { CanvasStore } from "@canvas-harness/core"
import type { PublicModel } from "@/features/agent/types/model-catalog"
import { shouldAttachBoardImage } from "./board-image-gate"


const FLAG = "dim0_vision_board_context"
const visionCatalog: PublicModel[] = [{ id: "a", label: "a", family: "x", vision: true, routes: [] }]
const textCatalog: PublicModel[] = [{ id: "a", label: "a", family: "x", vision: false, routes: [] }]
const storeWith = (nodeCount: number): CanvasStore =>
  ({ getAllNodes: () => Array.from({ length: nodeCount }) }) as unknown as CanvasStore


afterEach(() => {
  localStorage.clear()
})


describe("shouldAttachBoardImage", () => {
  it("is off by default (flag unset)", () => {
    expect(shouldAttachBoardImage(storeWith(3), visionCatalog, "a")).toBe(false)
  })


  it("attaches when flag on + vision model + non-empty board", () => {
    localStorage.setItem(FLAG, "1")
    expect(shouldAttachBoardImage(storeWith(3), visionCatalog, "a")).toBe(true)
  })


  it("skips an empty board", () => {
    localStorage.setItem(FLAG, "1")
    expect(shouldAttachBoardImage(storeWith(0), visionCatalog, "a")).toBe(false)
  })


  it("skips a text-only model", () => {
    localStorage.setItem(FLAG, "1")
    expect(shouldAttachBoardImage(storeWith(3), textCatalog, "a")).toBe(false)
  })
})
