// A shared source of truth for "the theme just changed" — one module-level
// MutationObserver on <html>'s data-theme/data-mode, fanned out to subscribers, over the
// canonical `themeSignature()` reader from resolve-token.ts.
//
// This is the intended home for the pattern; new consumers should subscribe here rather
// than install their own observer. Existing per-consumer observers (use-board-theme.ts,
// applet-chart-impl.tsx, use-canvas-surface.ts, capture-spike.tsx) are NOT yet migrated —
// each has its own follow-on behavior (attrTick bump, canvas redraw, chart re-theme) that
// needs threading through carefully; folding them in is a tracked follow-up.

import { themeSignature } from "./resolve-token"


let current = themeSignature()
const listeners = new Set<() => void>()
let observer: MutationObserver | null = null


/** Install the single shared observer on first use. Idempotent. NOTE: `current` is
 *  refreshed ONLY here, at install — NOT on every subscribe. A pending theme mutation's
 *  observer callback is a queued microtask; if a later subscribe overwrote `current` to
 *  the new value first, that callback would see `next === current` and swallow the
 *  change (listeners never fire). So only the observer callback advances `current`. */
function ensureObserver(): void {
  if (observer || typeof document === "undefined") return
  current = themeSignature() // one-time refresh in case the theme moved since module load
  observer = new MutationObserver(() => {
    const next = themeSignature()
    if (next === current) return
    current = next
    listeners.forEach((l) => l())
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-mode"] })
}


/** The active theme signature (`data-theme:data-mode`). Stable string identity until the
 *  theme actually changes, so it's safe as a `useSyncExternalStore` snapshot. */
export function getThemeSignature(): string {
  return current
}


/** Subscribe to theme changes; returns an unsubscribe. Installs the shared observer on
 *  first call. (Never removes the observer — it's process-lifetime infrastructure.) */
export function subscribeThemeChange(cb: () => void): () => void {
  ensureObserver()
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
