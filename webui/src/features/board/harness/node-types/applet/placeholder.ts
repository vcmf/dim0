// Applet canvas placeholder.
//
// Drawn instead of the React view when zoomed out below `minZoomForReact`
// (see def.ts). Same card style as the other node placeholders, with a small
// bar-chart glyph to read as "data/interactive app" at a glance.

import type { Node, RenderEnv } from "@canvas-harness/core"


/** Draw the applet placeholder card + a mini bar-chart glyph onto the canvas. */
export const drawAppletPlaceholder = (ctx: CanvasRenderingContext2D, node: Node, env: RenderEnv): void => {
  const { w, h } = node
  const card = (env.theme("card") as string) ?? "#ffffff"
  const stroke = (env.theme("muted-foreground") as string) ?? "#9ca3af"
  const r = Math.min(24, w * 0.06, h * 0.06)

  ctx.save()
  ctx.fillStyle = card
  ctx.strokeStyle = stroke
  ctx.lineWidth = 1.5
  ctx.lineCap = "round"
  ctx.lineJoin = "round"

  // Rounded card body.
  ctx.beginPath()
  ctx.moveTo(r, 0)
  ctx.lineTo(w - r, 0)
  ctx.quadraticCurveTo(w, 0, w, r)
  ctx.lineTo(w, h - r)
  ctx.quadraticCurveTo(w, h, w - r, h)
  ctx.lineTo(r, h)
  ctx.quadraticCurveTo(0, h, 0, h - r)
  ctx.lineTo(0, r)
  ctx.quadraticCurveTo(0, 0, r, 0)
  ctx.closePath()
  ctx.fill()
  ctx.globalAlpha = 0.5
  ctx.stroke()

  // Mini LINE chart: a polyline with small node dots — distinct from the widget
  // placeholder's bar-chart glyph so the two read differently when zoomed out.
  ctx.globalAlpha = 0.5
  ctx.strokeStyle = stroke
  ctx.fillStyle = stroke

  const chartW = Math.min(w * 0.5, 140)
  const chartH = Math.min(h * 0.4, 80)
  const x0 = w / 2 - chartW / 2
  const yTop = h / 2 - chartH / 2
  const points = [0.7, 0.35, 0.55, 0.1, 0.4] // fraction from the top (smaller = higher)
  const px = (i: number): number => x0 + (chartW * i) / (points.length - 1)
  const py = (frac: number): number => yTop + chartH * frac

  ctx.beginPath()
  points.forEach((frac, i) => (i === 0 ? ctx.moveTo(px(i), py(frac)) : ctx.lineTo(px(i), py(frac))))
  ctx.stroke()

  points.forEach((frac, i) => {
    ctx.beginPath()
    ctx.arc(px(i), py(frac), 2.5, 0, Math.PI * 2)
    ctx.fill()
  })

  ctx.restore()
}
