import { create } from "zustand"
import type { ChatMessage, LocalChat } from "@/features/agent/types/chat"
import { listLocalChats, loadMessages, saveMessages } from "./chat-persist"


type LocalMessagesState = {
  boardId: string | null
  /** The board whose chat list has finished loading (null while `openBoard` is in flight). */
  loadedBoardId: string | null
  /** Current chat. Null means a fresh, not-yet-persisted chat. */
  chatUid: string | null
  messages: ChatMessage[]
  /** The board's chats, most-recent first (drives the history list). */
  chats: LocalChat[]
  /** Open a board: load its chat list and select the most recent (or a fresh chat). */
  openBoard: (boardId: string) => Promise<void>
  /** Switch to an existing chat and load its transcript. */
  selectChat: (chatUid: string) => Promise<void>
  /** Start a fresh, empty chat (persisted on first message). */
  newChat: () => void
  /** Set the active chat id (used when a turn mints a new chat). */
  setChatUid: (chatUid: string) => void
  /** In-memory update (drives streaming render); call `persist` to save. */
  setMessages: (messages: ChatMessage[]) => void
  /** Write the current transcript to IndexedDB and refresh the chat list. */
  persist: (label?: string) => Promise<void>
  reset: () => void
}


/**
 * Local chat state, backed by IndexedDB (mirrors the backend's persisted
 * messages + chat list). One board has many chats; the in-memory mirror drives
 * the UI during streaming, and `persist` writes the turn so history survives
 * reloads.
 */
export const useLocalMessagesStore = create<LocalMessagesState>((set, get) => ({
  boardId: null,
  loadedBoardId: null,
  chatUid: null,
  messages: [],
  chats: [],

  openBoard: async (boardId) => {
    set({ boardId, loadedBoardId: null, chatUid: null, messages: [], chats: [] })
    try {
      const chats = await listLocalChats(boardId)
      // Guard against a newer openBoard racing this load.
      if (get().boardId !== boardId) return
      const latest = chats[0]
      if (latest) {
        const messages = await loadMessages(latest.id)
        if (get().boardId === boardId) set({ chats, chatUid: latest.id, messages, loadedBoardId: boardId })
      } else {
        set({ chats, loadedBoardId: boardId })
      }
    } catch (err) {
      // Storage failure: fall back to a fresh chat, but still mark the board
      // loaded so waiters (the queued home prompt) aren't stuck forever.
      console.error("[local-messages] openBoard failed", err)
      if (get().boardId === boardId) set({ loadedBoardId: boardId })
    }
  },

  selectChat: async (chatUid) => {
    set({ chatUid, messages: [] })
    const messages = await loadMessages(chatUid)
    if (get().chatUid === chatUid) set({ messages })
  },

  newChat: () => set({ chatUid: null, messages: [] }),

  setChatUid: (chatUid) => set({ chatUid }),

  setMessages: (messages) => set({ messages }),

  persist: async (label) => {
    const { chatUid, boardId, messages } = get()
    if (!chatUid || !boardId) return
    await saveMessages(chatUid, boardId, messages, label)
    const chats = await listLocalChats(boardId)
    if (get().boardId === boardId) set({ chats })
  },

  reset: () => set({ boardId: null, loadedBoardId: null, chatUid: null, messages: [], chats: [] }),
}))
