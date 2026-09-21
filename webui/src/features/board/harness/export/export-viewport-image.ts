// Render the current board VIEWPORT to a PNG that includes the REAL rendered content of applet
// nodes — the on-demand capture fed to a vision model (see the multimodal-board-context epic).
//
// `exportViewport` rasterizes built-in primitives, images, icons, and each node's text
// `content`, but an applet's `content` is its JSX SOURCE, so a plain viewport export draws the
// source text, not the chart/graph/map. This mirrors `exportSelectionImage`: run the harness
// viewport export as a base layer, then composite a snapDOM capture of each in-view applet on
// top (via the shared `compositeAppletsOverBase`). Base render and applet captures run
// concurrently. An applet on-screen is snapshotted from its live overlay DOM (cheap); one that
// falls only inside the inflated capture margin, or that's below the LOD threshold when the
// board is zoomed out, is rendered into a hidden container from persisted state (slower, and
// possibly stale) — `captureAppletShots` handles both. iframes (mini-app/widget) can't be
// captured (cross-origin taint) and stay as the harness render.

import { exportViewport } from "@canvas-harness/core"
import type { AssetCache, CanvasStore, Node, NodeId, ThemeResolver, WorldRect } from "@canvas-harness/core"

import { DOM_CAPTURE_TYPES, captureAppletShots, compositeAppletsOverBase, type AppletShot } from "./export-selection-image"


export interface ExportViewportImageOptions {
  /** Bitmap scale multiplier — the caller sizes this so the output long side is ~screen px. */
  scale: number
  /** From `renderer.getAssetCache()` — without it, image/icon nodes are skipped. */
  assetCache?: AssetCache
  /** Theme resolver, same one passed to the live renderer. */
  theme?: ThemeResolver
  /** Board background color, so a dark-theme capture isn't drawn on white. */
  backgroundColor?: string
}


/**
 * PNG blob of the given world-space `viewport`, compositing each in-view applet's real render
 * over the harness viewport export. Falls back to the plain export when no applet is in view
 * (the common case — no snapDOM work). `padding` is 0: the frame is exactly the passed viewport.
 */
export async function exportViewportImage(
  store: CanvasStore,
  viewport: WorldRect,
  opts: ExportViewportImageOptions,
): Promise<Blob | null> {
  const applets = store
    .querySpatial({ rect: viewport })
    .nodes.map((id: NodeId) => store.getNode(id))
    .filter((n): n is Node => n != null && DOM_CAPTURE_TYPES.has(n.type))

  // Base raster and applet snapshots are independent — run them concurrently.
  const basePromise = exportViewport(store, viewport, {
    scale: opts.scale,
    padding: 0,
    assetCache: opts.assetCache,
    theme: opts.theme,
    backgroundColor: opts.backgroundColor,
  })
  const shotsPromise: Promise<AppletShot[]> = applets.length > 0 ? captureAppletShots(applets) : Promise.resolve<AppletShot[]>([])
  const [base, shots] = await Promise.all([basePromise, shotsPromise])
  if (shots.length === 0) {
    // No applets in view → the base is faithful, ship it. Applets in view but ZERO captures
    // (all snapDOM failed) → the base shows their JSX source, which must not be fed to a
    // vision model — attach nothing instead of a misleading source-text image.
    return applets.length === 0 ? base : null
  }

  return compositeAppletsOverBase(base, shots, {
    originX: viewport.x,
    originY: viewport.y,
    cssW: viewport.w,
    cssH: viewport.h,
    scale: opts.scale,
    backgroundColor: opts.backgroundColor,
  })
}
