// Shared hydration hook for an applet's persisted live state (applet-design.md
// §5.4). Both the on-canvas node view and the inspect surface need to load saved
// state before mounting the renderer (so it inits with saved values instead of
// flashing defaults then re-mounting), so the async-load logic lives here once.

import { useEffect, useState } from "react"

import type { JsonValue } from "../tree"
import { fetchAppletState } from "./state-client"


export interface AppletInitialState {
  /** Persisted state to hydrate over the applet's declared defaults, or undefined. */
  initialState: Record<string, JsonValue> | undefined
  /** False until the fetch settles — gate the renderer on this to avoid a flash. */
  stateLoaded: boolean
}


/**
 * Load an applet's persisted state by note id, re-hydrating when the id changes.
 * A missing/failed read resolves as "loaded with no state" so the caller always
 * renders (with declared defaults) rather than hanging on the loading placeholder.
 */
export function useAppletInitialState(noteId: string): AppletInitialState {
  const [initialState, setInitialState] = useState<Record<string, JsonValue> | undefined>(undefined)
  const [stateLoaded, setStateLoaded] = useState(false)

  useEffect(() => {
    let active = true
    // Reset for the new id so a stale value from the previous applet can't leak
    // into the loading window.
    setStateLoaded(false)
    setInitialState(undefined)
    fetchAppletState(noteId)
      .then((s) => {
        if (!active) return
        if (s && typeof s === "object") setInitialState(s as Record<string, JsonValue>)
        setStateLoaded(true)
      })
      .catch(() => {
        if (active) setStateLoaded(true)
      })
    return () => {
      active = false
    }
  }, [noteId])

  return { initialState, stateLoaded }
}
