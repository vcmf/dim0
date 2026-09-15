import { describe, expect, it } from "vitest"

import { definiteHeight } from "./graph"

// definiteHeight decides the wrapper's CSS height. The canvas is height:100%, so an
// INDEFINITE height ("auto"/""/≤0) must resolve to undefined → the caller sizes from
// the viewBox aspect instead (a 100% canvas in an indefinite box collapses to 0 and
// never draws — the regression the old SVG didn't have).


describe("definiteHeight", () => {
  it("keeps a positive numeric height as px", () => {
    expect(definiteHeight(240)).toBe("240px")
  })

  it("passes a definite CSS-length string through", () => {
    expect(definiteHeight("12rem")).toBe("12rem")
    expect(definiteHeight("50vh")).toBe("50vh")
  })

  it("treats 'auto' (the documented default) as indefinite → size from viewBox", () => {
    expect(definiteHeight("auto")).toBeUndefined()
    expect(definiteHeight("  auto ")).toBeUndefined()
  })

  it("treats an empty string as indefinite", () => {
    expect(definiteHeight("")).toBeUndefined()
    expect(definiteHeight("   ")).toBeUndefined()
  })

  it("ignores a non-positive numeric height (would collapse the canvas)", () => {
    expect(definiteHeight(0)).toBeUndefined()
    expect(definiteHeight(-10)).toBeUndefined()
  })

  it("is indefinite when height is omitted", () => {
    expect(definiteHeight(undefined)).toBeUndefined()
  })
})
