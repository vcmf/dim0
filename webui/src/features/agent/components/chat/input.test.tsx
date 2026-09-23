// Tests for the home composer at the plan's synced-board cap: submitting opens
// the same board-limit dialog as the sidebar (no board created), and "Create a
// local-only board" carries the typed prompt to the new local board. Mounted via
// react-dom under `act`; leaf components and data hooks are mocked.

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"


const state = vi.hoisted(() => ({
  limited: true,
  navigate: vi.fn(),
  submit: vi.fn<(text: string, opts?: unknown) => Promise<void>>(async () => {}),
  createLocalBoard: vi.fn<(title: string) => Promise<{ id: string }>>(async () => ({ id: "local-1" })),
}))

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }))
vi.mock("@/routes", () => ({ SettingsBillingUrl: "/settings/billing" }))
vi.mock("@/store", () => ({
  useAppStore: (sel: (s: { userPlan: string }) => unknown) => sel({ userPlan: "free" }),
}))
vi.mock("../../hooks/chat-context", () => ({ useChat: () => ({ local: false }) }))
vi.mock("../../hooks/use-chat-submit", () => ({ useChatSubmit: () => state.submit }))
vi.mock("../../hooks/use-chat-messages", () => ({
  useActiveChatId: () => undefined,
  useChatStreaming: () => false,
}))
vi.mock("../../hooks/use-message-context", () => ({ buildMessageContext: () => undefined }))
vi.mock("@/features/board/lib/board-limit", () => ({
  useIsBoardCreationLimited: () => state.limited,
  boardLimitForPlan: () => 3,
}))
vi.mock("@/features/board/local/use-local-boards", () => ({
  useLocalBoards: () => ({ createBoard: state.createLocalBoard }),
}))
vi.mock("@/features/board/components/board-limit-dialog", () => ({
  BoardLimitDialog: ({ open, onCreateLocal }: { open: boolean; onCreateLocal: () => void }) =>
    open ? <button data-testid="create-local" onClick={onCreateLocal} /> : null,
}))
vi.mock("./welcome-message", () => ({ WelcomeMessage: () => null }))
vi.mock("./starter-prompts", () => ({ StarterPromptPills: () => null }))
vi.mock("./input-settings/message-board-context", () => ({ MessageBoardContextChoiceMenu: () => null }))
vi.mock("@/features/agent/settings/settings-button", () => ({ SettingsButton: () => null }))
vi.mock("./memory-button", () => ({ MemoryButton: () => null }))
vi.mock("./send-button", () => ({
  SendButton: ({ onClick }: { onClick: () => void }) => <button data-testid="send" onClick={onClick} />,
}))


import { usePendingPromptStore } from "../../store/pending-prompt-store"
import { InputBar } from "./input"


/** Type into the composer's textarea through React's value tracker. */
const typeInto = (textarea: HTMLTextAreaElement, value: string) => {
  // Call the prototype setter with the element as receiver, bypassing React's
  // instance-level value tracker so the change event is seen as real input.
  Reflect.set(HTMLTextAreaElement.prototype, "value", value, textarea)
  textarea.dispatchEvent(new Event("input", { bubbles: true }))
}


describe("InputBar at the board limit (home composer)", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    state.limited = true
    state.navigate.mockClear()
    state.submit.mockClear()
    state.createLocalBoard.mockClear()
    usePendingPromptStore.setState({ pending: null })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root.render(<InputBar autoCreateBoard />))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const textarea = () => container.querySelector("textarea") as HTMLTextAreaElement
  const click = async (testId: string) => {
    await act(async () => {
      (container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click()
    })
  }

  it("keeps the composer usable and opens the limit dialog instead of submitting", async () => {
    expect(textarea().disabled).toBe(false)
    act(() => typeInto(textarea(), "what is rust?"))
    await click("send")
    expect(state.submit).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="create-local"]')).not.toBeNull()
    expect(textarea().value).toBe("what is rust?")
  })

  it("'Create a local-only board' queues the prompt and opens the local board", async () => {
    act(() => typeInto(textarea(), "what is rust?"))
    await click("send")
    await click("create-local")
    expect(state.createLocalBoard).toHaveBeenCalledTimes(1)
    expect(usePendingPromptStore.getState().pending).toEqual({ boardId: "local-1", text: "what is rust?" })
    expect(state.navigate).toHaveBeenCalledWith({ to: "/local/$boardId", params: { boardId: "local-1" } })
    expect(textarea().value).toBe("")
  })

  it("opens the dialog when the server rejects the create at the cap", async () => {
    state.limited = false
    act(() => root.render(<InputBar autoCreateBoard />))
    state.submit.mockRejectedValueOnce(new Error("board_limit_reached"))
    act(() => typeInto(textarea(), "what is rust?"))
    await click("send")
    expect(state.submit).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="create-local"]')).not.toBeNull()
    expect(textarea().value).toBe("what is rust?")
  })
})
