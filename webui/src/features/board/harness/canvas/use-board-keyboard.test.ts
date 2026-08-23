import { describe, expect, it } from "vitest"
import { decideBoardEscape, type EscapeAppState } from "./use-board-keyboard"


type EscKey = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">


/** A bare Escape press (no modifiers). */
const escape = (over: Partial<EscKey> = {}): EscKey => ({
  key: "Escape",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
})


/** Board state with a create tool active on the canvas and no overlay open. */
const appState = (over: Partial<EscapeAppState> = {}): EscapeAppState => ({
  viewMode: "board",
  chromeDialog: null,
  activeNodeSurface: null,
  presentationMode: false,
  chatSheetOpen: false,
  tool: "rect",
  ...over,
})


const dom = (over: Partial<{ isTyping: boolean; insideOverlayDom: boolean }> = {}) => ({
  isTyping: false,
  insideOverlayDom: false,
  ...over,
})


describe("decideBoardEscape", () => {
  it("switches a create tool back to select (the core feature)", () => {
    expect(decideBoardEscape(escape(), appState({ tool: "rect" }), dom())).toBe("switch-to-select")
    expect(decideBoardEscape(escape(), appState({ tool: "arrow" }), dom())).toBe("switch-to-select")
  })

  it("is a no-op when the tool is already select (library owns the 2nd-press deselect)", () => {
    // Two-step parity: with nothing to put away we don't consume, so the
    // harness's own Escape handler runs and deselects.
    expect(decideBoardEscape(escape(), appState({ tool: "select" }), dom())).toBe("no-op")
  })

  it("ignores non-Escape keys and modified Escape presses", () => {
    expect(decideBoardEscape(escape({ key: "a" }), appState(), dom())).toBe("no-op")
    expect(decideBoardEscape(escape({ metaKey: true }), appState(), dom())).toBe("no-op")
    expect(decideBoardEscape(escape({ ctrlKey: true }), appState(), dom())).toBe("no-op")
    expect(decideBoardEscape(escape({ altKey: true }), appState(), dom())).toBe("no-op")
    expect(decideBoardEscape(escape({ shiftKey: true }), appState(), dom())).toBe("no-op")
  })

  it("ignores Escape while typing", () => {
    expect(decideBoardEscape(escape(), appState(), dom({ isTyping: true }))).toBe("no-op")
  })

  it("is a no-op off the board canvas (files / list views)", () => {
    expect(decideBoardEscape(escape(), appState({ viewMode: "files" }), dom())).toBe("no-op")
    expect(decideBoardEscape(escape(), appState({ viewMode: "list" }), dom())).toBe("no-op")
  })

  it("defers to store-tracked overlays instead of resetting the tool (#244/#245)", () => {
    const cases: Partial<EscapeAppState>[] = [
      { chromeDialog: "shape-menu" },
      { activeNodeSurface: { nodeId: "n1", kind: "sheet" } },
      { presentationMode: true },
      { chatSheetOpen: true }, // non-modal → focus on canvas, needs the flag
    ]
    for (const over of cases) {
      expect(decideBoardEscape(escape(), appState(over), dom())).toBe("defer-to-overlay")
    }
  })

  it("defers when the Escape is focused inside a store-less Radix overlay (#244)", () => {
    // Covers Select / combobox / listbox / popover — matched via the DOM guard,
    // surfaced here as `insideOverlayDom`.
    expect(decideBoardEscape(escape(), appState(), dom({ insideOverlayDom: true }))).toBe(
      "defer-to-overlay",
    )
  })

  it("checks typing before overlay state (a focused input always wins)", () => {
    expect(
      decideBoardEscape(escape(), appState({ chromeDialog: "shape-menu" }), dom({ isTyping: true })),
    ).toBe("no-op")
  })
})
