// Build the themed, snapshot-safe Chart.js options for an applet chart. Kept out of
// applet-chart-impl.tsx (which imports chart.js) so it's unit-testable without a canvas.

import { resolveToken } from "@/lib/theme/resolve-token"

import type { AppletChartType } from "./types"


function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}


/** Recursively merge `override` onto `base` (override wins at the leaves; nested
 *  plain objects are merged key-by-key, not replaced). */
export function mergeDeep(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(override)) {
    const prev = out[k]
    out[k] = isPlainObject(v) && isPlainObject(prev) ? mergeDeep(prev, v) : v
  }
  return out
}


// Axis-aware themed scales: none for pie/doughnut (no axes), the radial `r` axis for
// radar, x/y otherwise.
function themedScales(type: AppletChartType, muted: string, grid: string): Record<string, unknown> | undefined {
  if (type === "pie" || type === "doughnut") return undefined
  // A factory so x and y are DISTINCT objects (no shared reference handed to Chart.js).
  const axis = () => ({ ticks: { color: muted }, grid: { color: grid } })
  if (type === "radar") return { r: { ...axis(), angleLines: { color: grid }, pointLabels: { color: muted } } }
  return { x: axis(), y: axis() }
}


/**
 * Themed Chart.js options for `type`, DEEP-merged under the author's `user` options
 * (author wins at every leaf, so `options={{ scales: { y: { min: 0 } } }}` keeps the
 * themed tick/grid colors on that axis). `animation` is forced off last for
 * deterministic + fast snapshots. Colors resolve per active theme — rebuild on a
 * theme change.
 */
export function themedOptions(type: AppletChartType, user: Record<string, unknown> = {}): Record<string, unknown> {
  const fg = resolveToken("foreground")
  const muted = resolveToken("muted-foreground")
  const grid = resolveToken("border")
  const scales = themedScales(type, muted, grid)
  const base: Record<string, unknown> = {
    responsive: true,
    maintainAspectRatio: false,
    color: fg,
    plugins: { legend: { labels: { color: fg } } },
    ...(scales ? { scales } : {}),
  }
  return { ...mergeDeep(base, user), animation: false }
}
