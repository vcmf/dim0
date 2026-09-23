import { create } from "zustand"


type PendingPrompt = {
  boardId: string
  text: string
}


type PendingPromptState = {
  pending: PendingPrompt | null
  /** Queue a prompt to run once the given board's assistant is ready. */
  setPending: (boardId: string, text: string) => void
  /**
   * Return and clear the queued prompt if it targets `boardId`; otherwise leave it
   * untouched and return null. One-shot, so a prompt can never run twice.
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

  setPending: (boardId, text) => set({ pending: { boardId, text } }),

  takePending: (boardId) => {
    const { pending } = get()
    if (!pending || pending.boardId !== boardId) return null
    set({ pending: null })
    return pending.text
  },
}))
