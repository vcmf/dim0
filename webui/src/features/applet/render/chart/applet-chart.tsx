// Lazy wrapper around the Chart.js-heavy AppletChartImpl — Chart.js (~65 KB) loads
// only the first time an applet renders a chart, then stays cached. The fallback
// reserves the height so layout doesn't jump. Mirrors the recharts chart.tsx pattern.

import { Suspense, lazy } from "react"

import type { AppletChartProps } from "./types"


const Impl = lazy(() => import("./applet-chart-impl").then((m) => ({ default: m.AppletChartImpl })))


/** The applet `<Chart>` component (registered in the applet renderer). */
export function AppletChart(props: AppletChartProps) {
  const fallback = <div style={{ width: "100%", height: props.height ?? 220 }} aria-label="Loading chart" />
  return (
    <Suspense fallback={fallback}>
      <Impl {...props} />
    </Suspense>
  )
}
