// Canvas 2D renderer for the <graph> element — the paint half of graph.tsx, kept
// pure (no React/DOM-lifecycle) so it's unit-testable with a mock context.
//
// The layout (graph-layout.ts) already positioned every node/edge in viewBox units
// and resolved colors to CSS strings (`var(--x)`, `color-mix(...)`, raw). This module
// maps that onto a `<canvas>`: it replicates the SVG's `viewBox` + `xMidYMid meet`
// fit by scaling/centering the context, then draws in viewBox units so stroke widths
// and font sizes scale exactly as they did under SVG. Colors are concretized via
// resolveCssColor (canvas can't read `var()`/`color-mix`) — a DOM probe, but MEMOIZED
// per (theme, color), so only the handful of DISTINCT colors probe on the first paint
// per theme; resize/dpr/font redraws reuse the cache. The unavoidable trade for
// canvas's snapshot fidelity over SVG's free native color resolution.

import { resolveCssColor } from "@/lib/theme/resolve-token"

import type { LaidOutGraph, PositionedEdge, PositionedNode } from "./graph-types"


// Visual constants — ported verbatim from the former SVG renderer (viewBox units).
// Dot-with-caption aesthetic: nodes are small filled circles with a neutral ring,
// label + sublabel stacked below; edges read as low-contrast threads.
const NODE_RADIUS = 12
const NODE_STROKE_WIDTH = 2
const NODE_LABEL_FONT_SIZE = 12
const NODE_LABEL_FONT_WEIGHT = 600
const NODE_LABEL_DY = NODE_RADIUS + 14 // label baseline just below the circle
const SUBLABEL_FONT_SIZE = 11
const SUBLABEL_DY = NODE_RADIUS + 28 // sublabel stacks below the label
const EDGE_STROKE_WIDTH = 3
const EDGE_LABEL_FONT_SIZE = 11
const EDGE_LABEL_CHIP_WIDTH = 22
const EDGE_LABEL_CHIP_HEIGHT = 18
const EDGE_LABEL_CHIP_RADIUS = 7
// Arrowhead geometry (viewBox units, independent of stroke — matches the SVG's
// userSpaceOnUse marker): a triangle ARROW_SIZE long, ARROW_SIZE wide at the base.
const ARROW_SIZE = 10


interface ViewBox {
  minX: number
  minY: number
  width: number
  height: number
}


/** Parse an SVG `viewBox` ("minX minY width height") into numbers, or `null` if it
 *  isn't four finite values with a positive extent (nothing to draw). */
export function parseViewBox(viewBox: string): ViewBox | null {
  const parts = viewBox.trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  const [minX, minY, width, height] = parts
  if (width <= 0 || height <= 0) return null
  return { minX, minY, width, height }
}


/**
 * A DEFINITE CSS height for the graph wrapper, or `undefined` to size from the viewBox
 * aspect instead. Excludes non-positive numbers and indefinite strings (`""`, `"auto"` —
 * the GraphProps-documented default): a `height:100%` canvas inside an indefinite box
 * collapses to 0 and never draws, unlike the old SVG which sized from its viewBox. Lives
 * here (not in graph.tsx) so the component file exports only its component — a
 * non-component export there breaks React Fast Refresh (react-refresh/only-export-components).
 */
export function definiteHeight(height: number | string | undefined): string | undefined {
  if (typeof height === "number") return height > 0 ? `${height}px` : undefined
  if (typeof height === "string") {
    const trimmed = height.trim()
    return trimmed === "" || trimmed === "auto" ? undefined : trimmed
  }
  return undefined
}


/**
 * Inset both endpoints toward the node centers so the line (and arrowhead) meets the
 * circle boundary, not the center. Insetting both ends equally keeps the midpoint —
 * and thus the edge-label chip — fixed. Ported verbatim from the SVG renderer.
 */
function trimToBoundary(edge: PositionedEdge): { x1: number; y1: number; x2: number; y2: number } {
  const dx = edge.x2 - edge.x1
  const dy = edge.y2 - edge.y1
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  return {
    x1: edge.x1 + ux * NODE_RADIUS,
    y1: edge.y1 + uy * NODE_RADIUS,
    x2: edge.x2 - ux * NODE_RADIUS,
    y2: edge.y2 - uy * NODE_RADIUS,
  }
}


/** The font shorthand for canvas text, using the document's body font-family so labels
 *  match surrounding UI text (falls back to a system stack outside a browser). */
function fontOf(family: string, size: number, weight?: number): string {
  return `${weight ? `${weight} ` : ""}${size}px ${family}`
}


// The body font-family is read via getComputedStyle (a forced style flush), so cache it
// — it isn't theme-dependent and effectively never changes, and drawGraph runs on every
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


/** Trace a rounded-rectangle path (no `ctx.roundRect` dependency — quadratic corners,
 *  broadly supported + trivially mockable). Radius is clamped to half the shorter side. */
function traceRoundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
  ctx.lineTo(x + rr, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr)
  ctx.lineTo(x, y + rr)
  ctx.quadraticCurveTo(x, y, x + rr, y)
  ctx.closePath()
}


/** Fill a triangular arrowhead whose tip sits at the trimmed edge end, pointing along
 *  the edge (base ARROW_SIZE behind the tip). Mirrors the SVG `markerEnd` triangle. */
function drawArrowhead(ctx: CanvasRenderingContext2D, seg: { x1: number; y1: number; x2: number; y2: number }, color: string): void {
  const dx = seg.x2 - seg.x1
  const dy = seg.y2 - seg.y1
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const backX = seg.x2 - ux * ARROW_SIZE
  const backY = seg.y2 - uy * ARROW_SIZE
  const px = -uy * (ARROW_SIZE / 2) // perpendicular half-base
  const py = ux * (ARROW_SIZE / 2)
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(seg.x2, seg.y2) // tip
  ctx.lineTo(backX + px, backY + py)
  ctx.lineTo(backX - px, backY - py)
  ctx.closePath()
  ctx.fill()
}


/** Stroke one edge (boundary-trimmed), plus its arrowhead when the graph is directed. */
function drawEdge(ctx: CanvasRenderingContext2D, edge: PositionedEdge, directed: boolean): void {
  const seg = trimToBoundary(edge)
  const color = resolveCssColor(edge.color)
  ctx.strokeStyle = color
  ctx.lineWidth = EDGE_STROKE_WIDTH
  ctx.lineCap = "round"
  ctx.beginPath()
  ctx.moveTo(seg.x1, seg.y1)
  ctx.lineTo(seg.x2, seg.y2)
  ctx.stroke()
  if (directed) drawArrowhead(ctx, seg, color)
}


/** Draw the small rounded chip + centered text for an edge's label at its midpoint. */
function drawEdgeLabel(ctx: CanvasRenderingContext2D, edge: PositionedEdge, family: string): void {
  if (edge.label == null) return
  const cx = (edge.x1 + edge.x2) / 2
  const cy = (edge.y1 + edge.y2) / 2
  traceRoundRect(ctx, cx - EDGE_LABEL_CHIP_WIDTH / 2, cy - EDGE_LABEL_CHIP_HEIGHT / 2, EDGE_LABEL_CHIP_WIDTH, EDGE_LABEL_CHIP_HEIGHT, EDGE_LABEL_CHIP_RADIUS)
  ctx.fillStyle = resolveCssColor("var(--card)")
  ctx.fill()
  ctx.strokeStyle = resolveCssColor("var(--border)")
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = resolveCssColor("var(--muted-foreground)")
  ctx.font = fontOf(family, EDGE_LABEL_FONT_SIZE)
  ctx.textAlign = "center"
  ctx.textBaseline = "alphabetic"
  ctx.fillText(edge.label, cx, cy + 3) // +3 visually centers the cap height in the chip
}


/** Draw one node: filled circle + neutral ring, then label and optional sublabel. */
function drawNode(ctx: CanvasRenderingContext2D, node: PositionedNode, family: string): void {
  ctx.beginPath()
  ctx.arc(node.x, node.y, NODE_RADIUS, 0, Math.PI * 2)
  ctx.fillStyle = resolveCssColor(node.color)
  ctx.fill()
  ctx.strokeStyle = resolveCssColor(node.border)
  ctx.lineWidth = NODE_STROKE_WIDTH
  ctx.stroke()

  ctx.textAlign = "center"
  ctx.textBaseline = "alphabetic"
  ctx.fillStyle = resolveCssColor(node.textColor)
  ctx.font = fontOf(family, NODE_LABEL_FONT_SIZE, NODE_LABEL_FONT_WEIGHT)
  ctx.fillText(node.label, node.x, node.y + NODE_LABEL_DY)

  if (node.sublabel != null) {
    ctx.fillStyle = resolveCssColor("var(--muted-foreground)")
    ctx.font = fontOf(family, SUBLABEL_FONT_SIZE)
    ctx.fillText(node.sublabel, node.x, node.y + SUBLABEL_DY)
  }
}


/**
 * Paint a laid-out graph onto `ctx`, fitting `graph.viewBox` into a `size` (CSS px)
 * box with the SVG's `xMidYMid meet` rule (uniform scale, centered). Draws edges (+
 * arrowheads) below edge-labels below nodes — the SVG layer order. The context is left
 * as received (save/restore around the fit transform). Colors resolve per active theme,
 * so re-invoke on a theme change.
 *
 * Returns `true` if a paint pass ran, `false` if it no-op'd (degenerate viewBox or a
 * zero-size box) — so the caller doesn't mark a blank canvas capture-ready. An
 * empty-but-valid graph (no nodes, valid viewBox) still returns `true`: blank is its
 * correct, finished render.
 */
export function drawGraph(ctx: CanvasRenderingContext2D, graph: LaidOutGraph, size: { width: number; height: number }): boolean {
  const vb = parseViewBox(graph.viewBox)
  if (!vb || size.width <= 0 || size.height <= 0) return false

  const scale = Math.min(size.width / vb.width, size.height / vb.height)
  if (!Number.isFinite(scale) || scale <= 0) return false
  const offsetX = (size.width - vb.width * scale) / 2
  const offsetY = (size.height - vb.height * scale) / 2

  const family = bodyFontFamily()
  ctx.save()
  ctx.translate(offsetX, offsetY)
  ctx.scale(scale, scale)
  ctx.translate(-vb.minX, -vb.minY)

  for (const edge of graph.edges) drawEdge(ctx, edge, graph.directed)
  for (const edge of graph.edges) drawEdgeLabel(ctx, edge, family)
  for (const node of graph.nodes) drawNode(ctx, node, family)

  ctx.restore()
  return true
}
