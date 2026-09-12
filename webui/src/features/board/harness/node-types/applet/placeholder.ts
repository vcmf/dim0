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

  // Mini bar chart: a baseline + three bars of varying height, centered.
  ctx.globalAlpha = 0.35
  ctx.fillStyle = stroke
  ctx.strokeStyle = stroke

  const chartW = Math.min(w * 0.5, 140)
  const chartH = Math.min(h * 0.4, 80)
  const x0 = w / 2 - chartW / 2
  const yBase = h / 2 + chartH / 2
  const barW = chartW / 5
  const heights = [0.5, 0.9, 0.65]

  heights.forEach((frac, i) => {
    const barH = chartH * frac
    const x = x0 + i * (barW * 1.5) + barW * 0.25
    ctx.fillRect(x, yBase - barH, barW, barH)
  })

  // Baseline.
  ctx.globalAlpha = 0.5
  ctx.beginPath()
  ctx.moveTo(x0, yBase)
  ctx.lineTo(x0 + chartW, yBase)
  ctx.stroke()

  ctx.restore()
}
