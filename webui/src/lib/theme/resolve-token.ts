// Resolve an applet/chart color token to a CONCRETE color for canvas.
//
// Canvas `ctx.fillStyle` can't read `var(--foreground)` / oklch `color-mix(...)`,
// so a canvas renderer (Chart.js, Graph, Map) must hand it a concrete `rgb(...)`.
// This maps a theme token name (`chart-1`, `primary`, `foreground`, …) — or a raw
// color, or a `var(--x)` string — to the browser-computed concrete color via the
// `readCssVarMixed` DOM probe (the only robust oklch/`color-mix` concretizer).
// See docs/plans/applet-chartjs-migration.md §5.

import { readCssVarMixed } from "./css-vars"


// The theme tokens that exist as real CSS custom properties (mirrors the set in
// components/charts/color-token.ts; kept here so `lib/` doesn't depend on a
// component). index.css declares `--chart-1`, `--primary`, … not `--color-*`.
export const THEME_TOKEN_NAMES: ReadonlySet<string> = new Set([
  "chart-1", "chart-2", "chart-3", "chart-4", "chart-5",
  "primary", "primary-foreground",
  "secondary", "secondary-foreground",
  "destructive", "destructive-foreground",
  "accent", "accent-foreground",
  "muted", "muted-foreground",
  "foreground", "background", "border",
  "card", "card-foreground",
])


/**
 * Map an input to the `--custom-property` it names, or `null` if it isn't a theme
 * token. Pure (no DOM) — the testable decision layer. `chart-1` → `--chart-1`;
 * `var(--chart-1)` → `--chart-1`; a raw color (`#abc`, `rgb(...)`, `oklch(...)`) →
 * `null` (passes through unresolved).
 */
export function tokenToCssVar(input: string): string | null {
  const trimmed = input.trim()
  const fromVar = trimmed.match(/^var\(\s*(--[\w-]+)\s*\)$/)
  if (fromVar) return fromVar[1]
  const bare = trimmed.startsWith("--") ? trimmed.slice(2) : trimmed
  return THEME_TOKEN_NAMES.has(bare) ? `--${bare}` : null
}


/**
 * Resolve a token/color to a concrete color string usable as `ctx.fillStyle`.
 * A theme token resolves via the browser probe; a raw color (hex/rgb/oklch/named)
 * passes through unchanged. Empty/undefined → `foreground` as a safe default.
 * Call at draw time and re-run on theme change (the value is theme-dependent).
 */
export function resolveToken(input: string | undefined | null): string {
  if (input == null || input.trim() === "") return readCssVarMixed("--foreground", 100)
  const cssVar = tokenToCssVar(input)
  return cssVar ? readCssVarMixed(cssVar, 100) : input.trim()
}


/** The default categorical color for series `index`, cycling the 5 chart tokens. */
export function paletteColor(index: number): string {
  return resolveToken(`chart-${(index % 5) + 1}`)
}
