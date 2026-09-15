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
 * Map an input to the `--custom-property` it names, or `null` if it isn't a KNOWN
 * theme token. Pure (no DOM). Handles bare (`chart-1`), `--`-prefixed (`--chart-1`),
 * and `var(--chart-1)` spellings identically — all check membership, so
 * `chart-1`/`--chart-1`/`var(--chart-1)` → `--chart-1` while `chart-9` and
 * `var(--chart-9)` both → `null` (consistent; no silent garbage from an unset var).
 * A raw color (`#abc`, `rgb(...)`, `oklch(...)`) → `null` (handled by `resolveToken`).
 */
export function tokenToCssVar(input: string): string | null {
  const trimmed = input.trim()
  const fromVar = trimmed.match(/^var\(\s*--([\w-]+)\s*\)$/)
  const name = fromVar ? fromVar[1] : trimmed.startsWith("--") ? trimmed.slice(2) : trimmed
  return THEME_TOKEN_NAMES.has(name) ? `--${name}` : null
}


// Cache concrete colors per (theme, token). readCssVarMixed appends+measures+removes
// a DOM probe (a forced style/layout flush), so resolving per-draw for an N-series
// chart would cause N reflows per frame; caching makes repeat resolves free until the
// theme changes.
//
// ASSUMPTION: the theme is fully identified by the `data-theme`/`data-mode` attributes
// on `<html>` — which is how this app themes (theme-provider.tsx), and the same signal
// `useCanvasSurface` redraws on. If theming ever becomes non-attribute (a live editor
// overriding `--primary` inline, a subtree-scoped theme), both this cache AND that
// redraw trigger must be revisited; call `clearTokenCache()` to drop stale entries.
const probeCache = new Map<string, string>()


/** A key for the active theme: the `data-theme`/`data-mode` attributes on `<html>`. */
function themeSignature(): string {
  if (typeof document === "undefined") return ""
  const r = document.documentElement
  return `${r.dataset.theme ?? ""}:${r.dataset.mode ?? ""}`
}


/** Resolve `cssVar` to a concrete color via the probe, memoized per active theme. */
function cachedMix(cssVar: string): string {
  const key = `${themeSignature()}|${cssVar}`
  const hit = probeCache.get(key)
  if (hit !== undefined) return hit
  const value = readCssVarMixed(cssVar, 100)
  probeCache.set(key, value)
  return value
}


/** Drop all memoized colors — for a non-attribute theme change (see the cache note). */
export function clearTokenCache(): void {
  probeCache.clear()
}


/**
 * Resolve a token/color to a concrete color string usable as `ctx.fillStyle`.
 * A theme token (bare, `--`, or `var()`) resolves via the browser probe (cached per
 * theme); a valid raw color (hex/rgb/oklch/named) passes through; empty/undefined →
 * `foreground`. An unresolvable input (a typo like `chart-9`/`forground`, or a
 * non-theme `var(--x)` canvas can't read) → `foreground` fallback + a DEV warning,
 * so a mistake shows a visible color instead of silently keeping the prior fill.
 */
export function resolveToken(input: string | undefined | null): string {
  if (input == null || input.trim() === "") return cachedMix("--foreground")
  const cssVar = tokenToCssVar(input)
  if (cssVar) return cachedMix(cssVar)

  // Not a known theme token: a valid literal color passes through; anything else
  // (a typo, or a var() we can't hand to canvas) falls back visibly.
  const raw = input.trim()
  const isVar = raw.includes("var(")
  const canValidate = typeof CSS !== "undefined" && typeof CSS.supports === "function"
  if (!isVar && (!canValidate || CSS.supports("color", raw))) return raw

  if (import.meta.env.DEV) {
    console.warn(`[applet] resolveToken: unresolvable color "${input}" — using foreground fallback`)
  }
  return cachedMix("--foreground")
}


/** The default categorical color for series `index`, cycling the 5 chart tokens.
 *  Tolerates a negative, fractional, or NaN index (wraps into 1..5). */
export function paletteColor(index: number): string {
  const i = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0
  return resolveToken(`chart-${(i % 5) + 1}`)
}
