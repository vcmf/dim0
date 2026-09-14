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
 * surface. Redraws on: mount, ResizeObserver (the canvas's own box), a
 * `data-theme`/`data-mode` change, and `document.fonts.ready`. Bursts are coalesced
 * to one draw per frame. `draw` should be stable (wrap in `useCallback`); pass extra
 * `deps` (e.g. the data) that should also trigger a redraw.
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
        c.width = Math.round(width * dpr)
        c.height = Math.round(height * dpr)
        const ctx = c.getContext("2d")
        if (!ctx) return
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0) // draw in CSS px; crisp at dpr
        ctx.clearRect(0, 0, width, height)
        draw(ctx, { width, height })
      })
    }

    render()

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
    }
    // `draw` + `deps` are the caller-controlled redraw triggers; the internal
    // observers cover resize/theme/fonts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, draw, ...deps])
}
