import { ChatProvider } from "@/features/agent/hooks/chat-context"
import { useBrowserAgentActive } from "@/features/board/harness/canvas/use-sync-engine"
import { AnswerCard } from "./answer-card"
import { FloatingIsland } from "./floating-island"


export interface FloatingAssistantProps {
  boardId: string
  currentChatId?: string
  onOpenFullSheet: () => void
  /** Run on the in-browser engine (local-first board) instead of the backend. */
  local?: boolean
}


/**
 * Ambient board assistant: a composer pill at the bottom of the canvas, an
 * adaptive progress strip, and a right-side answer card that surfaces text
 * replies. Shares the chat session with the full CopilotSheet via the
 * `current_chat_id` search param. On a local board it runs the frontend
 * engine; chat is then scoped to the board itself.
 */
export const FloatingAssistant = ({
  boardId,
  currentChatId,
  onOpenFullSheet,
  local = false,
}: FloatingAssistantProps) => {
  // Phase 3 (flag-gated): run the browser engine on a synced board too, unless its
  // sync engine is a resolved `legacy` pin — that board keeps the backend agent
  // (its relay has no DB persistence). The chat then goes fully local-mode (browser
  // engine + local transcript store), and its edits ride the v2 relay to peers with
  // no server agent. Off / resolved-legacy → the backend agent instead.
  const browserAgent = useBrowserAgentActive(boardId, local)
  // Phase 2: a SYNCED board in browser-agent mode backs up transcripts to the
  // server (cross-device). A local-only board (`local`) has nothing to sync to.
  const syncTranscript = browserAgent && !local

  // The local store is initialized at the screen level (BoardView for synced
  // boards, LocalBoardScreen for local ones) so the pill and drawer — which
  // never mount together — share one conversation. This surface just consumes it.

  return (
    <ChatProvider
      initialChatId={browserAgent ? boardId : currentChatId}
      local={browserAgent}
      syncTranscript={syncTranscript}
    >
      <FloatingIsland boardId={boardId} onOpenFullSheet={onOpenFullSheet} />
      <AnswerCard onOpenFullSheet={onOpenFullSheet} />
    </ChatProvider>
  )
}
