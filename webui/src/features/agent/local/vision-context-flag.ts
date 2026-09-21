/**
 * Rollout flag — attach a screenshot of the current board viewport to the
 * agent's turn (multimodal board context) so a vision-capable model can see
 * ink, images, applets, and layout, not just the text snapshot.
 *
 * Off by default → zero effect (turns stay text-only). Toggle from the dev
 * console: `dim0Vision.on()` then reload. Graduates to a default-on rollout
 * after soak (see docs/plans/multimodal-board-context-implementation.md).
 */
const KEY = "dim0_vision_board_context"


/** Whether the board-viewport screenshot may be attached to agent turns. */
export const isVisionBoardContextEnabled = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "1"
  } catch {
    return false
  }
}


const set = (on: boolean): void => {
  try {
    if (on) localStorage.setItem(KEY, "1")
    else localStorage.removeItem(KEY)
  } catch {
    // ignore — private mode / storage disabled just means the flag doesn't stick
  }
}


// Dev console bridge.
if (typeof window !== "undefined") {
  ;(window as unknown as { dim0Vision?: unknown }).dim0Vision = {
    on: () => set(true),
    off: () => set(false),
    enabled: () => isVisionBoardContextEnabled(),
  }
}
