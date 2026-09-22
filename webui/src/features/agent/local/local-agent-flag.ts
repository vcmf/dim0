/**
 * Run the in-browser agent engine on SYNCED boards too, not just local-only
 * ones. When on, a synced board's chat uses the browser engine (edits ride the
 * v2 relay to peers; transcript backs up to the server) instead of the legacy
 * server agent — the same runtime local boards already use, so applets, the
 * board-vision context, and the full browser toolset work on synced boards.
 *
 * ON by default (graduated from the opt-in soak). Opt OUT from the dev console:
 * `dim0LocalAgent.off()` then reload.
 */
const KEY = "dim0_local_agent_on_synced"


/** Whether synced-board chat should run on the browser engine. */
export const isLocalAgentOnSynced = (): boolean => {
  try {
    // Default ON — only an explicit opt-out ("0", set by `dim0LocalAgent.off()`)
    // routes a synced board back to the legacy server agent.
    return localStorage.getItem(KEY) !== "0"
  } catch {
    return true
  }
}


/**
 * Whether the browser agent is the active engine for a given board — true on
 * local-only boards (`local`) OR on synced boards in browser-agent mode. The one
 * predicate that gates browser-agent-only infra (local search / doc indexes), so
 * callers don't re-derive `local || isLocalAgentOnSynced()` and drift apart.
 */
export const isBrowserAgentActive = (local: boolean): boolean => local || isLocalAgentOnSynced()


const set = (on: boolean): void => {
  try {
    if (on) localStorage.removeItem(KEY) // clear the opt-out → back to the default (on)
    else localStorage.setItem(KEY, "0")  // explicit opt-out → legacy server agent
  } catch {
    // ignore — private mode / storage disabled just means the choice doesn't stick
  }
}


// Dev console bridge.
if (typeof window !== "undefined") {
  ;(window as unknown as { dim0LocalAgent?: unknown }).dim0LocalAgent = {
    on: () => set(true),
    off: () => set(false),
    enabled: () => isLocalAgentOnSynced(),
  }
}
