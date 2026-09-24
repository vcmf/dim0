import { describe, expect, it } from "vitest"
import { BOARD_CONTENT_KINDS, isBoardContentKind } from "./list-board-contents"


describe("isBoardContentKind", () => {
  it("accepts the sidebar-tree custom surfaces, including applets", () => {
    for (const kind of ["sheet", "folder", "code-sandbox", "applet"]) {
      expect(isBoardContentKind(kind)).toBe(true)
    }
  })

  it("rejects deprecated custom types, plain shapes, and empty input", () => {
    // Shapes by both names: display `styleType` ("rectangle") and canvas `type` ("rect").
    for (const kind of ["widget", "mini-app", "rectangle", "rect", "ellipse", "note", "document", "", null, undefined]) {
      expect(isBoardContentKind(kind)).toBe(false)
    }
  })

  it("matches the exported kind list exactly", () => {
    expect([...BOARD_CONTENT_KINDS].sort()).toEqual(["applet", "code-sandbox", "folder", "sheet"])
  })
})
