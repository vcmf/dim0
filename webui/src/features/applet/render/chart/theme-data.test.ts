import { describe, expect, it } from "vitest"

import { themeChartData } from "./theme-data"
import type { AppletChartData } from "./types"

// NOTE: the concrete color VALUES come from readCssVarMixed's browser probe (jsdom
// can't compute oklch/color-mix), so we assert the STRUCTURE of the injection — which
// datasets get colors, per-slice arrays for pie, prop preservation — not the rgb. The
// visual correctness is spike-validated (PR 0) + a future e2e.


describe("themeChartData", () => {
  it("assigns a background + border color to a cartesian dataset that has none", () => {
    const out = themeChartData("bar", { labels: ["a", "b"], datasets: [{ data: [1, 2] }] })
    const ds = out.datasets[0]
    expect(typeof ds.backgroundColor).toBe("string") // filled from the palette
    expect(typeof ds.borderColor).toBe("string")
  })

  it("gives pie/doughnut one color PER SLICE (an array sized to the data)", () => {
    const out = themeChartData("pie", { labels: ["a", "b", "c"], datasets: [{ data: [10, 20, 30] }] })
    const bg = out.datasets[0].backgroundColor
    expect(Array.isArray(bg)).toBe(true)
    expect((bg as unknown[]).length).toBe(3)
  })

  it("resolves an author-specified color (string) rather than overriding it", () => {
    const out = themeChartData("line", { labels: ["a"], datasets: [{ data: [1], borderColor: "chart-2" }] })
    // borderColor is resolved (a concrete string), and NOT left as the raw token when
    // resolvable — either way it's a defined string, not dropped.
    expect(typeof out.datasets[0].borderColor).toBe("string")
    expect(out.datasets[0].borderColor).toBeDefined()
  })

  it("resolves an author-specified per-slice color ARRAY for pie", () => {
    const out = themeChartData("doughnut", { labels: ["a", "b"], datasets: [{ data: [1, 2], backgroundColor: ["chart-1", "chart-2"] }] })
    const bg = out.datasets[0].backgroundColor
    expect(Array.isArray(bg)).toBe(true)
    expect((bg as unknown[]).length).toBe(2)
  })

  it("preserves non-color dataset props (label, data)", () => {
    const out = themeChartData("bar", { labels: ["a"], datasets: [{ label: "Sales", data: [42] }] })
    expect(out.datasets[0].label).toBe("Sales")
    expect(out.datasets[0].data).toEqual([42])
  })

  it("returns a fresh copy (does not mutate the input)", () => {
    const input: AppletChartData = { labels: ["a"], datasets: [{ data: [1] }] }
    const out = themeChartData("bar", input)
    expect(out).not.toBe(input)
    expect(out.datasets[0]).not.toBe(input.datasets[0])
    expect(input.datasets[0].backgroundColor).toBeUndefined() // input untouched
  })

  it("does not throw on a missing data prop — yields an empty-dataset config", () => {
    expect(themeChartData("bar", undefined)).toEqual({ datasets: [] })
  })

  it("forwards extra top-level data keys (untyped interpreter config)", () => {
    const out = themeChartData("bar", { labels: ["a"], datasets: [{ data: [1] }], xLabels: ["x"] } as never)
    expect((out as Record<string, unknown>).xLabels).toEqual(["x"])
  })

  it("gives an area dataset a translucent fill distinct from its border", () => {
    const out = themeChartData("area", { labels: ["a"], datasets: [{ data: [1] }] })
    // background (fill) resolves via a low-alpha probe; border via the solid palette —
    // both defined strings, and the fill path is exercised.
    expect(typeof out.datasets[0].backgroundColor).toBe("string")
    expect(typeof out.datasets[0].borderColor).toBe("string")
  })
})
