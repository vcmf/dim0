import { useEffect } from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { seedTranscriptsFromServer } from "@/features/agent/local/seed-transcripts"
import { useLocalMessagesStore } from "@/features/agent/store/local-messages-store"
import { ToolConfirmDialog } from "@/features/agent/components/chat/tool-confirm-dialog"
import { HarnessCanvas } from "../harness/canvas"
import { useBrowserAgentActive } from "../harness/canvas/use-sync-engine"
import { useBoardAppStore } from "../harness/store/board-app-store"
import { FloatingAssistant } from "./flow/floating-assistant/floating-assistant"
import { CopilotSheet } from "./flow/copilot-sheet"


/**
 * Board entry-point. Mounts the canvas-harness board surface, the
 * floating-island AI composer at the bottom of the canvas, and the
 * full chat sheet drawer. Scope (boardId / rootId) is set on the
 * board-app-store by `BoardScreen`; this component reads from there.
 */
export const BoardView: React.FC = () => {
  const navigate = useNavigate()
  const boardId = useBoardAppStore((s) => s.boardId)
  const chatSheetOpen = useBoardAppStore((s) => s.chatSheetOpen)
  const setChatSheetOpen = useBoardAppStore((s) => s.setChatSheetOpen)
  const presentationMode = useBoardAppStore((s) => s.presentationMode)

  // Phase 3 (flag-gated): a synced board runs the browser engine unless its sync
  // engine is a resolved `legacy` pin (that relay has no DB persistence, so
  // browser-agent edits would be lost on reload). This value drives the CopilotSheet
  // drawer; the FloatingAssistant pill recomputes the SAME predicate from the same
  // boardId (see useBrowserAgentActive), so both surfaces agree on the engine and
  // share one conversation without threading a prop (the pill can't take this as
  // `local` — that would suppress its transcript backup). This screen is only
  // mounted for synced boards, so `local` is always false here.
  const browserAgent = useBrowserAgentActive(boardId, false)
  const syncTranscript = browserAgent

  // Own the local-store init at the screen level (mirrors LocalBoardScreen), so
  // the store is populated regardless of which chat surface is currently mounted
  // — otherwise opening the drawer (which unmounts the pill) would show nothing.
  const openBoard = useLocalMessagesStore((s) => s.openBoard)
  useEffect(() => {
    if (!(browserAgent && boardId)) return
    let cancelled = false
    void (async () => {
      await seedTranscriptsFromServer(boardId)
      if (!cancelled) await openBoard(boardId)
    })()
    return () => {
      cancelled = true
    }
  }, [browserAgent, boardId, openBoard])

  // current_chat_id from the URL — shared between the floating island
  // and the full chat sheet so opening one continues the same chat.
  const boardSearch = useSearch({
    strict: false,
    select: (s: { current_chat_id?: string }) => ({ currentChatId: s.current_chat_id }),
  })
  const currentChatId = boardSearch?.currentChatId

  return (
    <div className="absolute inset-0 h-full w-full overflow-hidden">
      <div className="relative h-full w-full bg-background">
        <HarnessCanvas />
        {!chatSheetOpen && !presentationMode && boardId && (
          <FloatingAssistant
            boardId={boardId}
            currentChatId={currentChatId}
            onOpenFullSheet={() => setChatSheetOpen(true)}
          />
        )}
        <CopilotSheet
          open={chatSheetOpen}
          onOpenChange={setChatSheetOpen}
          boardId={boardId ?? undefined}
          currentChatId={currentChatId}
          local={browserAgent}
          syncTranscript={syncTranscript}
          onOpenFullChat={(chatId) => {
            setChatSheetOpen(false)
            if (chatId) {
              navigate({
                to: "/chats/$id",
                params: { id: chatId },
                search: (prev: Record<string, unknown>) => ({
                  ...prev,
                  board_id: boardId || undefined,
                }),
              })
            }
          }}
        />
        {/* Off-board tool gate (web search / fetch / code). Mounted at the board
            level — like LocalBoardScreen does — so it survives the pill↔drawer
            swap; without it a browser-agent turn would await a confirm that can
            never be answered and hang forever. Only the browser engine gates. */}
        {browserAgent && <ToolConfirmDialog />}
      </div>
    </div>
  )
}
