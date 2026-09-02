import { create } from "zustand"
import type { ByokConfig, ByokProvider } from "@/features/agent/engine/byok-client"


const STORAGE_KEY = "dim0.byok"


/** Web-search providers a user can bring a key for (relayed through our proxy). */
export type SearchEngine = "perplexity" | "tavily" | "linkup" | "exa"


/** A model provider's own BYOK credential. */
type LlmCred = { apiKey: string; model: string }


type Stored = {
  provider: ByokProvider
  /** Per-provider model keys — each provider keeps its own key + model. */
  llm: Partial<Record<ByokProvider, LlmCred>>
  searchEngine: SearchEngine
  /** Per-engine search keys — set one without clearing the others. */
  search: Partial<Record<SearchEngine, string>>
  codeKey: string
  /** Document parsing (Mistral OCR) — relayed through our proxy. */
  parseKey: string
}


/** Read a remembered config from localStorage (opt-in), migrating the old
 *  single-key shape ({apiKey, searchKey}) into the per-provider maps. */
const load = (): Stored | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<Stored> & {
      apiKey?: string
      model?: string
      searchKey?: string
    }
    const provider = p.provider ?? "openrouter"
    const searchEngine = p.searchEngine ?? "perplexity"
    return {
      provider,
      llm: p.llm ?? (p.apiKey ? { [provider]: { apiKey: p.apiKey, model: p.model ?? "" } } : {}),
      searchEngine,
      search: p.search ?? (p.searchKey ? { [searchEngine]: p.searchKey } : {}),
      codeKey: p.codeKey ?? "",
      parseKey: p.parseKey ?? "",
    }
  } catch {
    return null
  }
}


/** Fallback model id per provider when the user leaves the field blank. OpenRouter
 *  defaults to the GLM 5.3 Flash base model; OpenAI to gpt-5.4. */
const defaultModel = (provider: ByokProvider): string =>
  provider === "openai" ? "gpt-5.4" : "z-ai/glm-5.3-flash:nitro"


type ByokState = {
  // Models (LLM) — called direct from the browser. Per-provider keys.
  provider: ByokProvider
  llm: Partial<Record<ByokProvider, LlmCred>>
  configured: boolean
  // Web search — relayed through our proxy. Per-engine keys.
  searchEngine: SearchEngine
  search: Partial<Record<SearchEngine, string>>
  // Code interpreter (Daytona) — relayed through our proxy.
  codeKey: string
  // Document parsing (Mistral OCR) — relayed through our proxy.
  parseKey: string
  /** Save a provider's model key + model, and make it the active provider. */
  setLlm: (cfg: { provider: ByokProvider; apiKey: string; model: string }) => void
  /** Switch the active model provider (keys are preserved per provider). */
  setProvider: (provider: ByokProvider) => void
  /** Switch the active search engine (keys are preserved per engine). */
  setSearchEngine: (engine: SearchEngine) => void
  /** Save one engine's key without touching the others. */
  setSearchKey: (engine: SearchEngine, apiKey: string) => void
  setCode: (cfg: { apiKey: string }) => void
  setParse: (cfg: { apiKey: string }) => void
  clear: () => void
  /** The active provider's config (key + model), or null when it has no key. */
  asConfig: () => ByokConfig | null
  /** The active engine's search credential, or null when it has no key. */
  searchByok: () => { engine: SearchEngine; apiKey: string } | null
  /** The code (Daytona) BYOK key, or null when unset. */
  codeByok: () => string | null
  /** The document-parsing (Mistral) BYOK key, or null when unset. */
  parseByok: () => string | null
}


const initial = load()
const configuredFor = (provider: ByokProvider, llm: Partial<Record<ByokProvider, LlmCred>>): boolean =>
  Boolean(llm[provider]?.apiKey)


/**
 * BYOK config across services, keyed per provider/engine so several keys
 * coexist (OpenRouter + OpenAI, Tavily + Linkup, …). `provider`/`searchEngine`
 * are the ACTIVE selections; `configured` tracks whether the active model
 * provider has a key. Persisted to localStorage on this device by default (so
 * keys survive reloads/redeploys); `clear()` forgets them. Keys go only to the
 * provider (direct for models, relayed per-request for search/code) — never to
 * our servers.
 */
export const useByokStore = create<ByokState>((set, get) => ({
  provider: initial?.provider ?? "openrouter",
  llm: initial?.llm ?? {},
  configured: configuredFor(initial?.provider ?? "openrouter", initial?.llm ?? {}),
  searchEngine: initial?.searchEngine ?? "perplexity",
  search: initial?.search ?? {},
  codeKey: initial?.codeKey ?? "",
  parseKey: initial?.parseKey ?? "",

  setLlm: ({ provider, apiKey, model }) => {
    const llm = { ...get().llm, [provider]: { apiKey, model } }
    set({ provider, llm, configured: configuredFor(provider, llm) })
    persist(get)
  },

  setProvider: (provider) => {
    set({ provider, configured: configuredFor(provider, get().llm) })
    persist(get)
  },

  setSearchEngine: (engine) => {
    set({ searchEngine: engine })
    persist(get)
  },

  setSearchKey: (engine, apiKey) => {
    set({ search: { ...get().search, [engine]: apiKey }, searchEngine: engine })
    persist(get)
  },

  setCode: ({ apiKey }) => {
    set({ codeKey: apiKey })
    persist(get)
  },

  setParse: ({ apiKey }) => {
    set({ parseKey: apiKey })
    persist(get)
  },

  clear: () => {
    set({ llm: {}, configured: false, search: {}, codeKey: "", parseKey: "" })
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // ignore
    }
  },

  asConfig: () => {
    const { provider, llm } = get()
    const cred = llm[provider]
    if (!cred?.apiKey) return null
    return { provider, apiKey: cred.apiKey, model: cred.model.trim() || defaultModel(provider) }
  },

  searchByok: () => {
    const { searchEngine, search } = get()
    const apiKey = search[searchEngine]
    return apiKey?.trim() ? { engine: searchEngine, apiKey: apiKey.trim() } : null
  },

  codeByok: () => get().codeKey.trim() || null,

  parseByok: () => get().parseKey.trim() || null,
}))


const hasAnyKey = (s: ByokState): boolean =>
  Object.values(s.llm).some((c) => c?.apiKey) ||
  Object.values(s.search).some(Boolean) ||
  Boolean(s.codeKey) ||
  Boolean(s.parseKey)


/** Persist the config to localStorage on this device (until `clear()`). */
function persist(get: () => ByokState): void {
  const { provider, llm, searchEngine, search, codeKey, parseKey } = get()
  try {
    if (hasAnyKey(get())) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ provider, llm, searchEngine, search, codeKey, parseKey }))
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // storage unavailable — config stays in-memory only
  }
}
