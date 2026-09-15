// Manage a `<canvas>` as a DPR-crisp, theme-reactive drawing surface — the shared
// primitive behind the applet's canvas rich elements (Chart.js sizing aside;
// Graph/Map draw through this). It sizes the backing store to cssSize ×
// devicePixelRatio and calls `draw(ctx, size)` on mount, on element resize, on theme
// change, and after fonts load — the four moments a canvas must repaint (canvas
// pixels don't reflow with CSS/fonts). See docs/plans/applet-chartjs-migration.md §5.

import { useEffect, type RefObject } from "react"


/** Drawing size in CSS pixels (the ctx is pre-scaled by dpr, so draw in CSS px). */
export interface CanvasSize {
  width: number
  height: number
}


/**
 * Drive a canvas draw loop with DPR sizing + theme reactivity. `draw` is called with
 * a `ctx` already scaled to devicePixelRatio (draw in CSS pixels) on a cleared
 * surface. Redraws on: mount, container resize, a `data-theme`/`data-mode` change,
 * `document.fonts.ready`, and a `devicePixelRatio` change (moving to a different-DPR
 * display / browser zoom). Bursts are coalesced to one draw per frame.
 *
 * **The caller MUST give the `<canvas>` a CSS size** (e.g. `width:100%; height:200px`,
 * or a sized container) — the backing store is derived from the measured CSS box.
 * With a CSS size, writing `canvas.width` (the intrinsic size) does NOT change the CSS
 * box, so observing the canvas itself is loop-free *and* catches a canvas-only
 * relayout (a flex/grid sibling changing this canvas's box while the parent's is
 * fixed). Without a CSS size the intrinsic size drives layout and this WOULD loop —
 * hence the contract.
 *
 * `draw` should be stable (wrap in `useCallback`), and `deps` must be a
 * **stable-length** array (like any hook dependency list — it's spread into the
 * effect deps); pass what should also trigger a redraw (e.g. the data).
 */
export function useCanvasSurface(
  ref: RefObject<HTMLCanvasElement | null>,
  draw: (ctx: CanvasRenderingContext2D, size: CanvasSize) => void,
  deps: readonly unknown[] = [],
): void {
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return

    let frame = 0
    let cancelled = false
    let lastW = -1
    let lastH = -1
    let dprMql: MediaQueryList | null = null

    const render = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const c = ref.current
        if (!c) return
        const rect = c.getBoundingClientRect()
        const width = rect.width || c.clientWidth
        const height = rect.height || c.clientHeight
        if (width === 0 || height === 0) return
        const dpr = window.devicePixelRatio || 1
        const bw = Math.round(width * dpr)
        const bh = Math.round(height * dpr)
        // Setting canvas.width/height resets the bitmap + context state, so only do it
        // when the target actually changed (avoids clearing on a theme-only redraw).
        if (bw !== lastW || bh !== lastH) {
          c.width = bw
          c.height = bh
          lastW = bw
          lastH = bh
        }
        const ctx = c.getContext("2d")
        if (!ctx) return
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0) // draw in CSS px; crisp at dpr
        ctx.clearRect(0, 0, width, height)
        draw(ctx, { width, height })
      })
    }

    // A `matchMedia((resolution: <dpr>dppx))` matches only the current dpr; it fires
    // once when dpr leaves that value, so re-arm for the new dpr each time.
    const onDprChange = (): void => {
      lastW = lastH = -1 // force a backing-store resize at the new dpr
      armDpr()
      render()
    }
    const armDpr = (): void => {
      dprMql?.removeEventListener("change", onDprChange)
      dprMql = typeof window.matchMedia === "function" ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`) : null
      dprMql?.addEventListener("change", onDprChange)
    }
    armDpr()

    render()

    // Observe the canvas itself: with the required CSS size, writing canvas.width
    // doesn't change the observed CSS box (no loop), and a canvas-only relayout is
    // still caught.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => render()) : null
    ro?.observe(canvas)

    const mo = new MutationObserver(() => render())
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-mode"] })

    document.fonts?.ready
      .then(() => {
        if (!cancelled) render()
      })
      .catch(() => {})

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      ro?.disconnect()
      mo.disconnect()
      dprMql?.removeEventListener("change", onDprChange)
    }
    // `draw` + `deps` are the caller-controlled redraw triggers; the internal
    // observers cover resize/theme/fonts/dpr.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, draw, ...deps])
}
