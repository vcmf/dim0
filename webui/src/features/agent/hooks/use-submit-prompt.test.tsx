// Tests for the home composer's auto-create-board branch of useSubmitPrompt:
// with the browser agent on synced boards (default), the prompt is queued for
// the new board instead of being sent to the server agent (whose turn the
// board's browser-agent UI would never show). Mounted via react-dom under `act`.

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"


const state = vi.hoisted(() => ({
  browserAgentOnSynced: true,
  navigate: vi.fn(),
  createBoardAsync: vi.fn(async () => "new-board"),
  createChatAsync: vi.fn<(args: unknown) => Promise<void>>(async () => {}),
  updateChatAsync: vi.fn<(args: unknown) => Promise<void>>(async () => {}),
  sendMessageAsync: vi.fn<(args: unknown) => Promise<void>>(async () => {}),
  describeChatAsync: vi.fn<(args: unknown) => Promise<void>>(async () => {}),
  describeBoardAsync: vi.fn<(args: unknown) => Promise<void>>(async () => {}),
}))

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useParams: () => undefined,
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/" } }),
}))
vi.mock("@/routes", () => ({ ChatUrl: "/chats/$id" }))
vi.mock("@/store", () => ({
  useAppStore: (sel: (s: { userId: string }) => unknown) => sel({ userId: "u1" }),
}))
vi.mock("./chat-context", () => ({ useChat: () => ({ chatId: undefined, setChatId: vi.fn() }) }))
vi.mock("../api/create-chat", () => ({ useCreateChat: () => ({ createChatAsync: state.createChatAsync }) }))
vi.mock("../api/update-chat", () => ({ useUpdateChat: () => ({ updateChatAsync: state.updateChatAsync }) }))
vi.mock("../api/send-message", () => ({ useSendMessage: () => ({ sendMessageAsync: state.sendMessageAsync }) }))
vi.mock("../api/describe-chat", () => ({ useDescribeChat: () => ({ describeChatAsync: state.describeChatAsync }) }))
vi.mock("@/features/board/api/create-board", () => ({
  useCreateBoard: () => ({ createBoardAsync: state.createBoardAsync }),
}))
vi.mock("@/features/board/api/describe-board", () => ({
  useDescribeBoard: () => ({ describeBoardAsync: state.describeBoardAsync }),
}))
vi.mock("../local/local-agent-flag", () => ({ isLocalAgentOnSynced: () => state.browserAgentOnSynced }))


import { usePendingPromptStore } from "../store/pending-prompt-store"
import { useSubmitPrompt } from "./use-submit-prompt"


type Submit = ReturnType<typeof useSubmitPrompt>


describe("useSubmitPrompt autoCreateBoard", () => {
  let container: HTMLDivElement
  let root: Root
  let submit: Submit | null = null

  const Probe = () => {
    submit = useSubmitPrompt()
    return null
  }

  beforeEach(() => {
    state.browserAgentOnSynced = true
    for (const fn of [
      state.navigate, state.createBoardAsync, state.createChatAsync, state.updateChatAsync,
      state.sendMessageAsync, state.describeChatAsync, state.describeBoardAsync,
    ]) fn.mockClear()
    usePendingPromptStore.setState({ pending: null })
    container = document.createElement("div")
    root = createRoot(container)
    act(() => root.render(<Probe />))
  })

  afterEach(() => {
    act(() => root.unmount())
  })

  it("queues the prompt for the new board and skips the server agent", async () => {
    await act(async () => {
      await submit!("  what is rust?  ", { autoCreateBoard: true })
    })
    expect(state.createBoardAsync).toHaveBeenCalledTimes(1)
    expect(usePendingPromptStore.getState().pending).toEqual({ boardId: "new-board", text: "what is rust?" })
    expect(state.navigate).toHaveBeenCalledWith({ to: "/boards/$id", params: { id: "new-board" } })
    expect(state.createChatAsync).not.toHaveBeenCalled()
    expect(state.sendMessageAsync).not.toHaveBeenCalled()
  })

  it("keeps the server-agent flow when the browser agent is opted out", async () => {
    state.browserAgentOnSynced = false
    await act(async () => {
      await submit!("what is rust?", { autoCreateBoard: true })
    })
    expect(usePendingPromptStore.getState().pending).toBeNull()
    expect(state.createChatAsync).toHaveBeenCalledTimes(1)
    expect(state.sendMessageAsync).toHaveBeenCalledTimes(1)
  })

  it("propagates a board-creation failure (e.g. the plan limit) without queuing", async () => {
    state.createBoardAsync.mockRejectedValueOnce(new Error("board_limit_reached"))
    await act(async () => {
      await expect(submit!("what is rust?", { autoCreateBoard: true })).rejects.toThrow("board_limit_reached")
    })
    expect(usePendingPromptStore.getState().pending).toBeNull()
    expect(state.navigate).not.toHaveBeenCalled()
  })
})
