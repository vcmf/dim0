import { beforeEach, describe, expect, it, vi } from "vitest"


const persist = vi.hoisted(() => ({
  listLocalChats: vi.fn<(boardId: string) => Promise<unknown[]>>(async () => []),
  loadMessages: vi.fn<(chatUid: string) => Promise<unknown[]>>(async () => []),
  saveMessages: vi.fn(async () => {}),
}))

vi.mock("./chat-persist", () => persist)


import { useLocalMessagesStore } from "./local-messages-store"


describe("useLocalMessagesStore.openBoard loadedBoardId", () => {
  beforeEach(() => {
    useLocalMessagesStore.getState().reset()
    persist.listLocalChats.mockReset()
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("marks the board loaded once its (empty) chat list resolves", async () => {
    persist.listLocalChats.mockResolvedValueOnce([])
    const pending = useLocalMessagesStore.getState().openBoard("b1")
    expect(useLocalMessagesStore.getState().loadedBoardId).toBeNull()
    await pending
    expect(useLocalMessagesStore.getState().loadedBoardId).toBe("b1")
  })

  it("still marks the board loaded when storage fails, so waiters aren't stuck", async () => {
    persist.listLocalChats.mockRejectedValueOnce(new Error("idb blocked"))
    await useLocalMessagesStore.getState().openBoard("b1")
    expect(useLocalMessagesStore.getState().loadedBoardId).toBe("b1")
    expect(useLocalMessagesStore.getState().chatUid).toBeNull()
  })
})
