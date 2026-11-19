/**
 * Keyless Parallel search, called straight from the client.
 *
 * `search.parallel.ai/mcp` answers with `Access-Control-Allow-Origin: *` and
 * allows the MCP request headers, so the browser can reach it cross-origin and
 * the desktop app can go through plugin-http like BYOK search already does.
 * No key, no sign-in, and on a local board no call to our backend at all.
 *
 * Streamable HTTP is JSON-RPC over POST: one `tools/call` is the whole
 * exchange, no `initialize` handshake and no session to tear down. The same
 * shape the backend relay (`websearch/parallel.py`) speaks, so `/ai/search`
 * stays a drop-in fallback.
 */
import { tauriFetch, type FetchFn } from "./desktop-http"
import type { SearchResult } from "./clients"
import { isTauri } from "@/platform"


const MCP_URL = "https://search.parallel.ai/mcp"
const PROTOCOL_VERSION = "2025-06-18"

/** `fetch` keeps its window binding — calling a bare reference throws in the browser. */
const browserFetch: FetchFn = (input, init) => fetch(input, init)


/**
 * The provider was reached and answered with a refusal (a status, or a tool
 * error). Distinct from a transport failure so the caller knows retrying
 * through our relay would only spend the same shared allowance again.
 */
export class KeylessUpstreamError extends Error {}

type SearchResponse = { answer: string; results: SearchResult[] }
type SearchPost = (body: { query: string; engine?: string }) => Promise<SearchResponse>

type ParallelSource = { url?: unknown; title?: unknown; excerpts?: unknown }


/** Pull the tool's JSON payload out of one JSON-RPC reply (plain or SSE-framed). */
const toolPayload = (raw: string, contentType: string): { results?: ParallelSource[] } => {
  const line = contentType.includes("text/event-stream")
    ? raw.split("\n").find((l) => l.startsWith("data:"))?.slice("data:".length).trim()
    : raw
  if (!line) throw new KeylessUpstreamError("Parallel search returned an empty response")
  const body = JSON.parse(line) as {
    error?: { message?: string }
    result?: { content?: { type?: string; text?: string }[]; structuredContent?: unknown; isError?: boolean }
  }
  if (body.error) throw new KeylessUpstreamError(`Parallel search failed: ${body.error.message ?? "unknown error"}`)
  const result = body.result ?? {}
  const text = (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n")
  if (result.isError) throw new KeylessUpstreamError(`Parallel search failed: ${text || "unknown error"}`)
  return (result.structuredContent ?? JSON.parse(text)) as { results?: ParallelSource[] }
}


/** One source → the `/ai/search` result shape; a text-less source keeps its url. */
const toResult = (source: ParallelSource): SearchResult => ({
  url: typeof source.url === "string" ? source.url : "",
  title: typeof source.title === "string" ? source.title : "",
  content: Array.isArray(source.excerpts) ? source.excerpts.filter((e) => typeof e === "string").join("\n\n") : "",
})


/**
 * A `SearchPost` that calls Parallel directly and returns what `/ai/search`
 * would. `fetchImpl` defaults to plugin-http on desktop (CORS-free) and the
 * webview's own `fetch` in the browser.
 */
export const parallelSearchPost =
  (fetchImpl?: FetchFn): SearchPost =>
  async (body) => {
    const doFetch = fetchImpl ?? (isTauri() ? tauriFetch : browserFetch)
    const res = await doFetch(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        // Anonymous by construction: a throwaway id, never our run id.
        id: crypto.randomUUID(),
        method: "tools/call",
        params: { name: "web_search", arguments: { objective: body.query, search_queries: [body.query] } },
      }),
    })
    if (!res.ok) throw new KeylessUpstreamError(`Parallel search failed: ${res.status}`)
    const payload = toolPayload(await res.text(), res.headers.get("content-type") ?? "")
    const results = (payload.results ?? []).map(toResult).filter((r) => r.url)
    return { answer: "", results }
  }


const KEENABLE_PUBLIC_URL = "https://api.keenable.ai/v1/search/public"
const KEENABLE_TITLE = "Dim0"

type KeenableSource = { url?: unknown; title?: unknown; snippet?: unknown; description?: unknown }

/** A `SearchPost` that calls Keenable's public search endpoint and returns the `/ai/search` shape. */
export const keenableSearchPost =
  (fetchImpl?: FetchFn): SearchPost =>
  async (body) => {
    const doFetch = fetchImpl ?? (isTauri() ? tauriFetch : browserFetch)
    const res = await doFetch(KEENABLE_PUBLIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Keenable-Title": KEENABLE_TITLE,
      },
      body: JSON.stringify({ query: body.query }),
    })
    if (!res.ok) throw new KeylessUpstreamError(`Keenable search failed: ${res.status}`)
    const payload = (await res.json()) as { results?: KeenableSource[] }
    const results = (payload.results ?? [])
      .map((source) => ({
        url: typeof source.url === "string" ? source.url : "",
        title: typeof source.title === "string" ? source.title : "",
        content:
          typeof source.snippet === "string" && source.snippet
            ? source.snippet
            : typeof source.description === "string"
              ? source.description
              : "",
      }))
      .filter((r) => r.url)
    return { answer: "", results }
  }


/** Keyless engines the client can call directly, keyed by engine id. */
const DIRECT_KEYLESS_SEARCH: Record<string, () => SearchPost> = {
  parallel: () => parallelSearchPost(),
  keenable: () => keenableSearchPost(),
}


/** A direct `SearchPost` for a keyless engine, or `null` when it has no direct path. */
export const keylessSearchPost = (engine: string | undefined): SearchPost | null => {
  const make = engine ? DIRECT_KEYLESS_SEARCH[engine] : undefined
  return make ? make() : null
}
