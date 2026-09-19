import { describe, expect, it, vi } from "vitest"

import { drawGraph, parseViewBox } from "./graph-draw"
import type { LaidOutGraph } from "./graph-types"

// The canvas draw is verified by RECORDING calls on a mock 2D context — jsdom has no
// real canvas, and the concrete colors come from a DOM probe (jsdom can't compute
// oklch/color-mix, so it returns the input string). We assert STRUCTURE — that nodes
// become arcs, edges become strokes, labels become fillText, directed edges add an
// arrowhead fill — not pixels. Visual fidelity rides the PR 0 spike + a future e2e.


/** A recording stub of the 2D context: every drawing method is a spy, every styling
 *  property a plain settable field. Enough surface for drawGraph to run untouched. */
function mockCtx() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
    lineCap: "butt",
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
  } as unknown as CanvasRenderingContext2D & Record<string, ReturnType<typeof vi.fn>>
}


const SIZE = { width: 200, height: 200 }


describe("parseViewBox", () => {
  it("parses four space-separated numbers", () => {
    expect(parseViewBox("0 0 100 50")).toEqual({ minX: 0, minY: 0, width: 100, height: 50 })
  })

  it("tolerates comma/extra-whitespace separators", () => {
    expect(parseViewBox(" 10, 20 , 30 40 ")).toEqual({ minX: 10, minY: 20, width: 30, height: 40 })
  })

  it("rejects a degenerate or malformed viewBox (null → nothing to draw)", () => {
    expect(parseViewBox("0 0 0 100")).toBeNull() // zero width
    expect(parseViewBox("0 0 100")).toBeNull() // too few
    expect(parseViewBox("a b c d")).toBeNull() // non-numeric
  })
})


describe("drawGraph", () => {
  const graph: LaidOutGraph = {
    viewBox: "0 0 100 100",
    directed: false,
    nodes: [
      { id: "a", x: 20, y: 20, label: "A", sublabel: "1", color: "var(--chart-1)", border: "var(--border)", textColor: "var(--foreground)" },
      { id: "b", x: 80, y: 80, label: "B", sublabel: null, color: "var(--chart-2)", border: "var(--border)", textColor: "var(--foreground)" },
    ],
    edges: [{ a: "a", b: "b", x1: 20, y1: 20, x2: 80, y2: 80, label: "w", color: "var(--border)" }],
  }

  it("draws one arc per node", () => {
    const ctx = mockCtx()
    drawGraph(ctx, graph, SIZE)
    expect((ctx.arc as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
  })

  it("strokes each edge line", () => {
    const ctx = mockCtx()
    drawGraph(ctx, graph, SIZE)
    // The edge (20,20)→(80,80) is inset by NODE_RADIUS + EDGE_GAP (20 + 6 = 26) at each
    // end before the moveTo — 26·(1/√2) ≈ 18.38 along a 45° edge → start ≈ (38.38, 38.38).
    // Coords stay in viewBox space (the fit transform is a recorded scale/translate, not
    // applied to args by the mock).
    const start = (ctx.moveTo as ReturnType<typeof vi.fn>).mock.calls.find((c) => Math.abs(c[0] - 38.38) < 0.1)
    expect(start).toBeDefined()
    // Only edges stroke now — the node ring and the edge-label chip were dropped in favor
    // of ring-less circles and opaque label halos (fills, not strokes).
    expect((ctx.stroke as ReturnType<typeof vi.fn>).mock.calls.length).toBe(graph.edges.length)
  })

  it("renders node labels, the sublabel, and the edge label as text", () => {
    const ctx = mockCtx()
    drawGraph(ctx, graph, SIZE)
    const texts = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(texts).toContain("A")
    expect(texts).toContain("B")
    expect(texts).toContain("1") // sublabel on node a only
    expect(texts).toContain("w") // edge label
  })

  it("fits within a save/restore and applies a scale+translate transform", () => {
    const ctx = mockCtx()
    drawGraph(ctx, graph, SIZE)
    expect(ctx.save).toHaveBeenCalledOnce()
    expect(ctx.restore).toHaveBeenCalledOnce()
    expect(ctx.scale).toHaveBeenCalled()
    expect(ctx.translate).toHaveBeenCalled()
  })

  it("adds an arrowhead fill for a directed edge (triangle path → fill)", () => {
    const undirected = mockCtx()
    drawGraph(undirected, graph, SIZE)
    const undirectedFills = (undirected.fill as ReturnType<typeof vi.fn>).mock.calls.length

    const directed = mockCtx()
    drawGraph(directed, { ...graph, directed: true }, SIZE)
    const directedFills = (directed.fill as ReturnType<typeof vi.fn>).mock.calls.length

    expect(directedFills).toBe(undirectedFills + 1) // exactly one extra fill (the arrowhead)
  })

  it("returns true when it paints", () => {
    expect(drawGraph(mockCtx(), graph, SIZE)).toBe(true)
  })

  it("no-ops (returns false) on a degenerate viewBox without touching the context", () => {
    const ctx = mockCtx()
    expect(drawGraph(ctx, { ...graph, viewBox: "0 0 0 0" }, SIZE)).toBe(false)
    expect(ctx.save).not.toHaveBeenCalled()
    expect(ctx.arc).not.toHaveBeenCalled()
  })

  it("no-ops (returns false) on a zero-size canvas box", () => {
    const ctx = mockCtx()
    expect(drawGraph(ctx, graph, { width: 0, height: 0 })).toBe(false)
    expect(ctx.save).not.toHaveBeenCalled()
  })

  it("returns true for an empty-but-valid graph (blank is its finished render)", () => {
    expect(drawGraph(mockCtx(), { ...graph, nodes: [], edges: [] }, SIZE)).toBe(true)
  })
})
