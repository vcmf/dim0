import { useEffect, useMemo, useState } from "react"
import { useParams, useRouterState, useSearch, useNavigate } from "@tanstack/react-router"
import { useListChats } from "@/features/agent/api/list-chats"
import { useListBoards } from "@/features/board/api/list-boards"
import { useLocalBoards } from "@/features/board/local/use-local-boards"
import { useUpdateBoard } from "@/features/board/api/update-board"
import { useUpdateChat } from "@/features/agent/api/update-chat"
import { LabelEditor } from "./label-editor"
import { useListSubscriptions } from "@/features/newsfeed/api/list-subscriptions"
import { NewChatUrl, SheetUrl } from "@/routes"
import { ContextBoard } from "@/features/agent/components/context-board"
import { UNTITLED_LABEL } from "@/features/board/const"
import { useBoardAppStore } from "@/features/board/harness/store/board-app-store"
import { useHarnessNodeExternal } from "@/features/board/harness/store/use-harness-node-external"
import { useGetNote } from "@/features/board/api/get-note"
import { useUpdateNote } from "@/features/board/api/update-note"
import { useAppStore } from "@/store"
import type { NoteNodeData } from "@/features/board/harness/convert/note-to-node"

export const SidebarLabel = ({ mobileContextOnly = false }: { mobileContextOnly?: boolean }) => {
  const navigate = useNavigate()
  const { updateNote } = useUpdateNote()
  const userId = useAppStore(s => s.userId)

  // route params
  const chatParams  = useParams({ from: "/chats/$id", shouldThrow: false })
  const boardParams = useParams({ from: "/boards/$id", shouldThrow: false })
  const localBoardParams = useParams({ from: "/local/$boardId", shouldThrow: false })
  const sheetParams = useParams({ from: SheetUrl, shouldThrow: false })
  const subscriptionParams = useParams({ from: "/subscriptions/$id", shouldThrow: false })
  const chatId  = chatParams?.id
  const boardId = boardParams?.id
  const localBoardId = localBoardParams?.boardId
  const sheetBoardId = sheetParams?.id
  const sheetNoteId = sheetParams?.noteId
  const subscriptionId = subscriptionParams?.id

  // new-chat search (?board_id=...)
  const initialBoardId = useSearch({
    from: NewChatUrl,
    select: (s: { board_id?: string }) => s.board_id,
    shouldThrow: false,
  })

  // where are we?
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const isHome = pathname === "/"
  const isDashboard = pathname === "/boards"
  const isNewChat = pathname === "/chats"
  const isSubscriptionsRoot = pathname === "/subscriptions"
  const isSettings = pathname === "/settings"
  const isSettingsBilling = pathname === "/settings/billing"

  const active = useMemo(() => {
    if (sheetBoardId && sheetNoteId) return { view: "sheet" as const, id: sheetNoteId, boardId: sheetBoardId }
    if (boardId) return { view: "board" as const, id: boardId }
    if (localBoardId) return { view: "local-board" as const, id: localBoardId }
    if (chatId)  return { view: "chat"  as const, id: chatId }
    if (subscriptionId) return { view: "subscriptions" as const, id: subscriptionId }
    if (isHome) return { view: "home" as const, id: undefined }
    if (isNewChat) return { view: "new-chat" as const, id: undefined }
    if (isDashboard) return { view: "dashboard" as const, id: undefined }
    if (isSubscriptionsRoot) return { view: "subscriptions" as const, id: undefined }
    if (isSettings) return { view: "settings" as const, id: undefined }
    if (isSettingsBilling) return { view: "settings-billing" as const, id: undefined }
    return { view: "unknown" as const, id: undefined }
  }, [boardId, localBoardId, chatId, subscriptionId, isNewChat, isDashboard, isSubscriptionsRoot, isHome, sheetBoardId, sheetNoteId, isSettings, isSettingsBilling])

  // data
  const { data: chatList }  = useListChats({ graphUid: null, userId })
  const { data: boardList } = useListBoards(userId)
  // Local boards live in IndexedDB (name is `title`, not the remote `label`);
  // read the title for the header and rename in place on this device.
  const { boards: localBoards, renameBoard: renameLocalBoard } = useLocalBoards()
  const { data: subscriptionList } = useListSubscriptions()
  const { updateBoard } = useUpdateBoard()
  const { updateChat }  = useUpdateChat()
  const boardLabel = useBoardAppStore(state => state.boardLabel)
  const setBoardLabel = useBoardAppStore(state => state.setBoardLabel)
  // Sheet title is read from the live harness store via a module-level
  // store-ref bridge so the sidebar (rendered above the board tree)
  // sees title edits in real time. Falls back to a one-shot GET when
  // the node isn't on the current canvas (e.g. user landed directly on
  // a sheet URL without opening the board first).
  const sheetNode = useHarnessNodeExternal(sheetNoteId)
  const sheetNodeLabel = sheetNode
    ? (sheetNode.data as Partial<NoteNodeData> | undefined)?.label?.markdown
    : undefined
  const { data: fetchedSheet } = useGetNote({
    boardId: sheetBoardId,
    noteId: sheetNoteId,
    enabled: !!sheetBoardId && !!sheetNoteId && !sheetNode,
  })

  // title label only (no context local state needed)
  const [label, setLabel] = useState("")

  useEffect(() => {
    if (active.view === "board" && active.id) {
      const b = boardList?.find((x) => x.uid === active.id)
      setLabel(b?.label ?? boardLabel ?? "")
      return
    }
    if (active.view === "local-board" && active.id) {
      const b = localBoards.find((x) => x.id === active.id)
      setLabel(b?.title ?? "")
      return
    }
    if (active.view === "chat" && active.id) {
      const c = chatList?.find((x) => x.uid === active.id)
      setLabel(c?.label ?? "")
      return
    }
    if (active.view === "new-chat") {
      setLabel("New Chat")
      return
    }
    if (active.view === "subscriptions") {
      const c = subscriptionList?.find((s) => s.id === active.id)
      setLabel(c?.label.markdown ?? "Topics")
      return
    }
    if (active.view === "sheet") {
      const sheetLabel = sheetNodeLabel ?? fetchedSheet?.label?.markdown
      setLabel(sheetLabel ?? "Sheet")
      return
    }
    if (active.view === "settings") {
      setLabel("Profile")
      return
    }
    if (active.view === "settings-billing") {
      setLabel("Billing")
      return
    }
    setLabel("")
  }, [active.view, active.id, boardList, boardLabel, localBoards, chatList, subscriptionList, sheetNodeLabel, fetchedSheet])

  const handleSaveEdit = (newLabel: string) => {
    setLabel(newLabel)
    if (active.view === "board" && active.id) {
      setBoardLabel(newLabel)
      updateBoard({ boardId: active.id, graphData: { label: newLabel } })
    }
    if (active.view === "local-board" && active.id) {
      void renameLocalBoard(active.id, newLabel)
    }
    if (active.view === "chat" && active.id) {
      updateChat({ chatId: active.id, chatData: { label: newLabel } })
    }
    if (active.view === "sheet" && active.id && active.boardId) {
      updateNote({
        boardId: active.boardId,
        noteId: active.id,
        noteData: { label: { markdown: newLabel } }
      })
    }
  }

  // Single source of truth for the selected board:
  // - existing chat: chat.graphUid
  // - new chat: URL ?board_id
  const currentChat = chatId ? chatList?.find(c => c.uid === chatId) : undefined
  const selectedBoardId =
    active.view === "chat" ? currentChat?.graphUid
    : active.view === "new-chat" ? initialBoardId
    : undefined

  const selectedBoard = selectedBoardId
    ? boardList?.find(b => b.uid === selectedBoardId)
    : undefined

  // When user changes context:
  const handleChangeContext = (nextBoardId?: string) => {
    if (active.view === "chat" && active.id) {
      // persist to API for existing chat
      updateChat({ chatId: active.id, chatData: { graphUid: nextBoardId } })
    } else if (active.view === "new-chat") {
      // persist to URL for new chat (no local state)
      navigate({
        to: NewChatUrl,
        // keep any other search keys you might have
        search: (prev: { board_id?: string; [k: string]: unknown }) =>
          nextBoardId ? { ...prev, board_id: nextBoardId } : { ...prev, board_id: undefined },
        replace: true,
      })
    }
  }

  // navigation helpers for clickable prefix
  const goBoard = (id: string) => navigate({ to: "/boards/$id", params: { id } })
  const goSubscriptionsRoot = () => navigate({ to: "/subscriptions" })

  if (mobileContextOnly) {
    if (active.view !== "chat" && active.view !== "new-chat") return null
    return (
      <div className="ml-auto">
        <ContextBoard
          contextBoardId={selectedBoardId}
          boardAsContext={handleChangeContext}
        />
      </div>
    )
  }

  // UI pieces
  const wrapClass =
    "flex flex-row items-center gap-2 px-2 py-1 text-sm font-medium rounded-md backdrop-blur-md supports-[backdrop-filter]:bg-background/50 bg-transparent min-w-0 w-full"

  const crumbBtn =
    "inline-flex items-center min-w-0 truncate text-foreground/80 hover:text-foreground underline-offset-4 hover:underline"

  const sep = <span className="opacity-50">›</span>

  // HOME
  if (active.view === "home")
    return <div className={wrapClass}>Home</div>

  // DASHBOARD
  if (active.view === "dashboard")
    return <div className={wrapClass}>Dashboard</div>

  if (active.view === "settings")
    return <div className={wrapClass}>Profile</div>

  if (active.view === "settings-billing")
    return <div className={wrapClass}>Billing</div>

  // SUBSCRIPTIONS
  if (active.view === "subscriptions") {
    // /subscriptions            -> Subscriptions
    // /subscriptions/$id        -> Subscriptions › Subscription Label
    return (
      <div className={`${wrapClass} flex-1 min-w-0`}>
        <button
          type="button"
          onClick={goSubscriptionsRoot}
          className={`${crumbBtn} font-medium`}
          title="Newsfeed"
        >
          Newsfeed
        </button>
        {active.id && (
          <>
            {sep}
            <span className="truncate" title={label}>{label}</span>
          </>
        )}
      </div>
    )
  }

  // BOARD + LOCAL BOARD: the canvas renders the unified BoardBreadcrumb (which is
  // the board title + folder path + rename), so the header shows nothing here to
  // avoid a duplicate title.
  if (active.view === "board" || active.view === "local-board") return null

  // SHEET (full view)
  if (active.view === "sheet" && active.id && active.boardId) {
    const boardLabel = boardList?.find(b => b.uid === active.boardId)?.label ?? UNTITLED_LABEL
    return (
      <div className={`${wrapClass} flex-1 min-w-0`}>
        <button
          type="button"
          onClick={() => goBoard(active.boardId!)}
          className={crumbBtn}
          title={boardLabel}
        >
          <span className="truncate" title={boardLabel}>{boardLabel}</span>
        </button>
        {sep}
        <LabelEditor
          key={`sheet:${active.id}`}
          initialLabel={label || "Sheet"}
          onSave={handleSaveEdit}
          className="flex-1 min-w-0"
        />
      </div>
    )
  }

  // CHAT / NEW CHAT (with optional board prefix)
  if (active.view === "chat" || active.view === "new-chat") {
    const hasBoard = !!selectedBoardId
    return (
      <div className={`${wrapClass} flex-1 min-w-0`}>
        {hasBoard && selectedBoardId && (
          <>
            <button
              type="button"
              onClick={() => goBoard(selectedBoardId)}
              className={crumbBtn}
              title={selectedBoard?.label ?? UNTITLED_LABEL}
            >
              <span className="truncate" title={selectedBoard?.label ?? UNTITLED_LABEL}>{selectedBoard?.label ?? UNTITLED_LABEL}</span>
            </button>
            {sep}
          </>
        )}

        <div className="min-w-0 flex-1">
          {
            active.view === "chat" ? (
              <LabelEditor
                key={`${active.view}:${active.id ?? "none"}`}
                initialLabel={label}
                onSave={handleSaveEdit}
                className='flex-1 min-w-0'
              />
            ) : (
              <span className={`${crumbBtn} mr-2`} title={label}>
                {label}
              </span>
            )
          }
        </div>

        {(active.view === "chat" || active.view === "new-chat") && (
          <ContextBoard
            contextBoardId={selectedBoardId}
            boardAsContext={handleChangeContext}
          />
        )}
      </div>
    )
  }

  return null
}
