// Capture-orchestration hook for snapshot-first LOD: while an applet is LIVE and
// on-screen, lazily rasterize it (idle-throttled) into the shared snapshot cache so the
// canvas `getSnapshot` hook can blit it when the applet later zooms out / goes off-
// screen / is painted during motion. Re-captures only when the content hash (source +
// persisted state + theme) changes. See docs/plans/applet-chartjs-implementation.md PR 5.

import { useEffect, useMemo, useRef, useState } from "react"
import type { RefObject } from "react"

import { cancelIdle, scheduleIdle } from "@/lib/schedule-idle"

import { snapshotApplet } from "./snapshot"
import { getAppletSnapshotHash, setAppletSnapshot, snapshotKey } from "./snapshot-cache"


/** The active theme signature (`data-theme:data-mode` on <html>) as a reactive value —
 *  a theme flip recolors the applet, so its snapshot must be re-captured. Subscribes via
 *  a MutationObserver on those attributes (how the app themes). */
function useThemeSignature(): string {
  const [sig, setSig] = useState(() => readThemeSignature())
  useEffect(() => {
    if (typeof document === "undefined") return
    const root = document.documentElement
    const update = () => setSig(readThemeSignature())
    const obs = new MutationObserver(update)
    obs.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-mode"] })
    update() // catch a change between first render and effect
    return () => obs.disconnect()
  }, [])
  return sig
}


/** Read `data-theme:data-mode` off <html> (empty string outside a browser). */
function readThemeSignature(): string {
  if (typeof document === "undefined") return ""
  const r = document.documentElement
  return `${r.dataset.theme ?? ""}:${r.dataset.mode ?? ""}`
}


export interface UseAppletSnapshotOptions {
  /** Node id the snapshot is cached under. */
  noteId: string
  /** The element to rasterize (the applet's rendered card box). */
  captureRef: RefObject<HTMLElement | null>
  /** The applet source (JSX text). */
  source: string
  /** The persisted state the applet mounted with (part of the content hash). */
  state: unknown
  /** True only when the applet is LIVE and actually painted (mounted + in view) — a
   *  hidden/off-screen element would snapshot blank, so don't capture then. */
  active: boolean
}


/**
 * While `active`, schedule an idle snapDOM capture of `captureRef` into the snapshot
 * cache whenever the content hash (source + state + theme) differs from what's cached.
 * No-op when inactive, source-less, or already fresh. The capture is best-effort: a
 * failure (returns null) simply leaves the previous snapshot / glyph in place.
 */
export function useAppletSnapshot({ noteId, captureRef, source, state, active }: UseAppletSnapshotOptions): void {
  const themeSig = useThemeSignature()
  // A string hash → stable across state-object identity churn (the effect keys on it).
  const hash = useMemo(() => snapshotKey(source, state, themeSig), [source, state, themeSig])
  const captureRefRef = useRef(captureRef)
  captureRefRef.current = captureRef

  useEffect(() => {
    if (!active || !source) return
    if (getAppletSnapshotHash(noteId) === hash) return // already fresh

    let cancelled = false
    const handle = scheduleIdle(() => {
      const el = captureRefRef.current.current
      if (cancelled || !el) return
      void snapshotApplet(el).then((img) => {
        // Re-check the hash: state/theme may have moved on while we were rasterizing.
        if (cancelled || !img || getAppletSnapshotHash(noteId) === hash) return
        setAppletSnapshot(noteId, img, hash)
      })
    })
    return () => {
      cancelled = true
      cancelIdle(handle)
    }
  }, [noteId, source, hash, active])
}
