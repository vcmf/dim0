// Inject the theme palette into a Chart.js data config.
//
// Chart.js needs concrete colors (canvas can't read CSS vars), and applets should
// theme for free. So for each dataset we resolve any author-specified color tokens
// to concrete colors, and auto-assign the chart-1..5 ramp when none is given —
// per-slice for pie/doughnut, per-series otherwise. Re-run on theme change (the
// resolved colors are theme-dependent). See applet-chartjs-migration.md §5.

import { readCssVarMixed } from "@/lib/theme/css-vars"
import { paletteColor, resolveToken } from "@/lib/theme/resolve-token"

import type { AppletChartData, AppletChartType, AppletDataset } from "./types"


const SLICE_TYPES = new Set<AppletChartType>(["pie", "doughnut"])


/** Resolve a color string, or map an array of colors, to concrete color(s). */
function resolveColorProp(value: string | string[]): string | string[] {
  return typeof value === "string" ? resolveToken(value) : value.map((v) => resolveToken(v))
}


/** A translucent chart-ramp color for area fills (opaque fills occlude other series). */
function paletteFill(index: number): string {
  return readCssVarMixed(`--chart-${(index % 5) + 1}`, 22)
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

  // Cartesian: the series color (border) from the ramp; area fills are translucent so
  // stacked areas don't occlude each other, other types share the opaque series color.
  const seriesColor = paletteColor(index)
  out.borderColor = ds.borderColor != null ? resolveColorProp(ds.borderColor) : seriesColor
  out.backgroundColor =
    ds.backgroundColor != null
      ? resolveColorProp(ds.backgroundColor)
      : type === "area"
        ? paletteFill(index)
        : seriesColor
  return out
}


/**
 * Return a themed copy of `data`: every dataset gets resolved/assigned colors for the
 * given chart `type`. Non-color dataset props are preserved; a missing/omitted `data`
 * yields an empty-dataset config (never throws). Pure aside from the theme probe
 * inside `resolveToken`/`paletteColor` (call at render time).
 */
export function themeChartData(type: AppletChartType, data: AppletChartData | undefined): AppletChartData {
  return {
    labels: data?.labels,
    datasets: (data?.datasets ?? []).map((ds, i) => themeDataset(type, ds, i)),
  }
}
