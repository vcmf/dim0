import { Conversation } from "./chat/conversation"
import { InputBar } from "./chat/input"
import { useListChats } from "../api/list-chats"
import { ChatProvider, useChat } from "../hooks/chat-context"
import { PendingPromptRunner } from "../hooks/use-pending-board-prompt"
import { useActiveChatId } from "../hooks/use-chat-messages"
import { useLocalMessagesStore } from "../store/local-messages-store"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { useMemo } from "react"
import type { Chat as ChatEntity } from "../types/chat"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { AddIcon, ChatHistoryIcon, ChatNewIcon, ClockIcon } from "@/components/icons"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import { useAppStore } from "@/store"

type ChatProps = {
  chatId?: string
  initialBoardId?: string
  className?: string
  showHistoricalChats?: boolean
  preferChatRoute?: boolean
  enableSelectionContext?: boolean
  autoCreateBoard?: boolean
  /** Run on the in-browser engine (local-first board) instead of the backend. */
  local?: boolean
  /** Synced board in browser-agent mode: back finished turns up to the server. */
  syncTranscript?: boolean
}

const formatChatDate = (value?: string) => {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "numeric"
  }).format(date)
}

const HistoryList = ({
  chats,
  activeChatId,
  onSelectChat,
  onNewChat,
  variant
}: {
  chats: ChatEntity[]
  activeChatId?: string
  onSelectChat: (chatId: string) => void
  onNewChat: () => void
  variant: "inline" | "dropdown"
}) => {
  if (variant === "dropdown") {
    return (
      <div className="absolute top-0 w-full flex justify-start px-4 py-2 sm:px-8 z-50">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="rounded-md border border-border shadow-sm bg-accent hover:bg-background transition-colors"
            >
              <ChatHistoryIcon className="size-4" strokeWidth={2} />
              <span className="sr-only">Open chat history</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72 max-h-80 overflow-y-auto scrollbar-thin">
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide flex flex-row items-center gap-0">
              <ClockIcon className="size-4 mr-2 inline-block" strokeWidth={2} />
              <span>Chat History</span>
            </div>
            <DropdownMenuItem
              onSelect={onNewChat}
              className="text-sm font-medium text-primary cursor-pointer flex flex-row items-center gap-0"
            >
              <AddIcon className="size-4 mr-2" strokeWidth={2} />
              <span>Create new chat</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {chats.length ? (
              chats.map(chat => {
                const subtitle = formatChatDate(chat.updatedAt || chat.createdAt)
                const isActive = chat.uid === activeChatId
                return (
                  <DropdownMenuItem
                    key={chat.uid}
                    onSelect={() => onSelectChat(chat.uid)}
                    className={cn(
                      "flex w-full max-w-full min-w-0 flex-col items-start gap-0.5",
                      isActive && "bg-accent/40"
                    )}
                  >
                    <span className="w-full truncate text-sm font-medium">{chat.label || "Untitled chat"}</span>
                    {
                      subtitle && (
                        <span className="w-full truncate text-xs text-muted-foreground">{subtitle}</span>
                      )
                    }
                  </DropdownMenuItem>
                )
              })
            ) : (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No chats yet.
              </div>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  }

  return (
    <div className="w-full max-w-[900px] mx-auto p-2 sm:p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium text-muted-foreground flex flex-row items-center gap-0">
          <ClockIcon className="size-4 mr-2 inline-block" strokeWidth={2} />
          <span>Chat History</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onNewChat} className="flex flex-row items-center gap-0">
          <ChatNewIcon className="size-4 mr-2" strokeWidth={2} />
          <span>New Chat</span>
        </Button>
      </div>
      {chats.length ? (
        <div className="max-h-64 overflow-y-auto scrollbar-thin flex flex-col gap-1 pr-1">
          {chats.map(chat => {
            const subtitle = formatChatDate(chat.updatedAt || chat.createdAt)
            const isActive = chat.uid === activeChatId
            return (
              <button
                key={chat.uid}
                onClick={() => onSelectChat(chat.uid)}
                className={cn(
                  "text-left rounded-md border px-3 py-2 transition-colors",
                  "hover:border-border hover:bg-accent/40",
                  isActive ? "border-border bg-accent/50" : "border-transparent bg-card/60"
                )}
              >
                <div className="text-sm font-medium truncate">{chat.label || "Untitled chat"}</div>
                {subtitle && (
                  <div className="text-xs text-muted-foreground">{subtitle}</div>
                )}
              </button>
            )
          })}
        </div>
      ) : (
        <div className="text-sm text-muted-foreground/80 rounded-md border border-dashed border-border px-4 py-6 text-center">
          No chats yet. Start a new one below.
        </div>
      )}
    </div>
  )
}

const ChatBody = ({
  initialBoardId,
  className,
  showHistoricalChats = false,
  preferChatRoute = false,
  enableSelectionContext = false,
  autoCreateBoard = false,
}: ChatProps) => {
  const { setChatId, local } = useChat()
  const userId = useAppStore(s => s.userId)
  const activeChatId = useActiveChatId()
  const selectLocalChat = useLocalMessagesStore(s => s.selectChat)
  const newLocalChat = useLocalMessagesStore(s => s.newChat)
  const localChats = useLocalMessagesStore(s => s.chats)
  const localMessages = useLocalMessagesStore(s => s.messages)
  // A local turn streams into the in-memory store and only `persist`s when done.
  // Switching/starting a chat mid-stream clears those messages, so the turn is
  // never written (and any nodes it created are orphaned) — block it while live.
  // `streaming` clears in runAgent's `finally`; a turn that never settles would
  // keep this true (bounded by the turn-cancellation follow-up).
  const localStreaming = local && localMessages.some(m => m.streaming)


  // Guard the local chat-switch handlers while a turn streams; surface why so the
  // blocked click isn't a silent no-op.
  const blockedByStream = (): boolean => {
    if (!localStreaming) return false
    toast.info("Wait for the response to finish before switching chats.")
    return true
  }
  // Backend chat list is disabled in local mode (empty userId → no fetch).
  const { data: backendChats = [] } = useListChats({ graphUid: initialBoardId, userId: local ? "" : userId })
  const navigate = useNavigate()
  const routerLocation = useRouterState({ select: (s) => s.location })

  // Local chats (ChatRecord) adapted to the shared chat-list shape.
  const chatList = useMemo<ChatEntity[]>(
    () => local
      ? localChats.map((c) => ({ id: 0, uid: c.id, label: c.label, graphUid: c.boardId, updatedAt: new Date(c.updatedAt).toISOString() }))
      : backendChats,
    [local, localChats, backendChats],
  )

  const attachedBoardId = useMemo(() => {
    const currentChat = chatList?.find(c => c.uid === activeChatId)
    return currentChat?.graphUid || initialBoardId
  }, [chatList, activeChatId, initialBoardId])

  const historicalChats = showHistoricalChats && initialBoardId
    ? chatList
    : []

  const historyVariant: "inline" | "dropdown" =
    showHistoricalChats && activeChatId ? "dropdown" : "inline"

  const chatClassName = cn(
    "absolute inset-0 h-full w-full overflow-hidden flex flex-col",
    showHistoricalChats ? "gap-4" : "items-center",
    className
  )

  const isBoardRoute = routerLocation.pathname?.startsWith("/boards/")

  const syncBoardUrl = (nextChatId?: string) => {
    if (!isBoardRoute) return
    // Stay on whatever board-family path we're on (board, sheet, code,
    // widget) — `to: "."` keeps the current pathname so an active surface
    // panel isn't closed when the chat changes. We only swap the search.
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        current_chat_id: nextChatId || undefined,
      }),
    })
  }

  const handleNewChat = () => {
    if (local) {
      if (blockedByStream()) return // don't discard the in-flight turn
      newLocalChat()
      return
    }

    setChatId(undefined)

    if (isBoardRoute) {
      syncBoardUrl(undefined)
      return
    }

    if (routerLocation.pathname?.startsWith("/chats/")) {
      void navigate({ to: "/chats" })
    }
  }

  const handleSelectChat = (id: string) => {
    if (local) {
      if (blockedByStream()) return // don't discard the in-flight turn
      void selectLocalChat(id)
      return
    }
    setChatId(id)
    syncBoardUrl(id)
  }

  return (
    <div className={chatClassName}>
      {/* Board chat sheet: pick up a home-composer prompt if the sheet was opened
          before the board finished loading (the pill that would run it is unmounted). */}
      {initialBoardId && <PendingPromptRunner boardId={initialBoardId} />}
      {showHistoricalChats && (
        <HistoryList
          chats={historicalChats}
          activeChatId={activeChatId}
          onSelectChat={handleSelectChat}
          onNewChat={handleNewChat}
          variant={historyVariant}
        />
      )}

      <div className="absolute top-4 right-4 z-50 md:hidden">
        <Button
          variant="ghost"
          size="icon"
          className="rounded-md border border-border shadow-sm bg-accent hover:bg-background transition-colors"
          onClick={handleNewChat}
          aria-label="Create new chat"
          title="Create new chat"
        >
          <ChatNewIcon className="size-4" strokeWidth={2} />
        </Button>
      </div>

      <div className={cn(
        "w-full min-h-0",
        activeChatId ? "flex-1" : "flex-none",
        showHistoricalChats ? "flex flex-col items-center" : "flex flex-col"
      )}>
        {activeChatId ? (
          <div className="w-full min-w-0 h-full p-4 overflow-auto scrollbar-thin">
            <div className="w-full h-full flex flex-col items-center justify-center">
              <div className="w-full max-w-[800px] h-full">
                <Conversation />
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <InputBar
        attachedBoardId={attachedBoardId}
        layout={showHistoricalChats ? "docked" : "floating"}
        preferChatRoute={preferChatRoute}
        enableSelectionContext={enableSelectionContext}
        autoCreateBoard={autoCreateBoard}
      />
    </div>
  )
}

/**
 * Chat view component
 */
export const Chat = (props: ChatProps) => {
  const { chatId, local = false, syncTranscript = false } = props

  return (
    <ChatProvider initialChatId={chatId} local={local} syncTranscript={syncTranscript}>
      <ChatBody {...props} />
    </ChatProvider>
  )
}
