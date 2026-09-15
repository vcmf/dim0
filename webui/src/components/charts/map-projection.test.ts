import { describe, expect, it, vi } from "vitest"

import type { Feature, Geometry, GeoJsonProperties } from "geojson"

import {
  buildFillResolver,
  buildProjection,
  projectMarkers,
} from "./map-projection"


// A trivial resolver: identity for ids it knows, null otherwise. Stands in
// for the atlas name→id resolver so these stay pure (no geometry load).
function fakeResolve(known: string[]): (k: string) => string | null {
  const set = new Set(known)
  return (k) => (set.has(k) ? k : null)
}


// One square polygon covering a chunk of the globe, enough for d3-geo to
// produce a real path + project points.
function squareFeature(id: string): Feature<Geometry, GeoJsonProperties> {
  return {
    type: "Feature",
    id,
    properties: { name: `Region ${id}` },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-10, -10],
          [10, -10],
          [10, 10],
          [-10, 10],
          [-10, -10],
        ],
      ],
    },
  }
}


describe("buildFillResolver", () => {
  const resolve = fakeResolve(["A", "B", "C"])

  it("returns the no-data fill for regions absent from the data", () => {
    const fill = buildFillResolver([{ id: "A", value: 1 }], resolve, "chart-1")
    expect(fill("B")).toBe("var(--muted)")
  })

  it("honors an explicit per-region color over value shading", () => {
    const fill = buildFillResolver(
      [{ id: "A", value: 5, color: "primary" }],
      resolve,
      "chart-1",
    )
    expect(fill("A")).toBe("var(--primary)")
  })

  it("shades by value: min region lighter than max region", () => {
    const fill = buildFillResolver(
      [
        { id: "A", value: 0 },
        { id: "B", value: 100 },
      ],
      resolve,
      "chart-1",
    )
    // Both are color-mix of chart-1 into muted; max carries a higher %.
    const a = fill("A")
    const b = fill("B")
    expect(a).toContain("color-mix")
    expect(b).toContain("color-mix")
    const pctA = Number(/\s(\d+)%/.exec(a)?.[1])
    const pctB = Number(/\s(\d+)%/.exec(b)?.[1])
    expect(pctB).toBeGreaterThan(pctA)
  })

  it("uses a flat token fill when a region has no value", () => {
    const fill = buildFillResolver([{ id: "A" }], resolve, "chart-2")
    expect(fill("A")).toBe("var(--chart-2)")
  })

  it("drops unknown regions with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const fill = buildFillResolver([{ id: "ZZ", value: 1 }], resolve, "chart-1")
    expect(fill("A")).toBe("var(--muted)")
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})


describe("projectMarkers", () => {
  it("projects lat/lng into finite viewBox coordinates", () => {
    const features = [squareFeature("A")]
    const projection = buildProjection(features, 800, 400)
    const out = projectMarkers(
      [{ lat: 0, lng: 0, label: "origin" }],
      projection,
    )
    expect(out).toHaveLength(1)
    expect(Number.isFinite(out[0].x)).toBe(true)
    expect(Number.isFinite(out[0].y)).toBe(true)
    expect(out[0].label).toBe("origin")
    expect(out[0].color).toBe("var(--chart-1)")
    expect(out[0].r).toBe(4)
  })
})
