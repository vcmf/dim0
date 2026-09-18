import { describe, expect, it, vi } from "vitest"

import { GraphLayoutError, layoutGraph } from "./graph-layout"


describe("layoutGraph — node positioning", () => {
  it("passes x/y through unchanged (manual layout)", () => {
    const g = layoutGraph({
      nodes: [{ id: "A", x: 10, y: 20 }],
      edges: [],
    })
    expect(g.nodes[0].x).toBe(10)
    expect(g.nodes[0].y).toBe(20)
  })


  it("uses id as label when label is not provided", () => {
    const g = layoutGraph({
      nodes: [{ id: "node1", x: 0, y: 0 }],
      edges: [],
    })
    expect(g.nodes[0].label).toBe("node1")
  })


  it("uses explicit label when provided", () => {
    const g = layoutGraph({
      nodes: [{ id: "n1", x: 0, y: 0, label: "Start" }],
      edges: [],
    })
    expect(g.nodes[0].label).toBe("Start")
  })


  it("carries sublabel through (null when absent)", () => {
    const g = layoutGraph({
      nodes: [
        { id: "A", x: 0, y: 0, sublabel: "12" },
        { id: "B", x: 0, y: 0 },
      ],
      edges: [],
    })
    expect(g.nodes[0].sublabel).toBe("12")
    expect(g.nodes[1].sublabel).toBeNull()
  })


  it("throws on duplicate node ids", () => {
    expect(() =>
      layoutGraph({
        nodes: [
          { id: "A", x: 0, y: 0 },
          { id: "A", x: 50, y: 50 },
        ],
        edges: [],
      })
    ).toThrow(GraphLayoutError)
  })
})


describe("layoutGraph — color resolution and defaults", () => {
  it("applies default tokens when no colors specified", () => {
    const g = layoutGraph({
      nodes: [{ id: "A", x: 0, y: 0 }],
      edges: [],
    })
    expect(g.nodes[0].color).toBe("var(--card)")
    expect(g.nodes[0].border).toBe(
      "color-mix(in srgb, var(--foreground) 50%, transparent)",
    )
    expect(g.nodes[0].textColor).toBe("var(--foreground)")
  })


  it("resolves explicit color/border/textColor tokens", () => {
    const g = layoutGraph({
      nodes: [
        {
          id: "A",
          x: 0,
          y: 0,
          color: "chart-1",
          border: "chart-2",
          textColor: "primary-foreground",
        },
      ],
      edges: [],
    })
    expect(g.nodes[0].color).toBe("var(--chart-1)")
    expect(g.nodes[0].border).toBe("var(--chart-2)")
    expect(g.nodes[0].textColor).toBe("var(--primary-foreground)")
  })


  it("passes hex colors through unchanged", () => {
    const g = layoutGraph({
      nodes: [{ id: "A", x: 0, y: 0, color: "#FF4500" }],
      edges: [],
    })
    expect(g.nodes[0].color).toBe("#FF4500")
  })


  it("resolves edge color default and explicit token", () => {
    const g = layoutGraph({
      nodes: [
        { id: "A", x: 0, y: 0 },
        { id: "B", x: 50, y: 0 },
      ],
      edges: [
        { a: "A", b: "B" },
        { a: "A", b: "B", color: "chart-3" },
      ],
    })
    // Edge default is a 50%-opacity foreground stroke (low-contrast thread).
    expect(g.edges[0].color).toBe(
      "color-mix(in srgb, var(--foreground) 50%, transparent)",
    )
    expect(g.edges[1].color).toBe("var(--chart-3)")
  })
})


describe("layoutGraph — edge endpoints", () => {
  it("looks up edge endpoints by node id", () => {
    const g = layoutGraph({
      nodes: [
        { id: "A", x: 10, y: 20 },
        { id: "B", x: 100, y: 200 },
      ],
      edges: [{ a: "A", b: "B", label: "5" }],
    })
    expect(g.edges[0]).toMatchObject({
      a: "A",
      b: "B",
      x1: 10,
      y1: 20,
      x2: 100,
      y2: 200,
      label: "5",
    })
  })


  it("drops edges referencing unknown nodes and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const g = layoutGraph({
      nodes: [{ id: "A", x: 0, y: 0 }],
      edges: [
        { a: "A", b: "ghost" },
        { a: "missing", b: "A" },
      ],
    })
    expect(g.edges.length).toBe(0)
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })


  it("edge label defaults to null when not provided", () => {
    const g = layoutGraph({
      nodes: [
        { id: "A", x: 0, y: 0 },
        { id: "B", x: 50, y: 0 },
      ],
      edges: [{ a: "A", b: "B" }],
    })
    expect(g.edges[0].label).toBeNull()
  })
})


describe("layoutGraph — viewBox", () => {
  it("auto-computes viewBox from each node's drawn extent + margin", () => {
    const g = layoutGraph({
      nodes: [
        { id: "A", x: 0, y: 0 },
        { id: "B", x: 100, y: 60 },
      ],
      edges: [],
    })
    // Each node (label = its id, no sublabel) reaches radius 20 up/left/right and
    // NODE_LABEL_CY(35) + label-halo-half-height(9.5) = 44.5 down. + VIEWBOX_MARGIN(10):
    //   x: [0-20, 100+20] → -20..120 ; y: [0-20, 60+44.5] → -20..104.5
    //   → "(-20-10) (-20-10) (140+20) (124.5+20)" = "-30 -30 160 144.5"
    expect(g.viewBox).toBe("-30 -30 160 144.5")
  })


  it("explicit viewBox overrides auto-computed", () => {
    const g = layoutGraph({
      nodes: [{ id: "A", x: 0, y: 0 }],
      edges: [],
      viewBox: "0 0 500 400",
    })
    expect(g.viewBox).toBe("0 0 500 400")
  })


  it("empty nodes list falls back to a default viewBox", () => {
    const g = layoutGraph({ nodes: [], edges: [] })
    expect(g.viewBox).toBe("0 0 100 100")
  })


  it("single-node viewBox from drawn extent + margin", () => {
    const g = layoutGraph({
      nodes: [{ id: "A", x: 50, y: 50 }],
      edges: [],
    })
    // Node at (50,50), label "A", no sublabel: reaches 20 up/left/right, 44.5 down.
    // + VIEWBOX_MARGIN(10): x 30..70, y 30..94.5 → "20 20 60 84.5"
    expect(g.viewBox).toBe("20 20 60 84.5")
  })
})


describe("layoutGraph — layout mode selection", () => {
  it("defaults to manual when every node has x and y", () => {
    const g = layoutGraph({
      nodes: [
        { id: "A", x: 10, y: 20 },
        { id: "B", x: 30, y: 40 },
      ],
      edges: [{ a: "A", b: "B" }],
    })
    expect(g.nodes[0]).toMatchObject({ id: "A", x: 10, y: 20 })
    expect(g.nodes[1]).toMatchObject({ id: "B", x: 30, y: 40 })
  })


  it("falls back to force layout when any node lacks coordinates", () => {
    const g = layoutGraph({
      nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
      edges: [
        { a: "A", b: "B" },
        { a: "B", b: "C" },
      ],
    })
    // Force layout assigns finite, distinct positions — not the 0,0 default.
    const positions = g.nodes.map((n) => `${n.x},${n.y}`)
    expect(new Set(positions).size).toBe(3)
    for (const n of g.nodes) {
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
    }
  })


  it("explicit manual layout keeps coordinates even with missing values", () => {
    const g = layoutGraph({
      layout: "manual",
      nodes: [{ id: "A", x: 5, y: 5 }, { id: "B" }],
      edges: [],
    })
    expect(g.nodes[0]).toMatchObject({ x: 5, y: 5 })
    // Missing coords default to 0,0 under manual.
    expect(g.nodes[1]).toMatchObject({ x: 0, y: 0 })
  })
})


describe("layoutGraph — force layout determinism", () => {
  it("produces identical positions across repeated runs", () => {
    const props = {
      layout: "force" as const,
      nodes: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
      edges: [
        { a: "A", b: "B" },
        { a: "A", b: "C" },
        { a: "B", b: "D" },
        { a: "C", b: "D" },
      ],
    }
    const first = layoutGraph(props).nodes.map((n) => `${n.x},${n.y}`)
    const second = layoutGraph(props).nodes.map((n) => `${n.x},${n.y}`)
    expect(first).toEqual(second)
  })
})


describe("layoutGraph — tree layout", () => {
  it("places the inferred root above its children", () => {
    const g = layoutGraph({
      layout: "tree",
      nodes: [{ id: "root" }, { id: "a" }, { id: "b" }],
      edges: [
        { a: "root", b: "a" },
        { a: "root", b: "b" },
      ],
    })
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]))
    // d3-tree puts depth on the y axis: root sits above its children.
    expect(byId.root.y).toBeLessThan(byId.a.y)
    expect(byId.root.y).toBeLessThan(byId.b.y)
    // Siblings are spread on the x axis, not stacked.
    expect(byId.a.x).not.toBe(byId.b.x)
  })


  it("honors an explicit root", () => {
    const g = layoutGraph({
      layout: "tree",
      root: "b",
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      edges: [
        { a: "b", b: "a" },
        { a: "b", b: "c" },
      ],
    })
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]))
    expect(byId.b.y).toBeLessThan(byId.a.y)
    expect(byId.b.y).toBeLessThan(byId.c.y)
  })


  it("renders cross-link edges without breaking the hierarchy", () => {
    // a→b→c is the tree; a→c is an extra cross-link (c already has parent b).
    const g = layoutGraph({
      layout: "tree",
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      edges: [
        { a: "a", b: "b" },
        { a: "b", b: "c" },
        { a: "a", b: "c" },
      ],
    })
    // All three edges survive layout.
    expect(g.edges.length).toBe(3)
    // c is placed one level below b (its tree parent), not beside a.
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]))
    expect(byId.b.y).toBeLessThan(byId.c.y)
  })


  it("places disconnected nodes in a row beneath the tree", () => {
    const g = layoutGraph({
      layout: "tree",
      nodes: [{ id: "root" }, { id: "child" }, { id: "orphan" }],
      edges: [{ a: "root", b: "child" }],
    })
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]))
    // Orphan sits below the deepest tree node.
    expect(byId.orphan.y).toBeGreaterThan(byId.child.y)
  })
})


describe("layoutGraph — auto color ramp", () => {
  it("cycles chart tokens across nodes under force layout", () => {
    const g = layoutGraph({
      layout: "force",
      nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
      edges: [{ a: "A", b: "B" }],
    })
    // Color identity lives on the fill — solid chart token per node.
    expect(g.nodes[0].color).toBe("var(--chart-1)")
    expect(g.nodes[1].color).toBe("var(--chart-2)")
    expect(g.nodes[2].color).toBe("var(--chart-3)")
    // Border stays neutral on every node so the colored dot is the only
    // cluster cue. Now a 50%-opacity foreground stroke for visibility.
    expect(g.nodes[0].border).toBe(
      "color-mix(in srgb, var(--foreground) 50%, transparent)",
    )
    expect(g.nodes[1].border).toBe(
      "color-mix(in srgb, var(--foreground) 50%, transparent)",
    )
  })


  it("wraps the ramp after five nodes", () => {
    const g = layoutGraph({
      layout: "tree",
      nodes: [
        { id: "r" },
        { id: "a" },
        { id: "b" },
        { id: "c" },
        { id: "d" },
        { id: "e" },
      ],
      edges: [
        { a: "r", b: "a" },
        { a: "r", b: "b" },
        { a: "r", b: "c" },
        { a: "r", b: "d" },
        { a: "r", b: "e" },
      ],
    })
    // 6th node (index 5) wraps back to chart-1 on the fill.
    expect(g.nodes[5].color).toBe("var(--chart-1)")
  })


  it("does not auto-color manual layouts (stays neutral)", () => {
    const g = layoutGraph({
      nodes: [
        { id: "A", x: 0, y: 0 },
        { id: "B", x: 50, y: 0 },
      ],
      edges: [],
    })
    expect(g.nodes[0].color).toBe("var(--card)")
    expect(g.nodes[0].border).toBe(
      "color-mix(in srgb, var(--foreground) 50%, transparent)",
    )
  })


  it("respects explicit colors and skips the ramp for that node", () => {
    const g = layoutGraph({
      layout: "force",
      nodes: [{ id: "A", color: "primary" }, { id: "B" }],
      edges: [{ a: "A", b: "B" }],
    })
    // A keeps its explicit color and the neutral default border.
    expect(g.nodes[0].color).toBe("var(--primary)")
    expect(g.nodes[0].border).toBe(
      "color-mix(in srgb, var(--foreground) 50%, transparent)",
    )
    // B is still ramped on the fill; border stays neutral on every node.
    expect(g.nodes[1].color).toBe("var(--chart-2)")
    expect(g.nodes[1].border).toBe(
      "color-mix(in srgb, var(--foreground) 50%, transparent)",
    )
  })
})


describe("layoutGraph — directed flag", () => {
  it("defaults directed to false", () => {
    const g = layoutGraph({ nodes: [{ id: "A", x: 0, y: 0 }], edges: [] })
    expect(g.directed).toBe(false)
  })


  it("carries directed through when set", () => {
    const g = layoutGraph({
      directed: true,
      nodes: [{ id: "A", x: 0, y: 0 }],
      edges: [],
    })
    expect(g.directed).toBe(true)
  })
})
