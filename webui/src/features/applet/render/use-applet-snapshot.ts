// Capture-orchestration hook for snapshot-first LOD: while an applet is LIVE and
// on-screen, lazily rasterize it (idle-throttled) into the shared snapshot cache so the
// canvas `getSnapshot` hook can blit it when the applet later zooms out / goes off-
// screen / is painted during motion. Re-captures only when the content hash (source +
// state + theme) changes. See docs/plans/applet-chartjs-implementation.md PR 5.

import { useEffect, useMemo, useSyncExternalStore } from "react"
import type { RefObject } from "react"

import { cancelIdle, scheduleIdle } from "@/lib/schedule-idle"

import { snapshotApplet } from "./snapshot"
import { getAppletSnapshotHash, setAppletSnapshot, snapshotKey } from "./snapshot-cache"


// --- Shared theme signal --------------------------------------------------------------
// A theme flip recolors every applet, so a snapshot taken under the old theme is stale.
// ONE module-level MutationObserver (not one per applet — hundreds of views would each
// install their own on <html>) tracks `data-theme:data-mode` and fans out to subscribers.

let currentThemeSig = readThemeSignature()
const themeListeners = new Set<() => void>()
let themeObserver: MutationObserver | null = null


/** Read `data-theme:data-mode` off <html> (empty string outside a browser). */
function readThemeSignature(): string {
  if (typeof document === "undefined") return ""
  const r = document.documentElement
  return `${r.dataset.theme ?? ""}:${r.dataset.mode ?? ""}`
}


/** Install the single shared observer on first use; refresh the cached signature in case
 *  the theme changed between module load and now. */
function ensureThemeObserver(): void {
  currentThemeSig = readThemeSignature()
  if (themeObserver || typeof document === "undefined") return
  themeObserver = new MutationObserver(() => {
    const next = readThemeSignature()
    if (next === currentThemeSig) return
    currentThemeSig = next
    themeListeners.forEach((l) => l())
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-mode"] })
}


function subscribeTheme(cb: () => void): () => void {
  ensureThemeObserver()
  themeListeners.add(cb)
  return () => {
    themeListeners.delete(cb)
  }
}


/** The active theme signature as a reactive value, backed by the shared observer. */
function useThemeSignature(): string {
  return useSyncExternalStore(subscribeTheme, () => currentThemeSig, () => "")
}
// --------------------------------------------------------------------------------------


export interface UseAppletSnapshotOptions {
  /** Node id the snapshot is cached under. */
  noteId: string
  /** The element to rasterize (the applet's rendered card box). */
  captureRef: RefObject<HTMLElement | null>
  /** The applet source (JSX text). */
  source: string
  /** The applet's current state (part of the content hash) — updated as the applet is
   *  interacted with (debounced), so the snapshot refreshes after a change settles. */
  state: unknown
  /** True only when the applet is LIVE and actually painted (mounted + in view) — a
   *  hidden/off-screen element would snapshot blank, so don't capture then. */
  active: boolean
}


/**
 * While `active`, schedule an idle snapDOM capture of `captureRef` into the snapshot
 * cache whenever the content hash (source + state + theme) differs from what's cached.
 * No-op when inactive, source-less, or already fresh. Best-effort: a failure (null) or
 * an abort (the applet went off-screen mid-capture) leaves the previous snapshot / glyph
 * in place.
 */
export function useAppletSnapshot({ noteId, captureRef, source, state, active }: UseAppletSnapshotOptions): void {
  const themeSig = useThemeSignature()
  // A string hash → stable across state-object identity churn (the effect keys on it).
  const hash = useMemo(() => snapshotKey(source, state, themeSig), [source, state, themeSig])

  useEffect(() => {
    if (!active || !source) return
    if (getAppletSnapshotHash(noteId) === hash) return // already fresh

    let cancelled = false
    const handle = scheduleIdle(() => {
      const el = captureRef.current
      if (cancelled || !el) return
      void snapshotApplet(el, { shouldCancel: () => cancelled }).then((img) => {
        // Re-check the hash: state/theme may have moved on while we were rasterizing.
        if (cancelled || !img || getAppletSnapshotHash(noteId) === hash) return
        setAppletSnapshot(noteId, img, hash)
      })
    })
    return () => {
      cancelled = true // aborts an in-flight capture's readiness poll + raster
      cancelIdle(handle)
    }
  }, [noteId, source, hash, active, captureRef])
}
