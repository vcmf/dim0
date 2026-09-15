import { defineNode } from "@canvas-harness/core"

// Import the pure cache reader DIRECTLY (not via the feature barrel, which also re-exports
// snapshotApplet → the heavy @zumer/snapdom). Node registration runs on board load; this
// keeps the getSnapshot hook dependency-free.
import { getAppletSnapshot } from "@/features/applet/render/snapshot-cache"

import { drawAppletPlaceholder } from "./placeholder"
import { AppletNodeView } from "./view"


/**
 * Applet node — a declarative, interpreted widget rendered INLINE as React
 * (no iframe, no eval; see features/applet). It replaces the legacy mini-app as
 * the creatable interactive-widget type.
 *
 * Snapshot-first LOD: at/above `minZoomForReact` the React view mounts (bounded by a
 * deferred-mount pool, see view.tsx) and, while live, rasterizes itself into the
 * snapshot cache. Below that zoom / during motion, `getSnapshot` blits that cached image
 * so hundreds of applets paint as cheap `<canvas>` bitmaps; when no snapshot exists yet
 * it returns null and the glyph `drawPlaceholder` shows instead.
 */
export const appletDef = defineNode({
  type: "applet",
  view: AppletNodeView,
  drawPlaceholder: drawAppletPlaceholder,
  getSnapshot: (node) => getAppletSnapshot(String(node.id)),
  lod: { minZoomForReact: 0.25, minZoomForPlaceholder: 0.05 },
  hitTest: (node, p) => p.x >= 0 && p.x <= node.w && p.y >= 0 && p.y <= node.h,
})
