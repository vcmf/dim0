// Per-note applet state persistence (applet-design.md §9.3). Local-first: state
// lives in IndexedDB, keyed by note id. Reuses the existing `miniApps` local
// store (keys are distinct node ids, so applet + legacy mini-app state never
// collide); a dedicated `applets` store is a possible follow-up.

import { getLocalStores } from "@/features/local-stores"


/** Load the saved state for an applet note, or undefined when none exists. */
export async function fetchAppletState(noteId: string): Promise<unknown> {
  return (await getLocalStores()).miniApps.getState(noteId)
}


/** Persist an applet note's state (overwrites; no history in v1). */
export async function saveAppletState(noteId: string, state: unknown): Promise<void> {
  await (await getLocalStores()).miniApps.putState(noteId, state)
}
