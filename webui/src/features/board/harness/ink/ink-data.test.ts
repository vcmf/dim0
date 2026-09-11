import { describe, expect, it } from "vitest"
import { asNodeId, createInkGeometry, readInkData, type Node } from "@canvas-harness/core"
import { createDim0InkNode } from "./ink-data"
import { nodeToNote } from "../convert/node-to-note"
import { noteToNode } from "../convert/note-to-node"


describe("official ink integration", () => {
  it("preserves geometry, smoothing, scope and canonical color through a Note reload", () => {
    const samples = [{ x: 10, y: 20, pressure: 0.2 }, { x: 50, y: 60, pressure: 0.9 }]
    const options = { smoothing: 0.8, streamline: 0.7, thinning: 0.5 }
    const geometry = createInkGeometry(samples, 5, options)!
    const node: Node = {
      ...createDim0InkNode({
        id: asNodeId("00000000-0000-4000-8000-000000000001"),
        geometry, samples, size: 5, options,
        style: { strokeColor: "#eeeeee" },
      }, { boardId: "board-1", parentId: "folder-1", color: "#123456" }),
      z: 2,
    }
    const note = nodeToNote(node)
    expect(note.graphUid).toBe("board-1")
    expect(note.parentId).toBe("folder-1")
    expect(note.style.strokeColor).toBe("#123456")
    expect(note.properties.inkData).not.toHaveProperty("outline")
    expect(readInkData(noteToNode(note))).toEqual(geometry.ink)
    expect(noteToNode(note).style?.autoFit).toBe(false)
  })
})
