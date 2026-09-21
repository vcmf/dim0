import { afterEach, describe, expect, it } from "vitest"
import type { Node } from "@canvas-harness/core"
import { createDefaultNote } from "@/features/board/types/note"
import type { Note } from "@/features/board/types/note"
import { createDefaultLink } from "@/features/board/types/link"
import type { NodeType } from "@/features/board/types/style"
import { setBoardThemeMode } from "../theme/theme-mode-ref"
import { edgeToLink } from "./edge-to-link"
import { linkToEdge } from "./link-to-edge"
import { dim0TypeToCanvas } from "./node-type"
import { nodeToNote } from "./node-to-note"
import { noteToNode } from "./note-to-node"


const BOARD_ID = "test-board"


const NODE_TYPES: NodeType[] = [
  "rectangle",
  "ellipse",
  "diamond",
  "soft-diamond",
  "tag",
  "layered-circle",
  "layered-rectangle",
  "layered-diamond",
  "thought-cloud",
  "capsule",
  "text",
  "image",
  "icon",
  "sheet",
  "slide",
  "folder",
  "code-sandbox",
  "widget",
]


const positionedNote = (id: string, x: number, y: number, w: number, h: number): Note => {
  const n = createDefaultNote({ boardId: BOARD_ID, nodeType: "rectangle" })
  n.id = id
  n.properties.nodePosition = { type: "position", position: { x, y } }
  n.properties.nodeSize = { type: "size", size: { width: w, height: h } }
  return n
}


describe("type rename map (Dim0 ↔ canvas-harness)", () => {
  const RENAMES: ReadonlyArray<[NodeType, string]> = [
    ["rectangle", "rect"],
    ["layered-rectangle", "layered-rect"],
    ["layered-circle", "layered-ellipse"],
    ["slide", "frame"],
  ]

  it.each(RENAMES)("Dim0 %s → canvas-harness %s on noteToNode", (dim0Type, canvasType) => {
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType: dim0Type })
    const node = noteToNode(note)
    expect(node.type).toBe(canvasType)
  })

  it.each(RENAMES)("canvas-harness %2$s → Dim0 %1$s on nodeToNote round-trip", (dim0Type) => {
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType: dim0Type })
    const back = nodeToNote(noteToNode(note))
    expect(back.style.type).toBe(dim0Type)
  })

  it("passes unrecognized custom types through unchanged", () => {
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType: "sheet" })
    const node = noteToNode(note)
    expect(node.type).toBe("sheet")
    const back = nodeToNote(node)
    expect(back.style.type).toBe("sheet")
  })

  it("overrides canvas type to 'document' for note.type==='document'", () => {
    const base = createDefaultNote({ boardId: BOARD_ID, nodeType: "rectangle" })
    const doc: Note = { ...base, type: "document" }
    const node = noteToNode(doc)
    expect(node.type).toBe("document")

    const back = nodeToNote(node)
    expect(back.type).toBe("document")
    // style.type round-trips via data.styleType.
    expect(back.style.type).toBe("rectangle")
  })
})


describe("note ↔ node round-trip", () => {
  it.each(NODE_TYPES)("preserves core fields for %s", (nodeType) => {
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType })
    note.content = { markdown: "hello world" }
    note.style.angle = 30
    note.style.opacity = 80
    note.properties.nodePosition = { type: "position", position: { x: 123, y: 456 } }
    note.properties.nodeSize = { type: "size", size: { width: 200, height: 150 } }
    note.properties.nodeZIndex = { type: "number", number: 5 }

    const node = noteToNode(note)
    expect(node.id as unknown as string).toBe(note.id)
    expect(node.type).toBe(dim0TypeToCanvas(nodeType))
    expect(node.x).toBe(123)
    expect(node.y).toBe(456)
    expect(node.w).toBe(200)
    expect(node.h).toBe(150)
    expect(node.z).toBe(5)
    expect(node.angle).toBeCloseTo((30 * Math.PI) / 180)
    expect(node.content).toBe("hello world")
    expect(node.style?.opacity).toBe(80)

    const back = nodeToNote(node)
    expect(back.id).toBe(note.id)
    expect(back.style.type).toBe(nodeType)
    expect(back.style.angle).toBeCloseTo(30)
    expect(back.style.opacity).toBeCloseTo(80)
    expect(back.properties.nodePosition.position).toEqual({ x: 123, y: 456 })
    expect(back.properties.nodeSize.size).toEqual({ width: 200, height: 150 })
    expect(back.properties.nodeZIndex.number).toBe(5)
    expect(back.content?.markdown).toBe("hello world")
  })

  it("lifts groupIds onto Node.groups and round-trips them", () => {
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType: "ellipse" })
    note.style.groupIds = ["g-1", "g-2"]

    const node = noteToNode(note)
    expect(node.groups as unknown as string[]).toEqual(["g-1", "g-2"])

    const back = nodeToNote(node)
    expect(back.style.groupIds).toEqual(["g-1", "g-2"])
  })

  it("preserves extra properties (emoji, pinned, slideName) via data.properties", () => {
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType: "slide" })
    note.properties.emoji = { type: "icon", icon: { type: "emoji", emoji: "🎯" } }
    note.properties.pinned = { type: "boolean", boolean: true }
    note.properties.slideName = { type: "text", text: "Intro" }

    const node = noteToNode(note)
    const back = nodeToNote(node)

    expect(back.properties.emoji).toEqual(note.properties.emoji)
    expect(back.properties.pinned).toEqual(note.properties.pinned)
    expect(back.properties.slideName).toEqual(note.properties.slideName)
  })

  it("round-trips the phosphor icon variant with a hex color", () => {
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType: "sheet" })
    note.properties.iconData = {
      type: "icon",
      icon: { type: "phosphor", name: "Lightbulb", color: "#dc2626" },
    }

    const back = nodeToNote(noteToNode(note))

    expect(back.properties.iconData).toEqual(note.properties.iconData)
  })

  it("round-trips the phosphor variant with a CSS variable color (theme token)", () => {
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType: "sheet" })
    note.properties.iconData = {
      type: "icon",
      icon: { type: "phosphor", name: "Heart", color: "var(--color-foreground)" },
    }

    const back = nodeToNote(noteToNode(note))

    expect(back.properties.iconData).toEqual(note.properties.iconData)
  })

  it("round-trips the phosphor variant with no color set", () => {
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType: "sheet" })
    note.properties.iconData = {
      type: "icon",
      icon: { type: "phosphor", name: "Rocket" },
    }

    const back = nodeToNote(noteToNode(note))

    expect(back.properties.iconData).toEqual(note.properties.iconData)
  })

  it("drops content when node.content is empty (avoids spurious body)", () => {
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType: "rectangle" })
    note.content = undefined

    const node = noteToNode(note)
    expect(node.content).toBe("")

    const back = nodeToNote(node)
    expect(back.content).toBeUndefined()
  })

  it("preserves label (title) separately from content (body)", () => {
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType: "sheet" })
    note.label = { markdown: "Daily notes" }
    note.content = { markdown: "## Section 1\n- bullet" }

    const node = noteToNode(note)
    // node.content carries the body (visible inline text)
    expect(node.content).toBe("## Section 1\n- bullet")

    const back = nodeToNote(node)
    expect(back.label?.markdown).toBe("Daily notes")
    expect(back.content?.markdown).toBe("## Section 1\n- bullet")
  })

  it("falls back to legacy label-as-text when note.content is absent", () => {
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType: "rectangle" })
    note.label = { markdown: "legacy text" }
    note.content = undefined

    const node = noteToNode(note)
    expect(node.content).toBe("legacy text")

    const back = nodeToNote(node)
    // Label preserved on data; the text is now also written to content on save.
    expect(back.label?.markdown).toBe("legacy text")
    expect(back.content?.markdown).toBe("legacy text")
  })

  it("preserves identity fields (version, graphUid, parentId, roughSeed)", () => {
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType: "rectangle" })
    note.parentId = "parent-node"
    note.version = 7
    note.roughSeed = 12345

    const back = nodeToNote(noteToNode(note))
    expect(back.version).toBe(7)
    expect(back.graphUid).toBe(BOARD_ID)
    expect(back.parentId).toBe("parent-node")
    expect(back.roughSeed).toBe(12345)
  })
})


describe("ink node round-trip", () => {
  // A synthetic committed stroke — the shape canvas-harness stores at
  // node.data.ink (InkStrokeData). Geometry only; color rides on style.
  const inkGeometry = {
    type: "ink" as const,
    version: 1 as const,
    size: 6,
    points: [
      [0, 0, 0.4],
      [12, 8, 0.7],
      [30, 20, 0.55],
    ] as Array<[number, number, number]>,
    intrinsicWidth: 30,
    intrinsicHeight: 20,
    thinning: 0.68,
  }

  it("maps Dim0 'ink' ↔ canvas-harness 'ink'", () => {
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType: "ink" })
    const node = noteToNode(note)
    expect(node.type).toBe("ink")
    expect(nodeToNote(node).style.type).toBe("ink")
  })

  it("lifts inkData → node.data.ink and restores it on save", () => {
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType: "ink" })
    note.properties.inkData = inkGeometry

    const node = noteToNode(note)
    // Engine reads geometry off node.data.ink, not off a Note property.
    expect((node.data as { ink?: unknown }).ink).toEqual(inkGeometry)
    // Geometry is carried once: not duplicated in the data.properties bag.
    const props = (node.data as { properties?: { inkData?: unknown } }).properties
    expect(props?.inkData).toBeUndefined()

    const back = nodeToNote(node)
    expect(back.properties.inkData).toEqual(inkGeometry)
  })

  it("does not attach inkData to a non-ink node carrying stray data.ink", () => {
    // A rect that (e.g. via a type change or malformed op) still has a
    // data.ink blob must not persist ink geometry onto a non-ink Note.
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType: "rectangle" })
    const node = noteToNode(note)
    const stray = { ...node, data: { ...(node.data as object), ink: inkGeometry } } as Node

    const back = nodeToNote(stray)
    expect(back.style.type).toBe("rectangle")
    expect(back.properties.inkData).toBeUndefined()
  })

  it("carries stroke color/opacity via style, not geometry", () => {
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType: "ink" })
    note.properties.inkData = inkGeometry
    note.style.strokeColor = "#7c3aed"
    note.style.opacity = 70

    const node = noteToNode(note)
    expect(node.style?.strokeColor).toBe("#7c3aed")
    expect(node.style?.opacity).toBe(70)

    const back = nodeToNote(node)
    expect(back.style.strokeColor).toBe("#7c3aed")
    expect(back.style.opacity).toBeCloseTo(70)
  })
})


describe("link ↔ edge round-trip", () => {
  const makeNodes = (): Map<string, Node> => {
    const noteA = positionedNote("node-a", 100, 100, 200, 100)
    const noteB = positionedNote("node-b", 500, 300, 200, 100)
    return new Map([
      ["node-a", noteToNode(noteA)],
      ["node-b", noteToNode(noteB)],
    ])
  }

  it("attached source + attached target with default centers", () => {
    const link = createDefaultLink(BOARD_ID, "node-a", "node-b")
    const nodes = makeNodes()
    const edge = linkToEdge(link, nodes)

    expect("nodeId" in edge.source).toBe(true)
    expect("nodeId" in edge.target).toBe(true)
    if ("nodeId" in edge.source) {
      expect(edge.source.nodeId as unknown as string).toBe("node-a")
      expect(edge.source.localOffset).toEqual({ x: 100, y: 50 })
    }
    if ("nodeId" in edge.target) {
      expect(edge.target.nodeId as unknown as string).toBe("node-b")
      expect(edge.target.localOffset).toEqual({ x: 100, y: 50 })
    }

    // Save now always emits position + isLocalOffset for attached
    // endpoints (drops the "omit at center" shortcut).
    const back = edgeToLink(edge, nodes)
    expect(back.source).toBe("node-a")
    expect(back.target).toBe("node-b")
    expect(back.properties.startPoint).toEqual({
      type: "position",
      position: { x: 100, y: 50 },
      isLocalOffset: true,
    })
    expect(back.properties.endPoint).toEqual({
      type: "position",
      position: { x: 100, y: 50 },
      isLocalOffset: true,
    })
  })

  it("legacy attached source (world coords) → upgraded to local offset on save", () => {
    // Legacy wire format: position is world, no isLocalOffset flag.
    const link = createDefaultLink(BOARD_ID, "node-a", "node-b")
    link.properties.startPoint = { type: "position", position: { x: 200, y: 130 } }

    const nodes = makeNodes()
    const edge = linkToEdge(link, nodes)

    // Loaded localOffset is computed from worldPoint - node.x/y.
    if ("nodeId" in edge.source) {
      expect(edge.source.localOffset).toEqual({ x: 100, y: 30 })
    }
    // Legacy marker stashed on edge data — used by the persist diff to
    // cascade resave when the attached node moves.
    expect(edge.data).toMatchObject({ sourceLegacyOffset: true })

    // Save emits the new format: position is the local offset, flag is set.
    const back = edgeToLink(edge, nodes)
    expect(back.source).toBe("node-a")
    expect(back.properties.startPoint).toEqual({
      type: "position",
      position: { x: 100, y: 30 },
      isLocalOffset: true,
    })
  })

  it("new-format attached source (isLocalOffset=true) round-trips identically", () => {
    const link = createDefaultLink(BOARD_ID, "node-a", "node-b")
    link.properties.startPoint = {
      type: "position",
      position: { x: 100, y: 30 },
      isLocalOffset: true,
    }

    const nodes = makeNodes()
    const edge = linkToEdge(link, nodes)

    if ("nodeId" in edge.source) {
      // Local offset is the position as-is — no math against node.x/y.
      expect(edge.source.localOffset).toEqual({ x: 100, y: 30 })
    }
    // No legacy marker — this edge doesn't need the cascade.
    expect(edge.data).not.toMatchObject({ sourceLegacyOffset: true })

    const back = edgeToLink(edge, nodes)
    expect(back.properties.startPoint).toEqual({
      type: "position",
      position: { x: 100, y: 30 },
      isLocalOffset: true,
    })
  })

  it("free source endpoint (sentinel '' source + startPoint)", () => {
    const link = createDefaultLink(BOARD_ID, "", "node-b")
    link.properties.startPoint = { type: "position", position: { x: 50, y: 60 } }

    const nodes = makeNodes()
    const edge = linkToEdge(link, nodes)

    expect("worldPoint" in edge.source).toBe(true)
    if ("worldPoint" in edge.source) {
      expect(edge.source.worldPoint).toEqual({ x: 50, y: 60 })
    }

    // Free endpoint: position stays world, isLocalOffset = false.
    const back = edgeToLink(edge, nodes)
    expect(back.source).toBe("")
    expect(back.properties.startPoint).toEqual({
      type: "position",
      position: { x: 50, y: 60 },
      isLocalOffset: false,
    })
  })

  it("free source + free target", () => {
    const link = createDefaultLink(BOARD_ID, "", "")
    link.properties.startPoint = { type: "position", position: { x: 10, y: 20 } }
    link.properties.endPoint = { type: "position", position: { x: 30, y: 40 } }

    const nodes = makeNodes()
    const edge = linkToEdge(link, nodes)

    expect("worldPoint" in edge.source).toBe(true)
    expect("worldPoint" in edge.target).toBe(true)

    const back = edgeToLink(edge, nodes)
    expect(back.source).toBe("")
    expect(back.target).toBe("")
    expect(back.properties.startPoint).toEqual({
      type: "position",
      position: { x: 10, y: 20 },
      isLocalOffset: false,
    })
    expect(back.properties.endPoint).toEqual({
      type: "position",
      position: { x: 30, y: 40 },
      isLocalOffset: false,
    })
  })

  it("edge control point round-trips through midpoint↔cubic conversion", () => {
    // Wire format stores the midpoint the curve passes through at t=0.5.
    // Canvas-harness wants [c1, c2] cubic control points. The convert
    // layer does the conversion in both directions; assert the midpoint
    // round-trips even though the in-memory cubic values are derived.
    const link = createDefaultLink(BOARD_ID, "node-a", "node-b")
    link.properties.edgeControlPoint = { type: "position", position: { x: 300, y: 200 } }
    link.label = { markdown: "depends on" }

    const nodes = makeNodes()
    const edge = linkToEdge(link, nodes)
    // node-a at (100, 100, 200, 100) → center (200, 150)
    // node-b at (500, 300, 200, 100) → center (600, 350)
    // midpoint (300, 200) → c = (8M - S - T)/6
    //   c.x = (8·300 - 200 - 600)/6 = 1600/6 ≈ 266.67
    //   c.y = (8·200 - 150 - 350)/6 = 1100/6 ≈ 183.33
    expect(edge.control).toHaveLength(2)
    expect(edge.control?.[0].x).toBeCloseTo(1600 / 6)
    expect(edge.control?.[0].y).toBeCloseTo(1100 / 6)
    expect(edge.control?.[1]).toEqual(edge.control?.[0]) // symmetric split
    expect(edge.content).toBe("depends on")

    const back = edgeToLink(edge, nodes)
    expect(back.properties.edgeControlPoint.position?.x).toBeCloseTo(300)
    expect(back.properties.edgeControlPoint.position?.y).toBeCloseTo(200)
    expect(back.label?.markdown).toBe("depends on")
  })

  it("no control point means no midpoint on save", () => {
    const link = createDefaultLink(BOARD_ID, "node-a", "node-b")
    const nodes = makeNodes()
    const edge = linkToEdge(link, nodes)
    expect(edge.control).toBeUndefined()

    const back = edgeToLink(edge, nodes)
    // Wire shape is preserved: edgeControlPoint exists but has no position.
    expect(back.properties.edgeControlPoint.position).toBeUndefined()
  })

  it("preserves arrowheads + pathStyle", () => {
    const link = createDefaultLink(BOARD_ID, "node-a", "node-b")
    link.style.sourceArrowhead = "barb"
    link.style.targetArrowhead = "arrow"
    link.style.pathStyle = "polyline"

    const nodes = makeNodes()
    const back = edgeToLink(linkToEdge(link, nodes), nodes)

    expect(back.style.sourceArrowhead).toBe("barb")
    expect(back.style.targetArrowhead).toBe("arrow")
    expect(back.style.pathStyle).toBe("polyline")
  })

  it("lifts link groupIds onto Edge.groups", () => {
    const link = createDefaultLink(BOARD_ID, "node-a", "node-b")
    link.style.groupIds = ["g-x", "g-y"]

    const nodes = makeNodes()
    const edge = linkToEdge(link, nodes)
    expect(edge.groups as unknown as string[]).toEqual(["g-x", "g-y"])

    const back = edgeToLink(edge, nodes)
    expect(back.style.groupIds).toEqual(["g-x", "g-y"])
  })
})


describe("dark-mode color projection", () => {
  // Theme mode is a module-level singleton. Reset to light after each
  // case so unrelated suites don't see dark-adapted styles.
  afterEach(() => {
    setBoardThemeMode("light")
  })

  it("light mode keeps node.style colors identical to stored", () => {
    setBoardThemeMode("light")
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType: "rectangle" })
    note.style.backgroundColor = "#fde047" // tailwind yellow-300
    note.style.strokeColor = "#1d4ed8"
    note.style.textColor = "#0f172a"

    const node = noteToNode(note)
    expect(node.style?.backgroundColor).toBe("#fde047")
    expect(node.style?.strokeColor).toBe("#1d4ed8")
    expect(node.style?.textColor).toBe("#0f172a")
  })

  it("dark mode adapts node.style colors but stashes originals on data._storedColors", () => {
    setBoardThemeMode("dark")
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType: "rectangle" })
    note.style.backgroundColor = "#fde047"
    note.style.strokeColor = "#1d4ed8"
    note.style.textColor = "#0f172a"

    const node = noteToNode(note)
    // Displayed values diverge from stored.
    expect(node.style?.backgroundColor).not.toBe("#fde047")
    expect(node.style?.strokeColor).not.toBe("#1d4ed8")
    // Stored values survive verbatim on data._storedColors.
    const data = node.data as { _storedColors?: Record<string, string> }
    expect(data._storedColors?.backgroundColor).toBe("#fde047")
    expect(data._storedColors?.strokeColor).toBe("#1d4ed8")
    expect(data._storedColors?.textColor).toBe("#0f172a")
  })

  it("nodeToNote reads stored colors regardless of mode (no dark colors round-tripped to server)", () => {
    setBoardThemeMode("dark")
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType: "rectangle" })
    note.style.backgroundColor = "#fde047"
    note.style.strokeColor = "#1d4ed8"
    note.style.textColor = "#0f172a"

    const node = noteToNode(note)
    const back = nodeToNote(node)
    expect(back.style.backgroundColor).toBe("#fde047")
    expect(back.style.strokeColor).toBe("#1d4ed8")
    expect(back.style.textColor).toBe("#0f172a")
  })

  it("legacy nodes without data._storedColors save using node.style as-is", () => {
    setBoardThemeMode("light")
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType: "rectangle" })
    note.style.backgroundColor = "#fde047"
    const node = noteToNode(note)
    // Simulate a legacy in-memory node that pre-dates _storedColors.
    const legacy = {
      ...node,
      data: { ...(node.data as object), _storedColors: undefined },
    } as Node
    const back = nodeToNote(legacy)
    expect(back.style.backgroundColor).toBe("#fde047")
  })

  it("edges adapt stroke + text color in dark mode and round-trip the originals", () => {
    setBoardThemeMode("dark")
    const link = createDefaultLink(BOARD_ID, "a", "b")
    link.style.strokeColor = "#a78bfa" // violet-400
    link.style.textColor = "#f59e0b" // amber-500
    const edge = linkToEdge(link, new Map())
    expect(edge.style?.strokeColor).not.toBe("#a78bfa")
    const data = edge.data as { _storedColors?: Record<string, string> }
    expect(data._storedColors?.strokeColor).toBe("#a78bfa")
    expect(data._storedColors?.textColor).toBe("#f59e0b")

    const back = edgeToLink(edge, new Map())
    expect(back.style.strokeColor).toBe("#a78bfa")
    expect(back.style.textColor).toBe("#f59e0b")
  })


  it("mirrors textColor → iconColor so SVG glyphs follow the text-color semantic", () => {
    // Tailwind convention: `text-foreground` on an <svg> propagates to
    // currentColor, which colors the glyph. canvas-harness's paintIconNode
    // reads style.iconColor to substitute currentColor before rasterizing.
    // applyColorsToStyle mirrors textColor → iconColor so the icon's glyph
    // color tracks the text/foreground color across every code path
    // (initial convert, theme flip, color picker, incoming collab op) for
    // free — same projection function is called from each.
    setBoardThemeMode("light")
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType: "icon" })
    note.style.textColor = "#3b82f6"

    const lightNode = noteToNode(note)
    expect(lightNode.style?.iconColor).toBe("#3b82f6")
    expect(lightNode.style?.textColor).toBe("#3b82f6")

    // Dark mode: textColor projects via darkModeDisplayHex; iconColor
    // tracks the projected value, not the stored one. No separate
    // adaptation logic — same hex transform, same result.
    setBoardThemeMode("dark")
    const darkNode = noteToNode(note)
    expect(darkNode.style?.iconColor).toBeTruthy()
    expect(darkNode.style?.iconColor).toBe(darkNode.style?.textColor)
  })


  it("default black textColor inverts to white-ish in dark mode for icon glyphs", () => {
    // The original "icon doesn't adapt to theme on the canvas" bug: no
    // user color picked → textColor is the default BLACK_HEX → in dark
    // mode darkModeDisplayHex("#000000") returns "#ffffff", and that
    // value flows to iconColor via the mirror. So default icons render
    // black-on-light and white-on-dark automatically.
    const note = createDefaultNote({ boardId: BOARD_ID, nodeType: "icon" })
    expect(note.style.textColor).toBe("#000000")

    setBoardThemeMode("dark")
    const darkNode = noteToNode(note)
    expect(darkNode.style?.iconColor).toBe("#ffffff")
  })
})
