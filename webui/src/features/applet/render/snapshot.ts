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


/** Wait until fonts are ready AND every capture-ready leaf has committed, or `timeoutMs`
 *  elapses. Polls on animation frames (cheap; only runs during a pending capture). */
async function waitForCaptureReady(el: HTMLElement, timeoutMs: number): Promise<void> {
  await fontsReady()
  if (allCaptureReady(el)) return
  await new Promise<void>((resolve) => {
    const start = typeof performance !== "undefined" ? performance.now() : Date.now()
    const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now())
    const tick = () => {
      if (allCaptureReady(el) || now() - start > timeoutMs) {
        resolve()
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
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
  { timeoutMs = CAPTURE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<HTMLImageElement | null> {
  try {
    await waitForCaptureReady(el, timeoutMs)
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1
    const result = await snapdom(el, { scale: dpr })
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
