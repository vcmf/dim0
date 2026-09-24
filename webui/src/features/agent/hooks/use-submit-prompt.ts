import { useCallback } from "react"
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router"
import { useAppStore } from "@/store"
import { useChatStore } from "../store/chat-store"
import { useBoardAppStore } from "@/features/board/harness/store/board-app-store"
import { useChat } from "./chat-context"
import { useCreateChat } from "../api/create-chat"
import { useUpdateChat } from "../api/update-chat"
import { useSendMessage } from "../api/send-message"
import { useDescribeChat } from "../api/describe-chat"
import { useCreateBoard } from "@/features/board/api/create-board"
import { useDescribeBoard } from "@/features/board/api/describe-board"
import { isLocalAgentOnSynced } from "../local/local-agent-flag"
import { usePendingPromptStore } from "../store/pending-prompt-store"
import { ChatUrl } from "@/routes"
import { generateUuid, trimText } from "@/lib/common"
import type { SendMessageRequestPayload } from "../api/types"


type SubmitOptions = {
  forceNewChat?: boolean
  attachedBoardId?: string
  preferChatRoute?: boolean
  messageContext?: string
  /**
   * If set, a new board is created before the chat and the user is taken to it.
   * Used by the home composer where every prompt starts a fresh board.
   * Ignored when `attachedBoardId` is already set or an existing chat is being continued.
   */
  autoCreateBoard?: boolean
}


/**
 * Handles creating/naming a chat on first message, navigating to the right route,
 * and dispatching the send-message stream. Errors bubble up for callers to surface.
 */
export const useSubmitPrompt = () => {
  const { chatId, setChatId } = useChat()
  const userId = useAppStore((s) => s.userId)
  const llmModel = useChatStore((s) => s.llmModel)
  const webSearchEngine = useChatStore((s) => s.webSearchEngine)
  const enabledTools = useChatStore((s) => s.enabledTools)
  const useDeepResearch = useChatStore((s) => s.useDeepResearch)
  const setUseDeepResearch = useChatStore((s) => s.setUseDeepResearch)
  const rootId = useBoardAppStore((s) => s.rootId) ?? undefined
  const setPendingPrompt = usePendingPromptStore((s) => s.setPending)

  const { createChatAsync } = useCreateChat()
  const { updateChatAsync } = useUpdateChat()
  const { sendMessageAsync } = useSendMessage()
  const { describeChatAsync } = useDescribeChat()
  const { createBoardAsync } = useCreateBoard()
  const { describeBoardAsync } = useDescribeBoard()

  const navigate = useNavigate()
  const routerLocation = useRouterState({ select: (s) => s.location })
  const boardParams = useParams({ from: "/boards/$id", shouldThrow: false })
  const isBoardRoute = routerLocation.pathname?.startsWith("/boards/")
  const boardRouteId = boardParams?.id

  return useCallback(
    async (text: string, options: SubmitOptions = {}): Promise<void> => {
      const {
        forceNewChat = false,
        attachedBoardId,
        preferChatRoute = false,
        messageContext,
        autoCreateBoard = false,
      } = options

      const trimmed = text.trim()
      if (!trimmed) return

      const createNewChat = forceNewChat || !chatId

      // When the home composer submits, spin up a fresh board first so the new
      // chat lives inside it. Skipped if a board is already attached or we're
      // continuing an existing chat. Creation errors (incl. BOARD_LIMIT_REACHED)
      // propagate so the composer can open the limit dialog.
      let createdBoardId: string | undefined
      if (autoCreateBoard && createNewChat && !attachedBoardId && !boardRouteId) {
        createdBoardId = await createBoardAsync()

        // Synced boards run the browser agent, which only renders its own local
        // transcript — a server-agent turn started here would be invisible there.
        // So hand the prompt to the board's assistant instead of sending it.
        if (isLocalAgentOnSynced()) {
          setUseDeepResearch(false) // backend-only; not available on the browser engine
          setPendingPrompt(createdBoardId, trimmed)
          void navigate({ to: "/boards/$id", params: { id: createdBoardId } })
          return
        }
      }

      const settingsBoardId = createdBoardId ?? attachedBoardId ?? boardRouteId
      let id: string

      if (createNewChat) {
        const newChatId = generateUuid()
        await createChatAsync({ userId, boardId: settingsBoardId, chatId: newChatId })
        void updateChatAsync({ chatId: newChatId, chatData: { label: trimText(trimmed, 20) } }).catch(() => {})

        if (!preferChatRoute && (isBoardRoute || createdBoardId) && settingsBoardId) {
          if (createdBoardId) {
            // A brand-new board was just created — go to it.
            void navigate({
              to: "/boards/$id",
              params: { id: settingsBoardId },
              search: (prev: Record<string, unknown>) => ({
                ...prev,
                current_chat_id: newChatId,
              }),
            })
          } else {
            // Already on a board-family route (board / sheet / code /
            // widget). `to: "."` keeps the current pathname so we don't
            // close any active surface panel just because the user sent
            // their first message in a new chat.
            void navigate({
              to: ".",
              search: (prev: Record<string, unknown>) => ({
                ...prev,
                current_chat_id: newChatId,
              }),
            })
          }
        } else {
          void navigate({ to: ChatUrl, params: { id: newChatId } })
        }

        setChatId(newChatId)
        id = newChatId
      } else {
        id = chatId!
      }

      const payload: SendMessageRequestPayload = {
        query: trimmed,
        messageId: generateUuid(),
        rootId,
        model: llmModel,
        webSearchEngine,
        enabledTools,
        useDeepResearch,
        messageContext,
      }

      setUseDeepResearch(false)

      await sendMessageAsync({ payload, userId, chatId: id })

      if (createNewChat) {
        void describeChatAsync({ chatId: id, userId }).catch(() => {})
        if (settingsBoardId) {
          void describeBoardAsync({ boardId: settingsBoardId, chatId: id }).catch(() => {})
        }
      }
    },
    [
      chatId,
      setChatId,
      userId,
      llmModel,
      webSearchEngine,
      enabledTools,
      useDeepResearch,
      setUseDeepResearch,
      rootId,
      boardRouteId,
      isBoardRoute,
      createChatAsync,
      updateChatAsync,
      sendMessageAsync,
      describeChatAsync,
      createBoardAsync,
      describeBoardAsync,
      setPendingPrompt,
      navigate,
    ]
  )
}
