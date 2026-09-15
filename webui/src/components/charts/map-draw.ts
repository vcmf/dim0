// Canvas 2D renderer for the <map> element — the paint half of map.tsx, kept pure
// (no React/DOM-lifecycle) so it's unit-testable with a mock context.
//
// The projection helpers (map-projection.ts) already fitted a Natural Earth projection
// to the fixed VIEW_W×VIEW_H viewBox and resolved fills/marker colors to CSS strings
// (`var(--x)`, `color-mix(...)`). This module maps that onto a `<canvas>`: it fits the
// viewBox into the canvas box with the SVG's `xMidYMid meet` rule (scale/center the
// context, draw in viewBox units so the 0.5 region stroke and marker sizes scale as
// under SVG), traces regions with d3-geo's canvas path, then draws marker dots/labels.
// Colors are concretized via resolveCssColor (canvas can't read `var()`/`color-mix`) —
// a DOM probe, but MEMOIZED per (theme, color), so only the handful of distinct colors
// probe on the first paint per theme.
//
// NOTE: the viewBox-fit transform and the memoized body-font helper mirror graph-draw.ts
// (sibling canvas port). A follow-up can lift both into lib/canvas once both land.

import { geoPath } from "d3-geo"
import type { GeoProjection } from "d3-geo"
import type { Feature, GeoJsonProperties, Geometry } from "geojson"

import { resolveCssColor } from "@/lib/theme/resolve-token"

import type { ProjectedMarker } from "./map-types"


type GeoFeature = Feature<Geometry, GeoJsonProperties>


// viewBox dimensions — MUST match the projection fit in map.tsx (buildProjection).
// ~2:1 matches the Natural Earth aspect ratio, so the fitted map nearly fills the box.
export const VIEW_W = 800
export const VIEW_H = 400
const REGION_STROKE_WIDTH = 0.5
const MARKER_STROKE_WIDTH = 1
const MARKER_LABEL_FONT_SIZE = 10


/** One atlas region paired with its resolved CSS fill (from buildFillResolver). */
export interface MapRegion {
  feature: GeoFeature
  fill: string
}


/** Everything the canvas needs for one paint: the fitted projection, the regions to
 *  shade, and the already-projected markers. Built in map.tsx from the loaded atlas. */
export interface MapView {
  projection: GeoProjection
  regions: MapRegion[]
  markers: ProjectedMarker[]
}


// The body font-family is read via getComputedStyle (a forced style flush), so cache it
// — it isn't theme-dependent and effectively never changes, and drawMap runs on every
// resize/theme/font/dpr redraw. The SSR fallback is not cached, so the first browser
// draw resolves the real family.
let cachedBodyFont: string | null = null


/** The body font-family (canvas `ctx.font` needs an explicit family; SVG inherited it),
 *  memoized after the first browser read. */
function bodyFontFamily(): string {
  if (cachedBodyFont != null) return cachedBodyFont
  if (typeof window === "undefined") return "system-ui, sans-serif"
  cachedBodyFont = window.getComputedStyle(document.body).fontFamily || "system-ui, sans-serif"
  return cachedBodyFont
}


/** Draw the marker overlay: a filled dot with a background-colored ring, plus an
 *  optional caption above it. Colors resolve per active theme. */
function drawMarkers(ctx: CanvasRenderingContext2D, markers: ProjectedMarker[], family: string): void {
  if (markers.length === 0) return
  const ring = resolveCssColor("var(--background)")
  const labelColor = resolveCssColor("var(--foreground)")
  ctx.textAlign = "center"
  ctx.textBaseline = "alphabetic"
  for (const m of markers) {
    // A non-positive/invalid radius draws no dot — canvas `ctx.arc` THROWS on a negative
    // radius (which would abort the whole paint), unlike SVG's `<circle>` that silently
    // skips it. The label still renders, matching the old SVG's r≤0 + <text> behavior.
    if (Number.isFinite(m.r) && m.r > 0) {
      ctx.beginPath()
      ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2)
      ctx.fillStyle = resolveCssColor(m.color)
      ctx.fill()
      ctx.strokeStyle = ring
      ctx.lineWidth = MARKER_STROKE_WIDTH
      ctx.stroke()
    }
    if (m.label != null) {
      ctx.fillStyle = labelColor
      ctx.font = `${MARKER_LABEL_FONT_SIZE}px ${family}`
      ctx.fillText(m.label, m.x, m.y - m.r - 3) // caption sits just above the dot
    }
  }
}


/**
 * Paint a projected map onto `ctx`, fitting the VIEW_W×VIEW_H viewBox into a `size`
 * (CSS px) box with the SVG's `xMidYMid meet` rule. Traces each region with d3-geo's
 * canvas path (fill + neutral border stroke) below the marker overlay. The context is
 * left as received (save/restore around the fit transform). Colors resolve per active
 * theme, so re-invoke on a theme change.
 *
 * Returns `true` if a paint pass ran, `false` if it no-op'd (zero-size box or no
 * projection) — so the caller doesn't mark a blank canvas capture-ready.
 */
export function drawMap(ctx: CanvasRenderingContext2D, view: MapView, size: { width: number; height: number }): boolean {
  if (!view.projection || size.width <= 0 || size.height <= 0) return false

  const scale = Math.min(size.width / VIEW_W, size.height / VIEW_H)
  if (!Number.isFinite(scale) || scale <= 0) return false
  const offsetX = (size.width - VIEW_W * scale) / 2
  const offsetY = (size.height - VIEW_H * scale) / 2

  const family = bodyFontFamily()
  ctx.save()
  ctx.translate(offsetX, offsetY)
  ctx.scale(scale, scale)

  // The border color + width are loop-invariant — set once; only the fill varies.
  const path = geoPath(view.projection, ctx)
  ctx.lineWidth = REGION_STROKE_WIDTH
  ctx.strokeStyle = resolveCssColor("var(--border)")
  for (const region of view.regions) {
    ctx.beginPath()
    path(region.feature) // renders the region's subpaths onto ctx (no fill/stroke)
    ctx.fillStyle = resolveCssColor(region.fill)
    ctx.fill()
    ctx.stroke()
  }

  drawMarkers(ctx, view.markers, family)

  ctx.restore()
  return true
}
