import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { keenableSearchPost } from "./services/parallel-search"
import { resolveService } from "./services/resolve"
import { agentResolveContext } from "./services/context"
import { resolveSearchClient } from "./web-search"
import { useByokStore } from "../byok/byok-store"


const PUBLIC_URL = "https://api.keenable.ai/v1/search/public"

const payload = {
  results: [
    { title: "A", url: "https://a.example", snippet: "alpha", acquired_at: "2026-11-19T00:00:00Z" },
    { title: "B", url: "https://b.example", description: "beta" },
    { title: "skip", snippet: "no url" },
  ],
}

const direct = vi.fn()

beforeEach(() => {
  direct.mockReset()
  direct.mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  )
  vi.stubGlobal("fetch", direct)
  localStorage.clear()
  useByokStore.setState({ search: {}, searchEngine: "perplexity", llm: {}, codeKey: "", parseKey: "" })
})

afterEach(() => {
  vi.unstubAllGlobals()
})


describe("the direct keyless Keenable client", () => {
  it("posts to the public endpoint with X-Keenable-Title and maps snippet then description", async () => {
    const { results } = await keenableSearchPost(direct as unknown as typeof fetch)({ query: "cats" })

    expect(results).toEqual([
      { url: "https://a.example", title: "A", content: "alpha" },
      { url: "https://b.example", title: "B", content: "beta" },
    ])
    const [url, init] = direct.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(PUBLIC_URL)
    const headers = new Headers(init.headers)
    expect(headers.get("X-Keenable-Title")).toBe("Dim0")
    expect(headers.has("X-API-Key")).toBe(false)
    expect(JSON.parse(init.body as string)).toEqual({ query: "cats" })
  })

  it("treats a non-OK status as an upstream refusal", async () => {
    direct.mockResolvedValueOnce(new Response("nope", { status: 429 }))
    await expect(
      keenableSearchPost(direct as unknown as typeof fetch)({ query: "cats" }),
    ).rejects.toThrow(/429/)
  })
})


describe("selecting Keenable as the search engine", () => {
  it.each([true, false])("resolves as keyless when signedIn=%s", (signedIn) => {
    const ctx = agentResolveContext({ signedIn, searchEngine: "keenable", online: true })
    expect(resolveService("search", ctx)).toEqual({ kind: "search", mode: "keyless", provider: "keenable" })
  })

  it("is unavailable when the network is offline", () => {
    expect(resolveSearchClient({ signedIn: false, engine: "keenable", online: false })).toBeNull()
  })

  it("persists the selection without requiring a key", () => {
    const store = useByokStore.getState()
    store.setSearchEngine("keenable")
    expect(JSON.parse(localStorage.getItem("dim0.byok") ?? "{}").searchEngine).toBe("keenable")
    expect(store.searchByok()).toBeNull()
  })
})
