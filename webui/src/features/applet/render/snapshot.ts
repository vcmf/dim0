// Rasterize a live applet subtree to an image with snapDOM — the capture half of
// snapshot-first LOD (docs/plans/applet-chartjs-implementation.md PR 5).
//
// snapDOM clones the subtree into an SVG <foreignObject> and paints it to a canvas,
// reading any embedded <canvas> (Chart/Graph/Map) via toDataURL — which is exactly why
// the rich elements were moved to canvas (PRs 2–4): they rasterize deterministically
// instead of hitting WebKit's foreignObject/SVG bugs. Capturing too early yields blank
// or fallback-font pixels, so we first wait for fonts AND every canvas leaf's
// data-capture-ready signal (use-capture-ready.ts).

import { snapdom } from "@zumer/snapdom"


/** Max time to wait for capture-readiness before snapping anyway (a stuck element must
 *  not block the capture forever — a slightly-early snap beats none). */
const CAPTURE_TIMEOUT_MS = 3000

/** Cap the effective raster resolution for LOD snapshots, as a device-pixel multiplier.
 *  snapDOM rasters at CSS-size × scale × dpr, and its `dpr` DEFAULTS to
 *  `window.devicePixelRatio` — so to bound the decoded bitmap (memory ≈ w·h·4·mult²) we
 *  must cap `dpr`, not `scale` (a capped `scale` would still be multiplied by the full
 *  device dpr, making retina *worse*). Snapshots show small (zoomed-out / motion), where
 *  >1.5× device pixels adds bytes but no visible detail. */
const MAX_SNAPSHOT_DPR = 1.5


/** Resolve once web fonts are loaded (or immediately if there's no FontFaceSet, as in
 *  jsdom / some embedded webviews — matches use-capture-ready's guard). */
async function fontsReady(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return
  try {
    await document.fonts.ready
  } catch {
    /* ignore — treat as ready */
  }
}


/** True when no descendant is still marked `data-capture-ready="false"` (a canvas leaf
 *  that hasn't committed its first paint). Elements with no such marker are ready. */
function allCaptureReady(el: HTMLElement): boolean {
  return el.querySelector('[data-capture-ready="false"]') === null
}


/** Resolve on the next animation frame (a one-frame settle). */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve())
    else resolve()
  })
}


/** Wait until fonts are ready AND every capture-ready leaf has committed, or `timeoutMs`
 *  elapses / `shouldCancel` trips. Polls on animation frames (cheap; only runs during a
 *  pending capture). A one-frame settle first lets a just-mounted canvas leaf register
 *  its `data-capture-ready="false"` marker before we sample, so we don't mistake
 *  "marker not set yet" for "ready". */
async function waitForCaptureReady(el: HTMLElement, timeoutMs: number, shouldCancel: () => boolean): Promise<void> {
  await fontsReady()
  if (shouldCancel()) return
  await nextFrame()
  if (allCaptureReady(el) || shouldCancel()) return
  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    // A wall-clock cap independent of rAF — so a backgrounded tab (rAF paused) or a
    // webview without requestAnimationFrame still resolves rather than hanging forever.
    const timer = setTimeout(finish, timeoutMs)
    const tick = () => {
      if (done) return
      if (allCaptureReady(el) || shouldCancel()) {
        finish()
        return
      }
      // No rAF to poll on (paused/absent) → don't spin; the setTimeout cap still resolves.
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(tick)
    }
    tick()
  })
}


/**
 * Rasterize `el` (a live applet subtree) to a decoded, immediately-drawable image, or
 * `null` on any failure. Waits for capture-readiness, snaps with snapDOM at the device
 * pixel ratio, and decodes so the result can be `drawImage`'d synchronously from the
 * canvas `getSnapshot` hook. Returns `null` — never throws — so a tainted canvas (a
 * cross-origin image without CORS makes toDataURL throw) or any snapDOM error degrades
 * to the glyph placeholder instead of killing the render.
 */
export async function snapshotApplet(
  el: HTMLElement,
  { timeoutMs = CAPTURE_TIMEOUT_MS, shouldCancel = () => false }: { timeoutMs?: number; shouldCancel?: () => boolean } = {},
): Promise<HTMLImageElement | null> {
  try {
    await waitForCaptureReady(el, timeoutMs, shouldCancel)
    if (shouldCancel()) return null // aborted (applet went off-screen / unmounted) — skip the raster
    const deviceDpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1
    // Cap DPR (not scale) — snapDOM multiplies scale × dpr, and dpr defaults to the
    // device value, so bounding memory means bounding the dpr it rasterizes at.
    const result = await snapdom(el, { dpr: Math.min(deviceDpr, MAX_SNAPSHOT_DPR) })
    const img = await result.toPng()
    // Decode so the <img> is drawable in a synchronous canvas paint (an undecoded image
    // draws nothing). decode() is absent in jsdom — guard it.
    if (typeof img.decode === "function") {
      await img.decode().catch(() => {})
    }
    return img
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn("[applet] snapshotApplet failed — falling back to placeholder:", err)
    }
    return null
  }
}
