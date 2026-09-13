import { defineNode } from "@canvas-harness/core"

import { drawAppletPlaceholder } from "./placeholder"
import { AppletNodeView } from "./view"


/**
 * Applet node — a declarative, interpreted widget rendered INLINE as React
 * (no iframe, no eval; see features/applet). It replaces the legacy mini-app as
 * the creatable interactive-widget type. Because it's lightweight React (not a
 * ~5 MB sandboxed iframe), it needs no deferred-mount pool; the LOD threshold
 * matches the other React node types — below it, the canvas placeholder shows.
 */
export const appletDef = defineNode({
  type: "applet",
  view: AppletNodeView,
  drawPlaceholder: drawAppletPlaceholder,
  lod: { minZoomForReact: 0.25, minZoomForPlaceholder: 0.05 },
  hitTest: (node, p) => p.x >= 0 && p.x <= node.w && p.y >= 0 && p.y <= node.h,
})
