// Inject the theme palette into a Chart.js data config.
//
// Chart.js needs concrete colors (canvas can't read CSS vars), and applets should
// theme for free. So for each dataset we resolve any author-specified color tokens
// to concrete colors, and auto-assign the chart-1..5 ramp when none is given —
// per-slice for pie/doughnut, per-series otherwise. Re-run on theme change (the
// resolved colors are theme-dependent). See applet-chartjs-migration.md §5.

import { paletteColor, resolveToken } from "@/lib/theme/resolve-token"

import type { AppletChartData, AppletChartType, AppletDataset } from "./types"


const SLICE_TYPES = new Set<AppletChartType>(["pie", "doughnut"])


/** Resolve a color string, or map an array of colors, to concrete color(s). */
function resolveColorProp(value: string | string[]): string | string[] {
  return typeof value === "string" ? resolveToken(value) : value.map((v) => resolveToken(v))
}


/** Themed copy of one dataset: resolve given colors, else assign from the palette. */
function themeDataset(type: AppletChartType, ds: AppletDataset, index: number): AppletDataset {
  const out: AppletDataset = { ...ds }

  if (SLICE_TYPES.has(type)) {
    // Pie/doughnut: one color PER SLICE. Resolve a given array/color, else build the
    // ramp across the slices.
    const sliceCount = Array.isArray(ds.data) ? ds.data.length : 0
    out.backgroundColor =
      ds.backgroundColor != null
        ? resolveColorProp(ds.backgroundColor)
        : Array.from({ length: sliceCount }, (_, s) => paletteColor(s))
    if (ds.borderColor != null) out.borderColor = resolveColorProp(ds.borderColor)
    return out
  }

  // Cartesian/line/bar/scatter/radar: one color for the series (fall back to the
  // ramp by dataset index).
  const seriesColor = paletteColor(index)
  out.backgroundColor = ds.backgroundColor != null ? resolveColorProp(ds.backgroundColor) : seriesColor
  out.borderColor = ds.borderColor != null ? resolveColorProp(ds.borderColor) : seriesColor
  return out
}


/**
 * Return a themed copy of `data`: every dataset gets resolved/assigned colors for the
 * given chart `type`. Non-color dataset props are preserved. Pure aside from the
 * theme probe inside `resolveToken`/`paletteColor` (call at render time).
 */
export function themeChartData(type: AppletChartType, data: AppletChartData): AppletChartData {
  return {
    ...data,
    datasets: (data.datasets ?? []).map((ds, i) => themeDataset(type, ds, i)),
  }
}
