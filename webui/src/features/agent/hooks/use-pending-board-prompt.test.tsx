// Tests for the home-composer → board prompt hand-off. The hook is mounted with
// vanilla react-dom under `act` (repo pattern, no @testing-library/react); the
// chat context, submit, canvas ref and model gate are mocked via hoisted state,
// while the pending-prompt / board-app / local-messages stores are the real ones.

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"


const state = vi.hoisted(() => ({
  local: true,
  hasStore: true,
  hasModel: true,
  submit: vi.fn<(text: string, opts?: unknown) => Promise<void>>(async () => {}),
}))

vi.mock("./chat-context", () => ({ useChat: () => ({ local: state.local }) }))
vi.mock("./use-chat-submit", () => ({ useChatSubmit: () => state.submit }))
vi.mock("@/features/board/harness/canvas-store-ref", () => ({
  getCanvasStoreRef: () => (state.hasStore ? {} : null),
}))
vi.mock("@/features/agent/services/use-agent-availability", () => ({
  useHasUsableModel: () => state.hasModel,
}))


import { useBoardAppStore } from "@/features/board/harness/store/board-app-store"
import { useLocalMessagesStore } from "../store/local-messages-store"
import { usePendingPromptStore } from "../store/pending-prompt-store"
import { canRunPendingPrompt, usePendingBoardPrompt, type PendingPromptReadiness } from "./use-pending-board-prompt"


const READY: PendingPromptReadiness = {
  boardId: "b1",
  local: true,
  scopeBoardId: "b1",
  boardRole: "owner",
  isLoading: false,
  loadedBoardId: "b1",
  hasStore: true,
  hasModel: true,
}


describe("canRunPendingPrompt", () => {
  it("is true only when every readiness input holds", () => {
    expect(canRunPendingPrompt(READY)).toBe(true)
  })

  it.each([
    ["backend engine", { local: false }],
    ["scope on another board", { scopeBoardId: "other" }],
    ["role unresolved", { boardRole: null }],
    ["still loading", { isLoading: true }],
    ["chat list not loaded", { loadedBoardId: null }],
    ["chat list of another board", { loadedBoardId: "other" }],
    ["no canvas store", { hasStore: false }],
    ["no model", { hasModel: false }],
  ])("is false when %s", (_label, patch) => {
    expect(canRunPendingPrompt({ ...READY, ...patch })).toBe(false)
  })
})


const Probe = ({ boardId }: { boardId: string }) => {
  usePendingBoardPrompt(boardId)
  return null
}


describe("usePendingBoardPrompt", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    state.local = true
    state.hasStore = true
    state.hasModel = true
    state.submit.mockClear()
    usePendingPromptStore.setState({ pending: null })
    useBoardAppStore.setState({ boardId: "b1", boardRole: null, isLoading: true })
    useLocalMessagesStore.setState({ loadedBoardId: null })
    container = document.createElement("div")
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
  })

  const mount = (boardId = "b1") => act(() => root.render(<Probe boardId={boardId} />))

  it("waits for the board to be ready, then submits exactly once", () => {
    usePendingPromptStore.getState().setPending("b1", "what is rust?")
    mount()
    expect(state.submit).not.toHaveBeenCalled()

    act(() => useBoardAppStore.setState({ boardRole: "owner", isLoading: false }))
    expect(state.submit).not.toHaveBeenCalled() // chat list still loading

    act(() => useLocalMessagesStore.setState({ loadedBoardId: "b1" }))
    expect(state.submit).toHaveBeenCalledTimes(1)
    expect(state.submit).toHaveBeenCalledWith("what is rust?", { attachedBoardId: "b1" })
    expect(usePendingPromptStore.getState().pending).toBeNull()

    // Later store churn must not re-fire.
    act(() => useBoardAppStore.setState({ isLoading: true }))
    act(() => useBoardAppStore.setState({ isLoading: false }))
    expect(state.submit).toHaveBeenCalledTimes(1)
  })

  it("does not run a prompt queued for another board", () => {
    usePendingPromptStore.getState().setPending("b2", "not mine")
    useBoardAppStore.setState({ boardRole: "owner", isLoading: false })
    useLocalMessagesStore.setState({ loadedBoardId: "b1" })
    mount("b1")
    expect(state.submit).not.toHaveBeenCalled()
    expect(usePendingPromptStore.getState().pending).toMatchObject({ boardId: "b2", text: "not mine" })
  })

  it("holds the prompt while no model is available", () => {
    state.hasModel = false
    usePendingPromptStore.getState().setPending("b1", "hello")
    useBoardAppStore.setState({ boardRole: "owner", isLoading: false })
    useLocalMessagesStore.setState({ loadedBoardId: "b1" })
    mount()
    expect(state.submit).not.toHaveBeenCalled()
    expect(usePendingPromptStore.getState().pending).not.toBeNull()
  })
})
