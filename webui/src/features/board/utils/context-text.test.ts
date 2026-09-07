import { describe, expect, it } from "vitest"
import type { NoteNode } from "@/features/board/types/flow"
import { buildContextTextFromNodes } from "./context-text"


// Minimal NoteNode whose `data` is the Dim0 Note-like shape the builder reads.
const note = (over: Record<string, unknown> = {}): NoteNode =>
  ({
    id: "n1",
    data: {
      id: "n1",
      label: { markdown: "Cats" },
      style: { type: "rect" },
      properties: {
        nodePosition: { position: { x: 40.4, y: 12.6 } },
        nodeSize: { size: { width: 320, height: 180 } },
        ...(over.properties as object | undefined),
      },
      ...over,
    },
  }) as unknown as NoteNode


describe("buildContextTextFromNodes", () => {
  it("includes rounded position and size in the structured block", () => {
    const text = buildContextTextFromNodes([note()])
    expect(text).toContain("NoteId: n1")
    expect(text).toContain("NoteType: rect")
    expect(text).toContain("Pos: (40, 13)") // rounded
    expect(text).toContain("Size: 320x180")
    expect(text).toContain("Content: Cats")
  })

  it("omits Pos/Size when the note has no position/size", () => {
    const bare = { id: "n2", data: { id: "n2", label: { markdown: "Dogs" }, style: { type: "rect" } } } as unknown as NoteNode
    const text = buildContextTextFromNodes([bare])
    expect(text).toContain("NoteId: n2")
    expect(text).not.toContain("Pos:")
    expect(text).not.toContain("Size:")
  })

  it("skipPrefix yields plain text only — no spatial block", () => {
    const text = buildContextTextFromNodes([note()], { skipPrefix: true })
    expect(text).toBe("Cats")
    expect(text).not.toContain("Pos:")
    expect(text).not.toContain("<SelectedNote>")
  })
})
