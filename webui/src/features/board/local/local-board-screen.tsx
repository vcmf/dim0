import { useEffect, useState } from "react"
import { Outlet, useParams, useSearch } from "@tanstack/react-router"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { ArrowExpandIcon, SparklesIcon } from "@/components/icons"
import { Chat } from "@/features/agent/components/chat-view"
import { ToolConfirmDialog } from "@/features/agent/components/chat/tool-confirm-dialog"
import { useLocalMessagesStore } from "@/features/agent/store/local-messages-store"
import { HarnessCanvas } from "@/features/board/harness/canvas"
import { NotesSearchDialog } from "@/features/board/local/notes-search-dialog"
import { useBoardAppStore } from "@/features/board/harness/store/board-app-store"
import { useHarnessSurfaceFromUrl } from "@/features/board/harness/hooks/use-surface-from-url"
import { FloatingAssistant } from "@/features/board/components/flow/floating-assistant/floating-assistant"
import { requestPersistentStorage } from "@/features/board/persist/local/persist-storage"


/**
 * Local board view — mounts the full canvas harness and the real agent UI in
 * local (no-backend) mode. The agent runs on the in-browser engine via BYOK;
 * the floating island composes turns, and the sparkles button opens the full
 * chat sheet (reused `<Chat>`: history, transcript, docked input).
 */
export function LocalBoardScreen() {
  const params = useParams({ strict: false })
  const boardId = params.boardId ?? ""
  const rootId = useSearch({
    strict: false,
    select: (s: { root_id?: string }) => s?.root_id,
  })
  const setBoardScope = useBoardAppStore((s) => s.setBoardScope)
  const openBoard = useLocalMessagesStore((s) => s.openBoard)
  const [sheetOpen, setSheetOpen] = useState(false)

  // Scope the board to the current folder layer (root_id search param); the
  // harness re-projects that layer when rootId changes.
  useEffect(() => {
    if (boardId) setBoardScope({ boardId, rootId: rootId ?? null })
  }, [boardId, rootId, setBoardScope])

  // Chats are board-scoped, not layer-scoped — open once per board.
  useEffect(() => {
    void requestPersistentStorage()
    if (boardId) void openBoard(boardId)
  }, [boardId, openBoard])

  // Sync the /local/$boardId/{sheets,code-sandbox,widgets,mini-apps}/$noteId
  // surface routes ⇄ activeNodeSurface (the panel is mounted inside the canvas).
  useHarnessSurfaceFromUrl(true)

  return (
    <div className="absolute inset-0 h-full w-full overflow-hidden bg-background">
      <div className="relative h-full w-full">
        <HarnessCanvas local />

        {/* Null-component surface child routes render here; the actual panel is
            mounted inside the canvas (NodeSurfaceHost), driven by the URL sync. */}
        <Outlet />

        {/* Off-board tool (fetch/code) confirmation. Mounted at screen level
            (not inside FloatingAssistant) so it stays present when the full
            sheet is open — otherwise a gated call from the sheet hangs the run. */}
        <ToolConfirmDialog />

        <NotesSearchDialog boardId={boardId} />

        {/* Island composes turns; hidden while the full sheet is open (parity with
            online). It grays itself and lights the key icon when no model key is set. */}
        {!sheetOpen && (
          <FloatingAssistant
            boardId={boardId}
            local
            onOpenFullSheet={() => setSheetOpen(true)}
          />
        )}

        <Sheet open={sheetOpen} onOpenChange={setSheetOpen} modal={false} disablePointerDismissal>
          <SheetContent
            side="right"
            showOverlay={false}
            showClose={false}
            className="z-[60] w-full border-l border-border/70 bg-background p-0 text-sidebar-foreground md:w-[500px] md:max-w-[92vw]"
          >
            {/* Radix Dialog primitive requires an accessible title for content. */}
            <SheetHeader className="sr-only">
              <SheetTitle>Board Assistant</SheetTitle>
            </SheetHeader>
            {/* Visible header — without it the top is flush to the sheet edge and
                there's no way to close the chat (parity with CopilotSheet). */}
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <div className="flex size-6 items-center justify-center rounded-md bg-gradient-to-br from-wiki-link to-secondary-foreground shadow-sm">
                  <SparklesIcon className="size-3.5 text-primary-foreground" weight="fill" />
                </div>
                Board Assistant
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSheetOpen(false)}
                title="Close"
                aria-label="Close"
              >
                <ArrowExpandIcon className="size-4" strokeWidth={2} />
              </Button>
            </div>
            <div className="relative flex-1 overflow-y-auto scrollbar-thin">
              {sheetOpen && (
                <Chat
                  local
                  initialBoardId={boardId}
                  className="relative"
                  showHistoricalChats
                  enableSelectionContext
                />
              )}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  )
}
