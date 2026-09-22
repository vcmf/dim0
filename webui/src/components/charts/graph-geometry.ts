// Shared node-footprint geometry for the `<graph>` element — the single source for how big a
// node's drawing is. Both the canvas renderer (graph-draw.ts) and the layout's viewBox sizing
// (graph-layout.ts) read these, so they can't drift. Kept DOM-free (no canvas/theme imports)
// so the pure layout doesn't transitively pull in the render layer.

import type { PositionedNode } from "./graph-types"


// Circle + caption dimensions (viewBox units).
export const NODE_RADIUS = 20
export const NODE_LABEL_FONT_SIZE = 13
export const NODE_LABEL_CY = NODE_RADIUS + 15 // label CENTER, just below the circle
export const SUBLABEL_FONT_SIZE = 11
export const SUBLABEL_CY = NODE_RADIUS + 33 // sublabel center, stacked below the label
// Padding inside a label's opaque halo.
export const LABEL_HALO_PAD_X = 5
export const LABEL_HALO_PAD_Y = 3
// Rough advance width of a mono glyph as a fraction of the em — lets `nodeDrawExtent`
// estimate a label's halo width without a canvas (the layout has no 2D context). Accurate
// for ASCII in a mono font; CJK / wide fallbacks advance wider and may under-estimate.
const MONO_CHAR_W = 0.6


/**
 * How far a node's drawing reaches past its CENTER on each side (viewBox units): the circle
 * radius, plus the mono label/sublabel halos stacked below and their estimated widths to the
 * sides. The layout sizes the auto-viewBox from this so nothing clips — captions extend
 * downward and halos sideways by (estimated) text width, so a single symmetric pad can't
 * model it.
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
