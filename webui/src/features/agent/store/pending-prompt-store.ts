import { create } from "zustand"


type PendingPrompt = {
  boardId: string
  text: string
  /** `Date.now()` at queue time; a prompt older than PENDING_PROMPT_TTL_MS is dropped. */
  queuedAt: number
}


/**
 * How long a queued prompt stays runnable. Covers the navigate → hydrate window
 * with margin; past it, the user has moved on and running it would be a surprise.
 */
export const PENDING_PROMPT_TTL_MS = 60_000


type PendingPromptState = {
  pending: PendingPrompt | null
  /** Queue a prompt to run once the given board's assistant is ready. */
  setPending: (boardId: string, text: string) => void
  /**
   * Return and clear the queued prompt if it targets `boardId` and hasn't expired;
   * a different board's prompt is left untouched, an expired one is cleared.
   * One-shot, so a prompt can never run twice.
   */
  takePending: (boardId: string) => string | null
}


/**
 * In-memory hand-off from the home composer to a freshly created board: the home
 * page creates the board and queues the prompt here, then the board's assistant
 * picks it up once mounted and runs it on the browser engine. Deliberately not in
 * the URL, so a reload / back-nav / shared link never re-runs the agent.
 */
export const usePendingPromptStore = create<PendingPromptState>((set, get) => ({
  pending: null,

  setPending: (boardId, text) => set({ pending: { boardId, text, queuedAt: Date.now() } }),

  takePending: (boardId) => {
    const { pending } = get()
    if (!pending || pending.boardId !== boardId) return null
    set({ pending: null })
    return Date.now() - pending.queuedAt <= PENDING_PROMPT_TTL_MS ? pending.text : null
  },
}))
