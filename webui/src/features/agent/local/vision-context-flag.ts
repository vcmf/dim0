/**
 * Rollout flag — attach a screenshot of the current board viewport to the
 * agent's turn (multimodal board context) so a vision-capable model can see
 * ink, images, applets, and layout, not just the text snapshot.
 *
 * ON by default (graduated from the opt-in soak). Still gated at the call site
 * (`shouldAttachBoardImage`) on a vision-capable model + a non-empty board, so
 * text-only models and empty boards are unaffected either way. Opt OUT from the
 * dev console: `dim0Vision.off()` then reload.
 */
const KEY = "dim0_vision_board_context"


/** Whether the board-viewport screenshot may be attached to agent turns. */
export const isVisionBoardContextEnabled = (): boolean => {
  try {
    // Default ON — only an explicit opt-out ("0", set by `dim0Vision.off()`)
    // disables it. Storage unavailable (private mode) falls through to ON.
    return localStorage.getItem(KEY) !== "0"
  } catch {
    return true
  }
}


const set = (on: boolean): void => {
  try {
    if (on) localStorage.removeItem(KEY) // clear the opt-out → back to the default (on)
    else localStorage.setItem(KEY, "0")  // explicit opt-out
  } catch {
    // ignore — private mode / storage disabled just means the choice doesn't stick
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
