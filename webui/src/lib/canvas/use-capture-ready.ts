// Signal when an element is safe to snapshot. snapDOM (and any foreignObject
// rasterizer) captures whatever is painted at that instant, so a too-early capture
// yields blank/partial content. An element is capture-ready once web fonts have
// loaded AND its own render has committed. This sets `data-capture-ready` on the
// element so the snapshotter (docs/plans/applet-chartjs-implementation.md PR 5) can
// wait for it, and returns the boolean for local use.

import { useEffect, useState, type RefObject } from "react"


/**
 * True once `document.fonts.ready` has resolved AND the caller-provided `rendered`
 * flag is set (e.g. the chart/map lib's render-complete, or the canvas draw commit).
 * Writes `data-capture-ready="true"|"false"` onto `ref`'s element as a side effect.
 */
export function useCaptureReady(ref: RefObject<HTMLElement | null>, rendered: boolean): boolean {
  const [fontsReady, setFontsReady] = useState(false)

  useEffect(() => {
    let active = true
    const done = () => {
      if (active) setFontsReady(true)
    }
    // No FontFaceSet (jsdom, some embedded webviews) → treat fonts as ready so the
    // element can never be stuck un-capturable.
    if (typeof document === "undefined" || !document.fonts) {
      done()
      return
    }
    document.fonts.ready.then(done).catch(done)
    return () => {
      active = false
    }
  }, [])

  const ready = fontsReady && rendered

  useEffect(() => {
    const el = ref.current
    if (el) el.dataset.captureReady = String(ready)
  }, [ref, ready])

  return ready
}
