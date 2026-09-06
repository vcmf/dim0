// Guards that every node type with "no inline text-editor on dbl-click"
// behavior is treated as "custom" by BOTH consumer paths: the
// double-click handler (no inline beginEdit) and the sticky style memory
// (no style bleed). Two flavors live in this set:
//   - Dim0's custom node defs (sheet, widget, etc.) — their editing
//     surface is elsewhere (expand dialog, side panel, folder nav).
//   - canvas-harness built-ins with no text concept (icon, image) — the
//     inline editor would open an invisible text caret on top of the
//     glyph and any typed text would land as junk `node.content`.
//
// The Dim0-custom subset should match `node-types/index.ts → boardNodeTypes`.
// We assert against a local list rather than importing the registry —
// that pulls in every iframe-backed node view and adds ~12s of import
// cost to the suite.
import { describe, expect, it } from "vitest"
import { CUSTOM_NODE_TYPES } from "./custom-node-types"
import { isStylableNodeType } from "./use-style-memory"


const EXPECTED_CUSTOM_TYPES = [
  "folder",
  "document",
  "widget",
  "mini-app",
  "code-sandbox",
  "sheet",
  "ink",
  // No text concept — dbl-click must not open the lib's inline editor.
  "icon",
  "image",
  "frame",
].sort()


describe("custom node type exclusions", () => {
  it("registers every custom node type for the dbl-click override", () => {
    expect([...CUSTOM_NODE_TYPES].sort()).toEqual(EXPECTED_CUSTOM_TYPES)
  })


  it("excludes every custom node type from sticky style memory", () => {
    for (const type of EXPECTED_CUSTOM_TYPES) {
      expect(isStylableNodeType(type)).toBe(false)
    }
  })


  it("keeps the two exclusion sets in agreement (no type custom in one path only)", () => {
    for (const type of CUSTOM_NODE_TYPES) {
      expect(isStylableNodeType(type)).toBe(false)
    }
  })


  it("covers mini-app specifically (the original gap)", () => {
    expect(CUSTOM_NODE_TYPES.has("mini-app")).toBe(true)
    expect(isStylableNodeType("mini-app")).toBe(false)
  })


  it("leaves built-in primitive types editable + stylable", () => {
    expect(CUSTOM_NODE_TYPES.has("rect")).toBe(false)
    expect(isStylableNodeType("rect")).toBe(true)
  })
})
