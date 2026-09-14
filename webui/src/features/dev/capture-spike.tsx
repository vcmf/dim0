// PR 0 — WebKit capture spike (throwaway; DEV-only route /dev/capture-spike).
//
// Purpose: prove snapDOM faithfully + quickly captures a COMPOSED applet-like
// subtree — Card + themed text in our three @fontsource faces + a <canvas> drawn
// with theme-resolved colors at devicePixelRatio — on real Tauri/WKWebView (and
// Chrome). This de-risks the whole snapshot-first architecture
// (docs/plans/applet-chartjs-migration.md §9.6 / -implementation.md PR 0) before
// any element migration. Delete once the finding is recorded.
//
// What to eyeball in the captured PNG on WKWebView:
//   1. Fonts — handwriting title, mono code, sans body all render (self-hosted
//      @fontsource @font-face should embed cleanly; the #1 snapDOM gotcha).
//   2. Theme — the CSS-var colored surfaces (bg-secondary, text-chart-*) match live.
//   3. Canvas — the bars/labels appear (canvas is captured via toDataURL, the exact
//      reason we push rich elements to canvas).
//   4. Latency — cold vs warm capture time; Nx throughput; both logged on-screen.
//   5. Theme switch — flip data-mode and re-capture; colors (HTML + canvas) update.

import { useCallback, useEffect, useRef, useState } from "react"

import { snapdom } from "@zumer/snapdom"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { readCssVarMixed } from "@/features/board/harness/theme/css-vars"


// Draw a mini bar chart into `canvas` at DPR, using theme-resolved chart colors —
// a stand-in for the real Chart.js/Graph/Map canvases (snapDOM treats all canvases
// the same). Returns after the paint so a capture can wait for it.
function drawSpikeCanvas(canvas: HTMLCanvasElement): void {
  const cssW = 320
  const cssH = 140
  const dpr = window.devicePixelRatio || 1
  canvas.style.width = `${cssW}px`
  canvas.style.height = `${cssH}px`
  canvas.width = Math.round(cssW * dpr)
  canvas.height = Math.round(cssH * dpr)
  const ctx = canvas.getContext("2d")
  if (!ctx) return
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, cssW, cssH)

  const values = [64, 92, 41, 78, 55]
  const colors = [1, 2, 3, 4, 5].map((n) => readCssVarMixed(`--chart-${n}`, 100))
  const foreground = readCssVarMixed("--foreground", 100)
  const barW = 44
  const gap = 16
  const base = cssH - 24
  values.forEach((v, i) => {
    const x = 12 + i * (barW + gap)
    const h = (v / 100) * (cssH - 48)
    ctx.fillStyle = colors[i]
    ctx.fillRect(x, base - h, barW, h)
    ctx.fillStyle = foreground
    ctx.font = "11px Inconsolata, monospace"
    ctx.textAlign = "center"
    ctx.fillText(String(v), x + barW / 2, base + 14)
  })
}


interface Shot {
  src: string
  ms: number
  label: string
}


/** DEV-only spike page: render a composed themed card + a canvas, then snapshot it
 *  with snapDOM and show the PNG side-by-side with timings. */
export function CaptureSpikePage() {
  const cardRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [shots, setShots] = useState<Shot[]>([])
  const [busy, setBusy] = useState(false)
  const [fontsReady, setFontsReady] = useState(false)

  useEffect(() => {
    if (canvasRef.current) drawSpikeCanvas(canvasRef.current)
    document.fonts.ready.then(() => setFontsReady(true)).catch(() => setFontsReady(true))
  }, [])

  // Capture the card subtree N times; record the first (cold) and the mean of the
  // rest (warm), plus a preview of the first PNG.
  const capture = useCallback(async (n: number) => {
    const el = cardRef.current
    if (!el || busy) return
    setBusy(true)
    try {
      await document.fonts.ready
      let firstSrc = ""
      const times: number[] = []
      for (let i = 0; i < n; i += 1) {
        const t0 = performance.now()
        const result = await snapdom(el, { scale: window.devicePixelRatio || 1 })
        const img = await result.toPng()
        times.push(performance.now() - t0)
        if (i === 0) firstSrc = img.src
      }
      const cold = times[0]
      const warm = times.length > 1 ? times.slice(1).reduce((a, b) => a + b, 0) / (times.length - 1) : cold
      setShots((s) => [
        { src: firstSrc, ms: cold, label: `cold ${cold.toFixed(0)}ms · warm×${n - 1} ${warm.toFixed(0)}ms · ${(firstSrc.length / 1024).toFixed(0)}KB` },
        ...s,
      ])
    } catch (e) {
      setShots((s) => [{ src: "", ms: 0, label: `CAPTURE FAILED: ${e instanceof Error ? e.message : String(e)}` }, ...s])
    } finally {
      setBusy(false)
    }
  }, [busy])

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <h1 className="mb-1 text-lg font-semibold">snapDOM capture spike</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Fonts ready: <span className="font-mono">{String(fontsReady)}</span> · dpr:{" "}
        <span className="font-mono">{window.devicePixelRatio}</span> · run this in Tauri/WKWebView and compare the
        captured PNG to the live card (fonts, theme colors, canvas bars).
      </p>

      <div className="mb-4 flex gap-2">
        <button className="rounded-md border bg-secondary px-3 py-1.5 text-sm text-secondary-foreground disabled:opacity-50" disabled={busy} onClick={() => capture(1)}>
          Capture ×1
        </button>
        <button className="rounded-md border bg-secondary px-3 py-1.5 text-sm text-secondary-foreground disabled:opacity-50" disabled={busy} onClick={() => capture(10)}>
          Capture ×10 (throughput)
        </button>
        <button className="rounded-md border px-3 py-1.5 text-sm" onClick={() => setShots([])}>
          Clear
        </button>
      </div>

      <div className="flex flex-wrap gap-8">
        {/* LIVE — the composed applet-like card we'll snapshot. */}
        <div>
          <div className="mb-1 text-xs text-muted-foreground">LIVE</div>
          <div ref={cardRef} className="inline-block">
            <Card className="w-[380px] p-4">
              <CardHeader className="pb-2">
                <CardTitle className="font-handwriting text-xl">Capture Fidelity</CardTitle>
                <p className="text-sm text-muted-foreground">Card + 3 fonts + theme + canvas</p>
              </CardHeader>
              <CardContent>
                <p className="mb-2 text-sm">
                  Body text in <span className="font-sans font-semibold">sans</span>, a{" "}
                  <code className="rounded bg-muted px-1 font-mono text-xs">mono</code> token, and colored surfaces:
                </p>
                <div className="mb-3 grid grid-cols-5 gap-1 text-center text-[10px] text-background">
                  {/* Literal class strings so Tailwind's JIT generates them (a `bg-chart-${n}` template would be skipped). */}
                  <div className="rounded bg-chart-1 py-2">c1</div>
                  <div className="rounded bg-chart-2 py-2">c2</div>
                  <div className="rounded bg-chart-3 py-2">c3</div>
                  <div className="rounded bg-chart-4 py-2">c4</div>
                  <div className="rounded bg-chart-5 py-2">c5</div>
                </div>
                <div className="rounded-lg bg-secondary p-2 text-secondary-foreground">
                  <canvas ref={canvasRef} aria-label="spike bar chart" />
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* CAPTURED — snapDOM output(s). */}
        <div>
          <div className="mb-1 text-xs text-muted-foreground">CAPTURED (snapDOM)</div>
          <div className="flex flex-col gap-3">
            {shots.length === 0 && <div className="text-sm text-muted-foreground">— none yet —</div>}
            {shots.map((shot, i) => (
              <div key={i}>
                <div className="mb-0.5 font-mono text-xs text-muted-foreground">{shot.label}</div>
                {shot.src ? <img src={shot.src} alt="capture" className="inline-block border" /> : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
