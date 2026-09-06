import { describe, expect, it } from "vitest"
import type { Node } from "@canvas-harness/core"
import {
  createInkNode,
  hitTestInkWorld,
  interpolateInkSamples,
  readInkProperty,
} from "./ink-geometry"
import { isLikelyPalmContact, isPenEraserContact } from "./ink-pointer"


describe("ink geometry", () => {
  it("fills sparse Pencil samples without losing pressure progression", () => {
    const interpolated = interpolateInkSamples(
      { x: 0, y: 0, pressure: 0.2 },
      { x: 10, y: 0, pressure: 0.8 },
      2,
    )

    expect(interpolated).toHaveLength(5)
    expect(interpolated[0].x).toBe(2)
    expect(interpolated.at(-1)).toEqual({ x: 10, y: 0, pressure: 0.8 })
    expect(interpolated[0].pressure).toBeCloseTo(0.32)
  })


  it("distinguishes large palm contacts and standard pen eraser input", () => {
    expect(isLikelyPalmContact(42, 24)).toBe(true)
    expect(isLikelyPalmContact(18, 20)).toBe(false)
    expect(isPenEraserContact({ pointerType: "pen", button: 5, buttons: 32 })).toBe(true)
    expect(isPenEraserContact({ pointerType: "pen", button: 0, buttons: 1 })).toBe(false)
  })


  it("builds one pressure-aware custom node with local stroke data", () => {
    const node = createInkNode({
      id: "00000000-0000-4000-8000-000000000001",
      boardId: "board-1",
      parentId: null,
      color: "#123456",
      size: 6,
      samples: [
        { x: 100, y: 100, pressure: 0.2 },
        { x: 120, y: 110, pressure: 0.6 },
        { x: 140, y: 100, pressure: 1 },
      ],
    })

    expect(node).not.toBeNull()
    expect(node?.type).toBe("ink")
    expect(node?.style?.strokeColor).toBe("#123456")
    const ink = readInkProperty(node as Node)
    expect(ink?.size).toBe(6)
    expect(ink?.points).toHaveLength(3)
    expect(ink?.outline.length).toBeGreaterThan(3)
    expect(Math.min(...(ink?.outline.map(([x]) => x) ?? []))).toBeCloseTo(0)
  })


  it("hit-tests the stroke centerline instead of its whole bounding box", () => {
    const node = createInkNode({
      id: "00000000-0000-4000-8000-000000000002",
      boardId: "board-1",
      parentId: null,
      color: "#111111",
      size: 4,
      samples: [
        { x: 10, y: 10, pressure: 0.5 },
        { x: 60, y: 60, pressure: 0.5 },
      ],
    }) as Node

    expect(hitTestInkWorld(node, { x: 35, y: 35 })).toBe(true)
    expect(hitTestInkWorld(node, { x: 12, y: 58 })).toBe(false)
    expect(hitTestInkWorld(node, { x: 12, y: 58 }, 40)).toBe(true)
  })


  it("accepts snake_case dimensions from relay snapshots", () => {
    const node = {
      id: "n",
      type: "ink",
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      z: 0,
      angle: 0,
      groups: [],
      data: {
        properties: {
          ink_data: {
            type: "ink",
            version: 1,
            size: 4,
            points: [[1, 1, 0.5]],
            outline: [[0, 0], [2, 0], [2, 2]],
            intrinsic_width: 2,
            intrinsic_height: 2,
          },
        },
      },
    } as unknown as Node

    expect(readInkProperty(node)?.intrinsicWidth).toBe(2)
    expect(readInkProperty(node)?.intrinsicHeight).toBe(2)
  })
})
