// Capture-orchestration hook for snapshot-first LOD: while an applet is LIVE and
// on-screen, lazily rasterize it (idle-throttled) into the shared snapshot cache so the
// canvas `getSnapshot` hook can blit it when the applet later zooms out / goes off-
// screen / is painted during motion. Re-captures only when the content hash (source +
// state + theme) changes. See docs/plans/applet-chartjs-implementation.md PR 5.

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import type { RefObject } from "react"

import { cancelIdle, scheduleIdle } from "@/lib/schedule-idle"
import { getThemeSignature, subscribeThemeChange } from "@/lib/theme/theme-signal"

import { withCaptureSlot } from "./capture-scheduler"
import { getAppletSnapshotHash, setAppletSnapshot, snapshotKey } from "./snapshot-cache"
// snapshotApplet (→ @zumer/snapdom, ~50 KB) is dynamic-imported at capture time so it
// stays out of the eager board bundle (the board imports this hook via the applet view).


/** The active theme signature as a reactive value — a theme flip recolors the applet, so
 *  its snapshot must be re-captured. Backed by the shared, single-observer theme signal. */
function useThemeSignature(): string {
  return useSyncExternalStore(subscribeThemeChange, getThemeSignature, () => "")
}


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
  /** Whether the node still exists — checked right before writing, so a capture that
   *  resolves after the node was deleted can't re-insert an orphan into the cache. */
  isAlive: () => boolean
}


/**
 * While `active`, schedule an idle snapDOM capture of `captureRef` into the snapshot
 * cache whenever the content hash (source + state + theme) differs from what's cached.
 * No-op when inactive, source-less, or already fresh. Best-effort: a failure (null) or
 * an abort (the applet went off-screen mid-capture) leaves the previous snapshot / glyph
 * in place.
 */
export function useAppletSnapshot({ noteId, captureRef, source, state, active, isAlive }: UseAppletSnapshotOptions): void {
  const themeSig = useThemeSignature()
  // A string hash → stable across state-object identity churn (the effect keys on it).
  const hash = useMemo(() => snapshotKey(source, state, themeSig), [source, state, themeSig])
  const isAliveRef = useRef(isAlive)
  isAliveRef.current = isAlive

  useEffect(() => {
    if (!active || !source) return
    if (getAppletSnapshotHash(noteId) === hash) return // already fresh

    let cancelled = false
    const handle = scheduleIdle(() => {
      const el = captureRef.current
      if (cancelled || !el) return
      // Through the shared gate so a settle over many visible applets doesn't burst
      // snapDOM all at once (WebKit is single-threaded).
      void withCaptureSlot(async () => {
        if (cancelled) return
        const { snapshotApplet } = await import("./snapshot") // lazy: keeps snapDOM off the eager path
        if (cancelled) return
        const img = await snapshotApplet(el, { shouldCancel: () => cancelled })
        // Re-check before writing: the hash may have moved on while rasterizing, and the
        // node may have been DELETED (its evict ran before this effect's cleanup) — don't
        // resurrect an orphan snapshot for a node that no longer exists.
        if (cancelled || !img || !isAliveRef.current() || getAppletSnapshotHash(noteId) === hash) return
        setAppletSnapshot(noteId, img, hash)
      })
    })
    return () => {
      cancelled = true // aborts an in-flight capture's readiness poll + raster
      cancelIdle(handle)
    }
  }, [noteId, source, hash, active, captureRef])
}
