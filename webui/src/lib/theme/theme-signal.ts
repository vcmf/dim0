// A single shared source of truth for "the theme just changed" — one module-level
// MutationObserver on <html>'s data-theme/data-mode, fanned out to subscribers.
//
// Several canvas consumers need to react to a theme flip (re-resolve colors, invalidate
// a baked-in snapshot). Each installing its OWN observer on <html> means hundreds of
// observers on a big board and the attribute list copy-pasted everywhere; this owns it
// once. The signature format itself is the canonical `themeSignature()` from
// resolve-token.ts, so there's a single reader too.

import { themeSignature } from "./resolve-token"


let current = themeSignature()
const listeners = new Set<() => void>()
let observer: MutationObserver | null = null


/** Install the single shared observer on first use; refresh the cached signature in case
 *  the theme changed between module load and now. Idempotent. */
function ensureObserver(): void {
  current = themeSignature()
  if (observer || typeof document === "undefined") return
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
