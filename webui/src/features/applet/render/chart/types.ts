// The applet `<Chart>` API — a restricted, declarative subset of Chart.js's config.
//
// One `{ type, data, options }` shape for EVERY chart type (design
// applet-chartjs-migration.md §2.1): pie/doughnut use the same `{ labels, datasets:
// [{ data }] }` as bar/line, so the old "pie needs a different shape" silent-fail is
// gone. `options` are plain Chart.js options only — the applet interpreter can't
// produce functions, so callback options (tooltip/tick formatters) aren't expressible
// (they'd be an author-time error, not a silent no-op).

// The single source of truth for the chart kinds. The `AppletChartType` union derives
// from it, and author-time validation (compile/dry-eval.ts) reads it — so adding a kind
// here updates both. ("area" renders as a filled line.)
export const CHART_TYPES = ["bar", "line", "area", "pie", "doughnut", "scatter", "radar"] as const

export type AppletChartType = (typeof CHART_TYPES)[number]


/** One dataset. Extra Chart.js dataset keys pass through; colors accept theme tokens
 *  (`chart-1`, `primary`, …) or raw colors and are resolved to concrete colors. */
export interface AppletDataset {
  label?: string
  data: Array<number | null | { x: number; y: number }>
  backgroundColor?: string | string[]
  borderColor?: string | string[]
  [key: string]: unknown
}


export interface AppletChartData {
  labels?: Array<string | number>
  datasets: AppletDataset[]
}


export interface AppletChartProps {
  type: AppletChartType
  /** Optional — an omitted `data` renders an empty chart rather than crashing. */
  data?: AppletChartData
  /** Plain Chart.js options (no callbacks). Merged over the applet defaults. */
  options?: Record<string, unknown>
  /** Container height in px (default 220). Width fills the applet layout box. */
  height?: number
  className?: string
}
