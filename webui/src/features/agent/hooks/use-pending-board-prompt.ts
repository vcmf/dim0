import { useEffect } from "react"
import { toast } from "sonner"
import { useBoardAppStore } from "@/features/board/harness/store/board-app-store"
import { getCanvasStoreRef } from "@/features/board/harness/canvas-store-ref"
import { useHasUsableModel } from "@/features/agent/services/use-agent-availability"
import { useLocalMessagesStore } from "../store/local-messages-store"
import { usePendingPromptStore } from "../store/pending-prompt-store"
import { useChat } from "./chat-context"
import { useChatSubmit } from "./use-chat-submit"


/** Readiness inputs for running a queued prompt on a board. */
export type PendingPromptReadiness = {
  boardId: string
  local: boolean
  scopeBoardId: string | null
  boardRole: string | null
  isLoading: boolean
  loadedBoardId: string | null
  hasStore: boolean
  hasModel: boolean
}


/**
 * Whether a queued prompt may run now: the browser engine is active, the harness
 * scope + canvas are hydrated for THIS board (role resolved, not loading), its
 * chat list has loaded (so `openBoard` can't wipe the turn), and a model exists.
 */
export const canRunPendingPrompt = (r: PendingPromptReadiness): boolean =>
  r.local &&
  r.scopeBoardId === r.boardId &&
  r.boardRole !== null &&
  !r.isLoading &&
  r.loadedBoardId === r.boardId &&
  r.hasStore &&
  r.hasModel


/**
 * Run the prompt queued by the home composer (see `usePendingPromptStore`) once
 * this board's browser-engine assistant is ready. Must be mounted inside the
 * board's ChatProvider. The take is one-shot, so it fires at most once.
 */
export const usePendingBoardPrompt = (boardId: string): void => {
  const { local } = useChat()
  const submit = useChatSubmit()
  const hasPending = usePendingPromptStore((s) => s.pending?.boardId === boardId)
  const scopeBoardId = useBoardAppStore((s) => s.boardId)
  const boardRole = useBoardAppStore((s) => s.boardRole)
  const isLoading = useBoardAppStore((s) => s.isLoading)
  const loadedBoardId = useLocalMessagesStore((s) => s.loadedBoardId)
  const hasModel = useHasUsableModel()

  useEffect(() => {
    if (!hasPending) return
    const ready = canRunPendingPrompt({
      boardId,
      local,
      scopeBoardId,
      boardRole,
      isLoading,
      loadedBoardId,
      hasStore: getCanvasStoreRef() !== null,
      hasModel,
    })
    if (!ready) return
    const text = usePendingPromptStore.getState().takePending(boardId)
    if (!text) return
    void submit(text, { attachedBoardId: boardId }).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : "Could not send message.")
    })
  }, [hasPending, boardId, local, scopeBoardId, boardRole, isLoading, loadedBoardId, hasModel, submit])
}
