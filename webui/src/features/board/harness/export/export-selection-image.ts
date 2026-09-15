// Export the board selection (PNG or SVG) so it includes the REAL rendered content of
// applet nodes.
//
// The harness's own `exportSelection` / `exportSelectionSvg` rasterize built-in primitives,
// images, icons, and each node's text `content` — but an applet's `content` is its JSX
// SOURCE, so a plain export draws the source text, not the chart/graph/map. Here we run the
// harness export as a base layer, then composite a snapDOM capture of each selected applet's
// LIVE DOM on top (selection forces applets live, so their DOM exists). See PR 6a.

import { exportSelection, exportSelectionSvg, nodeAABB, unionRects } from "@canvas-harness/core"
import type { AssetCache, CanvasStore, Node, NodeId } from "@canvas-harness/core"

import { snapshotApplet } from "@/features/applet/render/snapshot"


// Must match what we pass to `exportSelection`, so the composited overlay lines up with the
// base layer's coordinate frame.
const EXPORT_PADDING = 16
const EXPORT_SCALE = 2

// Node types whose real content is a live DOM subtree (captured via snapDOM). iframes
// (mini-app/widget) are cross-origin → a snapshot would taint the canvas, so they're left
// to the harness render.
const DOM_CAPTURE_TYPES: ReadonlySet<string> = new Set(["applet"])


export interface ExportImageOptions {
  transparentBackground?: boolean
  /** From `renderer.getAssetCache()` — without it, image/icon nodes are skipped. */
  assetCache?: AssetCache
}


/**
 * PNG blob of the current selection, compositing each selected applet's real render (via
 * snapDOM) over the harness canvas export. Falls back to the plain harness export when no
 * capturable DOM node is selected. Off-screen/unmounted applets (no live DOM) fall back to
 * the base render for that node — a documented v1 limitation.
 */
export async function exportSelectionImage(store: CanvasStore, opts: ExportImageOptions = {}): Promise<Blob> {
  const nodes = selectedNodes(store)
  const base = await exportSelection(store, {
    padding: EXPORT_PADDING,
    scale: EXPORT_SCALE,
    transparentBackground: opts.transparentBackground,
    assetCache: opts.assetCache,
  })

  const domNodes = nodes.filter((n) => DOM_CAPTURE_TYPES.has(n.type))
  const bbox = unionRects(nodes.map(nodeAABB))
  if (domNodes.length === 0 || !bbox) return base // nothing to composite

  const cssW = bbox.w + EXPORT_PADDING * 2
  const cssH = bbox.h + EXPORT_PADDING * 2
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.ceil(cssW * EXPORT_SCALE))
  canvas.height = Math.max(1, Math.ceil(cssH * EXPORT_SCALE))
  const ctx = canvas.getContext("2d")
  if (!ctx) return base
  ctx.scale(EXPORT_SCALE, EXPORT_SCALE)

  const baseImg = await blobToImage(base)
  if (baseImg) ctx.drawImage(baseImg, 0, 0, cssW, cssH)

  for (const { node: n, img } of await captureAppletShots(domNodes)) {
    // Node x/y are the PRE-rotation top-left; place at that box (offset into the padded
    // frame) and rotate about the center to match how the harness draws it.
    const x = n.x - bbox.x + EXPORT_PADDING
    const y = n.y - bbox.y + EXPORT_PADDING
    ctx.save()
    if (n.angle) {
      ctx.translate(x + n.w / 2, y + n.h / 2)
      ctx.rotate(n.angle)
      ctx.translate(-(x + n.w / 2), -(y + n.h / 2))
    }
    ctx.drawImage(img, x, y, n.w, n.h)
    ctx.restore()
  }

  return canvasToBlob(canvas)
}


/**
 * SVG string of the current selection with each selected applet's real render embedded as a
 * rastered `<image>` on top of the harness vector SVG. Applets are the one node type the
 * vector export can't represent (their `content` is JSX source), so we overlay a snapDOM PNG
 * at the node's world box. Falls back to the plain vector SVG when nothing capturable is
 * selected. Async (unlike the harness's sync SVG export) because snapDOM capture is async.
 */
export async function exportSelectionSvgWithApplets(store: CanvasStore, opts: ExportImageOptions = {}): Promise<string> {
  const svg = exportSelectionSvg(store, {
    padding: EXPORT_PADDING,
    transparentBackground: opts.transparentBackground,
  })

  const domNodes = selectedNodes(store).filter((n) => DOM_CAPTURE_TYPES.has(n.type))
  if (domNodes.length === 0) return svg

  const shots = await captureAppletShots(domNodes)
  if (shots.length === 0) return svg

  return injectAppletImages(
    svg,
    shots.map(({ node: n, img }) => ({ x: n.x, y: n.y, w: n.w, h: n.h, angle: n.angle, href: img.src })),
  )
}


/** One rastered applet to lay over the vector SVG, positioned in world coords. */
export interface SvgAppletPlacement {
  x: number
  y: number
  w: number
  h: number
  /** Rotation in radians (harness convention); 0 ⇒ axis-aligned. */
  angle: number
  /** The image href — a snapDOM `data:image/png;base64,…` URI. */
  href: string
}


/**
 * Overlay applet rasters onto a harness SVG export. The harness wraps content in
 * `<g transform="translate(tx ty)">` where children are drawn at WORLD coords (tx = padding −
 * bbox.x). We append a SIBLING group with the SAME translate holding the applet `<image>`s,
 * also at world coords — last child ⇒ painted on top, and robust to the exact nesting of the
 * base group. Returns the SVG unmodified if its shape isn't recognized. Pure/synchronous so
 * it can be unit-tested without a store, DOM, or snapDOM.
 */
export function injectAppletImages(svg: string, placements: SvgAppletPlacement[]): string {
  if (placements.length === 0) return svg
  const m = svg.match(/translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/)
  const closeIdx = svg.lastIndexOf("</svg>")
  if (!m || closeIdx === -1) return svg // unexpected shape — return the vector export unmodified

  const images = placements
    .map((p) => {
      const image = `<image x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" href="${escapeXmlAttr(p.href)}" preserveAspectRatio="none" />`
      if (!p.angle) return image
      const deg = (p.angle * 180) / Math.PI
      return `<g transform="rotate(${deg} ${p.x + p.w / 2} ${p.y + p.h / 2})">${image}</g>`
    })
    .join("")

  const overlay = `<g transform="translate(${m[1]} ${m[2]})">${images}</g>`
  return svg.slice(0, closeIdx) + overlay + svg.slice(closeIdx)
}


/** Snapshot each node's live applet DOM to a decoded image, dropping any that isn't mounted
 *  or fails to capture. Shared by the PNG + SVG compositors. */
async function captureAppletShots(nodes: Node[]): Promise<Array<{ node: Node; img: HTMLImageElement }>> {
  const out: Array<{ node: Node; img: HTMLImageElement }> = []
  for (const node of nodes) {
    const el = findNodeElement(node.id)
    if (!el) continue // off-screen / below the LOD zoom ⇒ no live DOM; base layer covers it
    const img = await snapshotApplet(el) // waits for fonts + canvas leaves' capture-ready
    if (img) out.push({ node, img })
  }
  return out
}


/** Escape a string for use inside a double-quoted XML attribute (the snapDOM data URI). */
function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}


/** The selection's node objects (edge ids resolve to undefined via getNode → filtered out). */
function selectedNodes(store: CanvasStore): Node[] {
  const out: Node[] = []
  for (const id of store.getSelection()) {
    const n = store.getNode(id as NodeId)
    if (n) out.push(n)
  }
  return out
}


/** The live DOM element for a node id (stamped by render-view.tsx), or null if it isn't
 *  currently mounted in the overlay (off-screen / below the LOD zoom). */
function findNodeElement(id: NodeId): HTMLElement | null {
  const raw = String(id)
  const sel = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(raw) : raw.replace(/["\\]/g, "\\$&")
  return document.querySelector<HTMLElement>(`[data-node-id="${sel}"]`)
}


/** Decode a PNG blob to a drawable image (null on failure). */
function blobToImage(blob: Blob): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}


/** Canvas → PNG blob (rejects if the browser returns null, e.g. a tainted canvas). */
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null (tainted or blocked)"))), "image/png")
  })
}
