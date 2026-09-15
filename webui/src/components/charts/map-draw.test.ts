import { geoNaturalEarth1 } from "d3-geo"
import type { Feature, Geometry, GeoJsonProperties } from "geojson"
import { describe, expect, it, vi } from "vitest"

import { drawMap, VIEW_H, VIEW_W } from "./map-draw"
import type { MapView } from "./map-draw"

// The canvas draw is verified by RECORDING calls on a mock 2D context — jsdom has no
// real canvas, and concrete colors come from a DOM probe (jsdom can't compute oklch/
// color-mix). We assert STRUCTURE — regions trace + fill, markers become arcs, labels
// become fillText, the fit transform is applied — not pixels. Visual fidelity rides the
// PR 0 spike + a future e2e. A REAL d3-geo projection drives geoPath so the region trace
// actually issues context calls.


/** A recording stub of the 2D context: drawing methods are spies, styling props plain
 *  settable fields. Enough surface for drawMap + d3-geo's canvas path to run. */
function mockCtx() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
  } as unknown as CanvasRenderingContext2D & Record<string, ReturnType<typeof vi.fn>>
}


const SIZE = { width: VIEW_W, height: VIEW_H }

const square: Feature<Geometry, GeoJsonProperties> = {
  type: "Feature",
  id: "1",
  properties: { name: "Squareland" },
  geometry: { type: "Polygon", coordinates: [[[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]]] },
}

function makeView(): MapView {
  const projection = geoNaturalEarth1().fitSize([VIEW_W, VIEW_H], { type: "FeatureCollection", features: [square] })
  return {
    projection,
    regions: [{ feature: square, fill: "var(--chart-1)" }],
    markers: [
      { x: 100, y: 60, label: "City", color: "var(--chart-2)", r: 4 },
      { x: 200, y: 90, label: null, color: "var(--chart-3)", r: 3 },
    ],
  }
}


describe("drawMap", () => {
  it("returns true and fits within a save/restore + scale/translate transform", () => {
    const ctx = mockCtx()
    expect(drawMap(ctx, makeView(), SIZE)).toBe(true)
    expect(ctx.save).toHaveBeenCalledOnce()
    expect(ctx.restore).toHaveBeenCalledOnce()
    expect(ctx.scale).toHaveBeenCalled()
    expect(ctx.translate).toHaveBeenCalled()
  })

  it("traces + fills each region (geoPath issues moveTo/lineTo, then fill + stroke)", () => {
    const ctx = mockCtx()
    drawMap(ctx, makeView(), SIZE)
    expect((ctx.moveTo as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0)
    expect((ctx.lineTo as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0)
    expect(ctx.fill).toHaveBeenCalled() // region fill (+ marker fills)
    expect(ctx.stroke).toHaveBeenCalled() // region border (+ marker rings)
  })

  it("draws a dot per marker and a caption only for a labeled one", () => {
    const ctx = mockCtx()
    drawMap(ctx, makeView(), SIZE)
    expect((ctx.arc as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2) // two markers
    const texts = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(texts).toEqual(["City"]) // only the labeled marker gets text
  })

  it("no-ops (returns false) on a zero-size canvas box without touching the context", () => {
    const ctx = mockCtx()
    expect(drawMap(ctx, makeView(), { width: 0, height: 0 })).toBe(false)
    expect(ctx.save).not.toHaveBeenCalled()
    expect(ctx.arc).not.toHaveBeenCalled()
  })

  it("no-ops when there is no projection", () => {
    const ctx = mockCtx()
    const view = { ...makeView(), projection: undefined } as unknown as MapView
    expect(drawMap(ctx, view, SIZE)).toBe(false)
    expect(ctx.save).not.toHaveBeenCalled()
  })

  it("renders with no markers (regions only)", () => {
    const ctx = mockCtx()
    const view = { ...makeView(), markers: [] }
    expect(drawMap(ctx, view, SIZE)).toBe(true)
    expect(ctx.arc).not.toHaveBeenCalled()
  })
})
