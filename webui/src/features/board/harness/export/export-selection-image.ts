// Export the board selection (PNG or SVG) so it includes the REAL rendered content of
// applet nodes.
//
// The harness's own `exportSelection` / `exportSelectionSvg` rasterize built-in primitives,
// images, icons, and each node's text `content` — but an applet's `content` is its JSX
// SOURCE, so a plain export draws the source text, not the chart/graph/map. Here we run the
// harness export as a base layer, then composite a snapDOM capture of each selected applet's
// rendered DOM on top. See PR 6a.
//
// Capture is HYBRID: an applet that's currently mounted in the live overlay (zoomed in,
// on-screen) is snapshotted directly — free. One that isn't (zoomed out below the LOD
// threshold, or scrolled off-screen) is rendered into a hidden, node-sized container via
// `AppletRenderer` and snapshotted there — so export never depends on the board's live
// zoom/viewport, and a selected applet is never silently exported as its JSX source. Captures
// run at a bounded concurrency so a large selection doesn't spike memory with many React
// roots + bitmaps at once. Capture resolution is snapDOM's DPR-capped default (1×) — applets
// read slightly softer than built-in content in the 2× export, a deliberate speed tradeoff.

import { createElement } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"

import { exportSelection, exportSelectionSvg, nodeAABB, unionRects } from "@canvas-harness/core"
import type { AssetCache, CanvasStore, Node, NodeId } from "@canvas-harness/core"

import { AppletRenderer, type AppletRendererProps } from "@/features/applet/render"
import { fetchAppletState } from "@/features/applet/render"
import { snapshotApplet } from "@/features/applet/render/snapshot"


// Must match what we pass to `exportSelection`, so the composited overlay lines up with the
// base layer's coordinate frame.
const EXPORT_PADDING = 16
const EXPORT_SCALE = 2
const EXPORT_BG = "#ffffff"

// How many applet captures run at once. snapDOM rasterization is main-thread/sync, so more
// than a few in flight spikes memory (React roots + bitmaps) without speeding CPU work.
const CAPTURE_CONCURRENCY = 3

// Max wait for a hidden-mounted applet's `data-capture-ready` marker to appear before
// snapshotting. Charts set it within a frame or two; a marker-less pure-DOM applet waits this
// out (it has nothing async to draw).
const MARKER_GRACE_MS = 250

// Node types whose real content is a live DOM subtree (captured via snapDOM). iframes
// (mini-app/widget) are cross-origin → a snapshot would taint the canvas, so they're left
// to the harness render.
const DOM_CAPTURE_TYPES: ReadonlySet<string> = new Set(["applet"])


export interface ExportImageOptions {
  transparentBackground?: boolean
  /** From `renderer.getAssetCache()` — without it, image/icon nodes are skipped. */
  assetCache?: AssetCache
  /** Called after each applet is captured, for progress UI. */
  onProgress?: (done: number, total: number) => void
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


type AppletShot = { node: Node; img: HTMLImageElement }


/**
 * PNG blob of the current selection, compositing each selected applet's real render over the
 * harness canvas export. Falls back to the plain harness export when no applet is selected.
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
  if (!baseImg) return base // couldn't decode the base — better to ship it whole than drop it
  ctx.drawImage(baseImg, 0, 0, cssW, cssH)

  for (const { node: n, img } of await captureAppletShots(domNodes, opts.onProgress)) {
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
    // Clear the base layer's JSX-source text under this applet before drawing the (possibly
    // transparent) raster over it. In transparent mode, erase to transparency (keeps the
    // export transparent while removing the bleed-through text); otherwise fill with the
    // export background.
    if (opts.transparentBackground) {
      ctx.clearRect(x, y, n.w, n.h)
    } else {
      ctx.fillStyle = EXPORT_BG
      ctx.fillRect(x, y, n.w, n.h)
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
 *
 * NOTE on transparency: each applet always gets an opaque backing `<rect>`, even in
 * transparent mode. Unlike the canvas PNG path (which can `clearRect` the base layer's
 * JSX-source text), an SVG string can't erase the underlying `<text>`, so an opaque backing is
 * the only way to stop it bleeding through a transparent applet capture. Use PNG for a truly
 * transparent applet export.
 */
export async function exportSelectionSvgWithApplets(store: CanvasStore, opts: ExportImageOptions = {}): Promise<string> {
  const svg = exportSelectionSvg(store, {
    padding: EXPORT_PADDING,
    transparentBackground: opts.transparentBackground,
  })

  const domNodes = selectedNodes(store).filter((n) => DOM_CAPTURE_TYPES.has(n.type))
  if (domNodes.length === 0) return svg

  const shots = await captureAppletShots(domNodes, opts.onProgress)
  if (shots.length === 0) return svg

  return injectAppletImages(
    svg,
    shots.map(({ node: n, img }) => ({ x: n.x, y: n.y, w: n.w, h: n.h, angle: n.angle, href: img.src })),
    EXPORT_BG,
  )
}


/**
 * Overlay applet rasters onto a harness SVG export. The harness wraps content in
 * `<g transform="translate(tx ty)">` where children are drawn at WORLD coords (tx = padding −
 * bbox.x). We append a SIBLING group with the SAME translate holding the applet `<image>`s,
 * also at world coords — last child ⇒ painted on top, and robust to the exact nesting of the
 * base group. When `backgroundColor` is given, each image gets an opaque backing `<rect>` so
 * the base layer's JSX-source `<text>` can't show through a transparent applet capture.
 * Returns the SVG unmodified if its shape isn't recognized. Pure/synchronous so it can be
 * unit-tested without a store, DOM, or snapDOM.
 *
 * The `translate(...)` match couples to the harness SVG format; it's pinned by our
 * @canvas-harness/core version and covered by tests, but a lib format change would fail the
 * match — in which case we warn (dev) and fall back to the plain vector SVG rather than
 * misplacing overlays.
 */
export function injectAppletImages(svg: string, placements: SvgAppletPlacement[], backgroundColor?: string): string {
  if (placements.length === 0) return svg
  const m = svg.match(/translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/)
  const closeIdx = svg.lastIndexOf("</svg>")
  if (!m || closeIdx === -1) {
    // Unexpected shape — return the vector export unmodified (applets stay as source text).
    if (import.meta.env.DEV) {
      console.warn("[export] harness SVG shape not recognized (no content translate group); applet overlays skipped")
    }
    return svg
  }

  const images = placements
    .map((p) => {
      const backing = backgroundColor
        ? `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" fill="${escapeXmlAttr(backgroundColor)}" />`
        : ""
      const image = `<image x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" href="${escapeXmlAttr(p.href)}" preserveAspectRatio="none" />`
      const body = backing + image
      if (!p.angle) return body
      const deg = (p.angle * 180) / Math.PI
      return `<g transform="rotate(${deg} ${p.x + p.w / 2} ${p.y + p.h / 2})">${body}</g>`
    })
    .join("")

  const overlay = `<g transform="translate(${m[1]} ${m[2]})">${images}</g>`
  return svg.slice(0, closeIdx) + overlay + svg.slice(closeIdx)
}


// ---- capture --------------------------------------------------------------

/** Snapshot each applet to a decoded image at bounded concurrency, reporting progress and
 *  dropping any that fails to capture. Shared by the PNG + SVG compositors. */
async function captureAppletShots(nodes: Node[], onProgress?: (done: number, total: number) => void): Promise<AppletShot[]> {
  onProgress?.(0, nodes.length) // show feedback up front — the first capture may wait seconds
  let done = 0
  const results = await mapWithConcurrency(nodes, CAPTURE_CONCURRENCY, async (node) => {
    const img = await captureApplet(node)
    onProgress?.(++done, nodes.length)
    return img ? { node, img } : null
  })
  return results.filter((r): r is AppletShot => r !== null)
}


/** Capture one applet: reuse its live overlay DOM if it's mounted (free), else render it into
 *  a hidden container so capture is independent of the board's zoom/viewport. */
async function captureApplet(node: Node): Promise<HTMLImageElement | null> {
  const live = findLiveAppletRoot(node.id)
  if (live) return snapshotApplet(live)
  return captureViaHiddenMount(node)
}


/** The live applet-body element for a node id (stamped by render-view.tsx), or null if the
 *  applet isn't currently mounted in the overlay. Prefers `.applet-root` (the applet body,
 *  no node chrome) and falls back to the wrapper. */
function findLiveAppletRoot(id: NodeId): HTMLElement | null {
  const wrapper = document.querySelector<HTMLElement>(`[data-node-id="${cssEscape(String(id))}"]`)
  if (!wrapper) return null
  return wrapper.querySelector<HTMLElement>(".applet-root") ?? wrapper
}


/**
 * Render an applet into an off-screen, node-sized container and snapshot it — the fallback
 * for an applet that isn't live in the overlay. Deterministic regardless of the board's zoom
 * or viewport. Returns null (never throws) so a capture failure degrades to the base render.
 *
 * Two caveats specific to this fallback (the live-DOM path has neither):
 *   - The applet renders under a bare `createRoot`, without the app's context providers.
 *     Applets are self-contained (the interpreter reads theme via CSS vars on :root, present
 *     here), so this is fine in practice; a hypothetical provider-dependent applet would throw
 *     and degrade to the base render.
 *   - State is hydrated from `fetchAppletState` (persisted), since an unmounted applet has no
 *     live state to read. An off-screen applet with unsaved interactive state exports its
 *     last-persisted state.
 */
async function captureViaHiddenMount(node: Node): Promise<HTMLImageElement | null> {
  if (typeof node.content !== "string" || node.content.length === 0) return null
  const initialState = await fetchAppletInitialState(node.id)

  const container = document.createElement("div")
  container.setAttribute("data-applet-export", "")
  Object.assign(container.style, {
    position: "fixed",
    left: "-100000px",
    top: "0px",
    width: `${node.w}px`,
    height: `${node.h}px`,
    overflow: "hidden",
    pointerEvents: "none",
    background: "transparent",
  })
  document.body.appendChild(container)

  const root = createRoot(container)
  try {
    // flushSync commits the initial DOM synchronously. A canvas leaf's `data-capture-ready`
    // marker is written in a POST-commit effect, so we then wait for that marker to appear
    // before snapshotting — otherwise snapshotApplet would see no `="false"` marker on a
    // still-blank chart and capture it empty. Marker-less applets (pure DOM, no canvas) never
    // set one, so a short grace bounds the wait for them.
    flushSync(() => root.render(createElement(AppletRenderer, { source: node.content as string, initialState })))
    await waitForCaptureMarkers(container, MARKER_GRACE_MS)
    const el = container.querySelector<HTMLElement>(".applet-root") ?? container
    return await snapshotApplet(el) // then waits for the marker to flip true (chart drawn)
  } catch {
    return null
  } finally {
    root.unmount()
    container.remove()
  }
}


/** Read an applet's persisted state for a standalone render, shaped for `AppletRenderer`.
 *  Any failure (no row, store error) → undefined, so the applet renders its declared defaults. */
async function fetchAppletInitialState(id: NodeId): Promise<AppletRendererProps["initialState"]> {
  try {
    const state = await fetchAppletState(String(id))
    return state && typeof state === "object" ? (state as AppletRendererProps["initialState"]) : undefined
  } catch {
    return undefined
  }
}


// ---- helpers --------------------------------------------------------------

/** The selection's node objects (edge ids resolve to undefined via getNode → filtered out). */
function selectedNodes(store: CanvasStore): Node[] {
  const out: Node[] = []
  for (const id of store.getSelection()) {
    const n = store.getNode(id as NodeId)
    if (n) out.push(n)
  }
  return out
}


/** Map `fn` over `items` with at most `limit` promises in flight, preserving input order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}


/** Resolve once a `data-capture-ready` marker appears anywhere under `el` (a canvas leaf's
 *  post-commit effect has run) or `graceMs` elapses (a marker-less pure-DOM applet). Bounds
 *  the cold-start race where a just-mounted chart reads as ready while still blank. */
function waitForCaptureMarkers(el: HTMLElement, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    const start = now()
    const check = () => {
      if (el.querySelector("[data-capture-ready]") || now() - start >= graceMs) return resolve()
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(check)
      else setTimeout(check, 16)
    }
    check()
  })
}


/** Monotonic-ish clock (falls back to Date.now where performance is absent). */
function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now()
}


/** Escape a raw id for a CSS attribute selector (`CSS.escape` when available). */
function cssEscape(raw: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(raw) : raw.replace(/["\\]/g, "\\$&")
}


/** Escape a string for use inside a double-quoted XML attribute (the snapDOM data URI). */
function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
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
