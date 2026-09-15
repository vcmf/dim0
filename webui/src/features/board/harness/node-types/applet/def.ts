import { defineNode } from "@canvas-harness/core"

import { drawAppletPlaceholder } from "./placeholder"
import { AppletNodeView } from "./view"


/**
 * Applet node — a declarative, interpreted widget rendered INLINE as React
 * (no iframe, no eval; see features/applet). It replaces the legacy mini-app as
 * the creatable interactive-widget type.
 *
 * LOD (same mechanism as the `sheet` node type): at/above `minZoomForReact` the React
 * view mounts (bounded by a deferred-mount pool, see view.tsx); below it — or during
 * motion — the cheap canvas `drawPlaceholder` (glyph) paints instead. No snapshot bitmaps
 * in this path: rasterizing every zoomed-out applet was heavier than the glyph and didn't
 * scale. `snapshotApplet` is retained only for on-demand PNG/SVG export of selected nodes.
 */
export const appletDef = defineNode({
  type: "applet",
  view: AppletNodeView,
  drawPlaceholder: drawAppletPlaceholder,
  lod: { minZoomForReact: 0.25, minZoomForPlaceholder: 0.05 },
  hitTest: (node, p) => p.x >= 0 && p.x <= node.w && p.y >= 0 && p.y <= node.h,
})
