// The applet `<Chart>` — Chart.js on a canvas, themed + snapshot-ready.
//
// Heavy (Chart.js ~65 KB) so it's lazy-loaded via applet-chart.tsx. Only the applet
// renderer uses it; the legacy recharts ChartElement is untouched (mini-apps/widgets).
// Canvas (not SVG) so the whole applet snapshots cleanly (design §2). Colors resolve
// through the shared harness and re-theme on a data-theme/data-mode change; animation
// is OFF for deterministic, fast snapshots.

import { useCallback, useEffect, useRef, useState } from "react"

import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  DoughnutController,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PieController,
  PointElement,
  RadarController,
  RadialLinearScale,
  ScatterController,
  Title,
  Tooltip,
  type ChartConfiguration,
} from "chart.js"

import { useCaptureReady } from "@/lib/canvas/use-capture-ready"

import { themedOptions } from "./chart-options"
import { themeChartData } from "./theme-data"
import type { AppletChartData, AppletChartProps, AppletChartType } from "./types"


// Register only the controllers/elements/scales the applet chart types use (v4 is
// tree-shakeable — this keeps the lazy chunk lean).
Chart.register(
  BarController, LineController, PieController, DoughnutController, ScatterController, RadarController,
  BarElement, LineElement, PointElement, ArcElement,
  CategoryScale, LinearScale, RadialLinearScale,
  Filler, Tooltip, Legend, Title,
)


// Map the applet type to a real Chart.js type (+ whether to fill the line for "area").
function mapType(type: AppletChartType): { chartType: string; fill: boolean } {
  if (type === "area") return { chartType: "line", fill: true }
  return { chartType: type, fill: false }
}


// Apply `fill: true` to line datasets when the applet type is "area" (unless the
// author already set it).
function withFill(data: AppletChartData, fill: boolean): AppletChartData {
  if (!fill) return data
  return { ...data, datasets: data.datasets.map((ds) => ({ fill: true, ...ds })) }
}


/** The Chart.js-backed applet chart (lazy-loaded target). */
export function AppletChartImpl({ type, data, options, height, className }: AppletChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<Chart | null>(null)
  const [rendered, setRendered] = useState(false)

  // Latest props for the imperative Chart.js calls (avoids stale closures without
  // recreating the chart on every data/theme tick).
  const propsRef = useRef({ type, data, options })
  propsRef.current = { type, data, options }

  useCaptureReady(wrapRef, rendered)

  // Re-theme + push the latest data/options into the existing chart (no recreate).
  const applyData = useCallback(() => {
    const chart = chartRef.current
    if (!chart) return
    const p = propsRef.current
    const { fill } = mapType(p.type)
    chart.data = withFill(themeChartData(p.type, p.data), fill) as Chart["data"]
    chart.options = themedOptions(p.type, p.options) as Chart["options"]
    chart.update("none")
  }, [])

  // Create/destroy the chart when `type` changes — Chart.js can't swap type live.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const p = propsRef.current
    const { chartType, fill } = mapType(p.type)
    const config = {
      type: chartType,
      data: withFill(themeChartData(p.type, p.data), fill),
      options: themedOptions(p.type, p.options),
    } as unknown as ChartConfiguration
    const chart = new Chart(canvas, config)
    chartRef.current = chart
    setRendered(true)
    return () => {
      chart.destroy()
      chartRef.current = null
      setRendered(false)
    }
  }, [type])

  // Update in place when data/options CONTENT changes. Key on serialized signatures,
  // not object identity — applets recreate inline `data={{…}}`/`options={{…}}` literals
  // every render, so identity deps would fire chart.update() on every unrelated
  // re-render (a wasted reflow).
  const dataSig = JSON.stringify(data ?? null)
  const optSig = JSON.stringify(options ?? null)
  useEffect(() => {
    applyData()
  }, [dataSig, optSig, applyData])

  // Re-theme on a theme/mode flip.
  useEffect(() => {
    const obs = new MutationObserver(() => applyData())
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-mode"] })
    return () => obs.disconnect()
  }, [applyData])

  return (
    <div ref={wrapRef} className={className} style={{ position: "relative", width: "100%", height: height ?? 220 }}>
      <canvas ref={canvasRef} />
    </div>
  )
}
