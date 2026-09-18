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


// Visual constants (viewBox units). Bold aesthetic: big filled circles (no ring),
// mono labels stacked below, edges standing off the node with a large arrowhead.
const NODE_RADIUS = 20
const NODE_LABEL_FONT_SIZE = 13
const NODE_LABEL_FONT_WEIGHT = 600
const NODE_LABEL_CY = NODE_RADIUS + 15 // label CENTER, just below the circle
const SUBLABEL_FONT_SIZE = 11
const SUBLABEL_CY = NODE_RADIUS + 33 // sublabel center, stacked below the label
const EDGE_STROKE_WIDTH = 3
const EDGE_LABEL_FONT_SIZE = 12
// Gap (viewBox units) between the node border and the edge tip / arrowhead, so the
// line stands off the circle instead of touching it.
const EDGE_GAP = 6
// Arrowhead: a filled triangle ARROW_SIZE long, 2·ARROW_HALF_BASE wide at the base.
const ARROW_SIZE = 17
const ARROW_HALF_BASE = ARROW_SIZE * 0.42 // slightly narrow → sharper head
// Labels sit over edges, so each gets an OPAQUE rounded "halo" (not transparent) with a
// little padding — an empty space that keeps them readable. The color must match the
// surface the graph is drawn on so the halo only reads as a cutout over edges: the applet
// renders on `--background` (the applet card), so use that, not `--card`.
const LABEL_HALO_BG = "var(--background)"
const LABEL_HALO_PAD_X = 5
const LABEL_HALO_PAD_Y = 3
const LABEL_HALO_RADIUS = 4
// Rough advance width of a mono glyph as a fraction of the em — lets `nodeDrawExtent`
// estimate a label's halo width without a canvas (the layout has no 2D context).
const MONO_CHAR_W = 0.6
// Monospace family for all graph labels (design request). The app defines no
// `--font-mono` token, so use a standard system-mono stack.
const MONO_FAMILY = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'


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
 * How far a node's drawing reaches past its CENTER on each side (viewBox units): the circle
 * radius, plus the mono label/sublabel halos stacked below and their estimated widths to the
 * sides. The layout uses this to size the auto-viewBox so nothing clips — captions extend
 * downward and halos extend sideways by (estimated) text width, so a single symmetric pad
 * can't model it. Widths are estimated (`MONO_CHAR_W`) since the layout has no canvas.
 */
export function nodeDrawExtent(node: PositionedNode): { left: number; right: number; top: number; bottom: number } {
  const haloHalfW = (text: string, size: number): number =>
    text ? (text.length * size * MONO_CHAR_W + LABEL_HALO_PAD_X * 2) / 2 : 0
  const haloHalfH = (size: number): number => size / 2 + LABEL_HALO_PAD_Y
  const half = Math.max(NODE_RADIUS, haloHalfW(node.label, NODE_LABEL_FONT_SIZE), node.sublabel ? haloHalfW(node.sublabel, SUBLABEL_FONT_SIZE) : 0)
  const bottom = node.sublabel
    ? SUBLABEL_CY + haloHalfH(SUBLABEL_FONT_SIZE)
    : node.label
      ? NODE_LABEL_CY + haloHalfH(NODE_LABEL_FONT_SIZE)
      : NODE_RADIUS
  return { left: half, right: half, top: NODE_RADIUS, bottom }
}


/**
 * Inset both endpoints toward the node centers so the line (and arrowhead) stops a little
 * short of the circle boundary — `NODE_RADIUS + EDGE_GAP` — leaving a gap between the node
 * and the edge tip. Insetting both ends equally keeps the midpoint (and edge label) fixed.
 */
function trimToBoundary(edge: PositionedEdge): { x1: number; y1: number; x2: number; y2: number } {
  const dx = edge.x2 - edge.x1
  const dy = edge.y2 - edge.y1
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  // Clamp the inset so the two ends can't cross on a short edge (centers closer than
  // 2·inset) — otherwise the trimmed segment reverses and the arrowhead points backward.
  // On such edges the line just meets the nodes with little/no gap, which is fine.
  const inset = Math.min(NODE_RADIUS + EDGE_GAP, Math.max(0, len / 2 - 1))
  return {
    x1: edge.x1 + ux * inset,
    y1: edge.y1 + uy * inset,
    x2: edge.x2 - ux * inset,
    y2: edge.y2 - uy * inset,
  }
}


/** The canvas `ctx.font` shorthand for the given family/size/weight. */
function fontOf(family: string, size: number, weight?: number): string {
  return `${weight ? `${weight} ` : ""}${size}px ${family}`
}


/**
 * Draw `text` centered at (cx, cy) in a mono font, over an OPAQUE rounded halo in the
 * surface bg color — an empty space around the label so it stays readable where it sits
 * over an edge. No-op for empty text (a node with no label draws just its circle).
 */
function drawLabelWithHalo(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  size: number,
  weight: number | undefined,
  color: string,
): void {
  if (!text) return
  ctx.font = fontOf(MONO_FAMILY, size, weight)
  const w = ctx.measureText(text).width + LABEL_HALO_PAD_X * 2
  const h = size + LABEL_HALO_PAD_Y * 2
  traceRoundRect(ctx, cx - w / 2, cy - h / 2, w, h, LABEL_HALO_RADIUS)
  ctx.fillStyle = resolveCssColor(LABEL_HALO_BG)
  ctx.fill()
  ctx.fillStyle = resolveCssColor(color)
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(text, cx, cy)
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
  const px = -uy * ARROW_HALF_BASE // perpendicular half-base
  const py = ux * ARROW_HALF_BASE
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


/** Draw an edge's mono label at its midpoint, over an opaque halo that masks the edge. */
function drawEdgeLabel(ctx: CanvasRenderingContext2D, edge: PositionedEdge): void {
  if (edge.label == null) return
  const cx = (edge.x1 + edge.x2) / 2
  const cy = (edge.y1 + edge.y2) / 2
  drawLabelWithHalo(ctx, edge.label, cx, cy, EDGE_LABEL_FONT_SIZE, undefined, "var(--muted-foreground)")
}


/** Draw one node: a big filled circle (no ring), then its mono label + optional sublabel,
 *  each over an opaque halo so they stay readable over any edge underneath. */
function drawNode(ctx: CanvasRenderingContext2D, node: PositionedNode): void {
  ctx.beginPath()
  ctx.arc(node.x, node.y, NODE_RADIUS, 0, Math.PI * 2)
  ctx.fillStyle = resolveCssColor(node.color)
  ctx.fill()

  drawLabelWithHalo(ctx, node.label, node.x, node.y + NODE_LABEL_CY, NODE_LABEL_FONT_SIZE, NODE_LABEL_FONT_WEIGHT, node.textColor)
  if (node.sublabel != null) {
    drawLabelWithHalo(ctx, node.sublabel, node.x, node.y + SUBLABEL_CY, SUBLABEL_FONT_SIZE, undefined, "var(--muted-foreground)")
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

  ctx.save()
  ctx.translate(offsetX, offsetY)
  ctx.scale(scale, scale)
  ctx.translate(-vb.minX, -vb.minY)

  for (const edge of graph.edges) drawEdge(ctx, edge, graph.directed)
  for (const edge of graph.edges) drawEdgeLabel(ctx, edge)
  for (const node of graph.nodes) drawNode(ctx, node)

  ctx.restore()
  return true
}
