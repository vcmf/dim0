import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PENDING_PROMPT_TTL_MS, usePendingPromptStore } from "./pending-prompt-store"


describe("usePendingPromptStore", () => {
  beforeEach(() => usePendingPromptStore.setState({ pending: null }))

  it("returns the queued prompt once, then clears it", () => {
    usePendingPromptStore.getState().setPending("b1", "hello")
    expect(usePendingPromptStore.getState().takePending("b1")).toBe("hello")
    expect(usePendingPromptStore.getState().takePending("b1")).toBeNull()
    expect(usePendingPromptStore.getState().pending).toBeNull()
  })

  it("ignores a take for a different board and keeps the prompt queued", () => {
    usePendingPromptStore.getState().setPending("b1", "hello")
    expect(usePendingPromptStore.getState().takePending("b2")).toBeNull()
    expect(usePendingPromptStore.getState().pending).toMatchObject({ boardId: "b1", text: "hello" })
  })

  it("a newer prompt replaces the queued one", () => {
    usePendingPromptStore.getState().setPending("b1", "first")
    usePendingPromptStore.getState().setPending("b2", "second")
    expect(usePendingPromptStore.getState().takePending("b1")).toBeNull()
    expect(usePendingPromptStore.getState().takePending("b2")).toBe("second")
  })
})


describe("usePendingPromptStore expiry", () => {
  beforeEach(() => usePendingPromptStore.setState({ pending: null }))
  afterEach(() => vi.useRealTimers())

  it("drops (and clears) a prompt older than the TTL", () => {
    vi.useFakeTimers()
    usePendingPromptStore.getState().setPending("b1", "stale")
    vi.advanceTimersByTime(PENDING_PROMPT_TTL_MS + 1)
    expect(usePendingPromptStore.getState().takePending("b1")).toBeNull()
    expect(usePendingPromptStore.getState().pending).toBeNull()
  })

  it("still returns a prompt within the TTL", () => {
    vi.useFakeTimers()
    usePendingPromptStore.getState().setPending("b1", "fresh")
    vi.advanceTimersByTime(PENDING_PROMPT_TTL_MS - 1)
    expect(usePendingPromptStore.getState().takePending("b1")).toBe("fresh")
  })
})
