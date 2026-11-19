/**
 * Service layer (G1) — the vocabulary for "every capability is a service, each
 * independently BYOK or managed".
 *
 * A `ServiceKind` is a capability the agent can reach off-device. Each kind is
 * resolved (per request) to a `ServiceMode`:
 *   - "byok"    → call the provider directly with the USER's key,
 *   - "managed" → call our server proxy, which forwards with OUR keys (metered),
 *   - "keyless" → an explicitly selected provider that needs no key at all,
 *   - "off"     → unavailable (the corresponding tool is hidden).
 *
 * This module is pure types + constants — no React, no network — so the
 * resolution logic (`resolve.ts`) is trivially unit-testable.
 */

export type ServiceKind = "llm" | "search" | "code" | "fetch" | "parse"


export const SERVICE_KINDS: readonly ServiceKind[] = ["llm", "search", "code", "fetch", "parse"]


export type ServiceMode = "byok" | "managed" | "keyless" | "off"


/**
 * Search providers usable with no key from anyone — the user's or ours. The
 * next one is an entry here plus its client in `parallel-search.ts`, not a new
 * branch in the resolver.
 */
export const KEYLESS_SEARCH_ENGINES = ["parallel", "keenable"] as const


export type KeylessSearchEngine = (typeof KEYLESS_SEARCH_ENGINES)[number]


/** Whether an engine id is one the agent can use without any key. */
export const isKeylessSearchEngine = (engine: string | undefined): engine is KeylessSearchEngine =>
  !!engine && (KEYLESS_SEARCH_ENGINES as readonly string[]).includes(engine)


/**
 * A user-supplied credential for one service (BYOK). `model` applies to the LLM
 * service (and any provider that needs a model id); other kinds may omit it.
 */
export type ByokCredential = {
  provider: string
  apiKey: string
  model?: string
}


/** The user's BYOK keys, keyed by service. Any subset may be present. */
export type PerKindByok = Partial<Record<ServiceKind, ByokCredential>>


/** The resolved decision for one service kind. */
export type ServiceResolution =
  | { kind: ServiceKind; mode: "byok"; credential: ByokCredential }
  | { kind: ServiceKind; mode: "managed"; provider?: string; model?: string }
  | { kind: "search"; mode: "keyless"; provider: KeylessSearchEngine }
  | { kind: ServiceKind; mode: "off" }


/**
 * Inputs the resolver decides from. `managedAllowed` lets entitlement/plan gating
 * (G4) veto managed per-kind; default is "allowed when signed in". `preferManaged`
 * is the user preference to use our keys even when a BYOK key exists (default: BYOK
 * wins, so a configured key is never silently metered).
 */
export type ResolveContext = {
  signedIn: boolean
  /** Explicit keyless search selection, independent of keys and sign-in. */
  searchEngine?: string
  /**
   * Whether the network a keyless engine needs is reachable. A keyless engine
   * is called direct, so this is "are we online", not "is our server up".
   * Omitted means unknown → treated as reachable (the resolver stays pure).
   */
  online?: boolean
  byok: PerKindByok
  managedAllowed?: (kind: ServiceKind) => boolean
  preferManaged?: boolean
}
