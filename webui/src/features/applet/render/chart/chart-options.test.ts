import { describe, expect, it } from "vitest"

import { mergeDeep, themedOptions } from "./chart-options"

// Color VALUES come from the browser probe (jsdom can't compute oklch), so we assert
// the merge STRUCTURE + axis-awareness, not the rgb.


describe("mergeDeep", () => {
  it("merges nested plain objects key-by-key (override wins at leaves)", () => {
    const out = mergeDeep({ a: { x: 1, y: 2 }, b: 3 }, { a: { y: 9, z: 4 } })
    expect(out).toEqual({ a: { x: 1, y: 9, z: 4 }, b: 3 })
  })

  it("replaces (not merges) non-object leaves and arrays", () => {
    expect(mergeDeep({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] })
    expect(mergeDeep({ a: 1 }, { a: { x: 1 } })).toEqual({ a: { x: 1 } })
  })
})


describe("themedOptions", () => {
  it("deep-merges an author axis option WITHOUT dropping the themed tick/grid colors", () => {
    const o = themedOptions("line", { scales: { y: { min: 0 } } }) as { scales: { y: Record<string, unknown> } }
    // the skill's own example — y keeps min AND the themed ticks/grid
    expect(o.scales.y.min).toBe(0)
    expect(o.scales.y.ticks).toBeDefined()
    expect(o.scales.y.grid).toBeDefined()
  })

  it("forces animation off even if the author sets it", () => {
    expect(themedOptions("bar", { animation: true }).animation).toBe(false)
  })

  it("is axis-aware: x/y for cartesian, r for radar, none for pie/doughnut", () => {
    expect((themedOptions("bar") as { scales?: Record<string, unknown> }).scales).toHaveProperty("x")
    expect((themedOptions("radar") as { scales?: Record<string, unknown> }).scales).toHaveProperty("r")
    expect((themedOptions("pie") as { scales?: unknown }).scales).toBeUndefined()
    expect((themedOptions("doughnut") as { scales?: unknown }).scales).toBeUndefined()
  })

  it("keeps responsive + non-aspect-ratio for the applet layout box", () => {
    const o = themedOptions("bar")
    expect(o.responsive).toBe(true)
    expect(o.maintainAspectRatio).toBe(false)
  })
})
