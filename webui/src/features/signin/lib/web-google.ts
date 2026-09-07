import { makePkce, randomState } from "./pkce"


const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
const STORAGE_KEY = "google_web_oauth"


/** Where Google redirects back to after consent — must match the URI registered
 *  on the web OAuth client AND the one sent to the backend code exchange. */
export const webGoogleRedirectUri = (): string => `${window.location.origin}/signin/google/callback`


export type PendingGoogleOAuth = { verifier: string; state: string }


/** Build Google's authorization-endpoint URL for the auth-code + PKCE flow. Pure,
 *  so the query construction is unit-testable without navigating. */
export function buildGoogleAuthUrl(clientId: string, codeChallenge: string, state: string): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT)
  url.searchParams.set("client_id", clientId)
  url.searchParams.set("redirect_uri", webGoogleRedirectUri())
  url.searchParams.set("response_type", "code")
  url.searchParams.set("scope", "openid email profile")
  url.searchParams.set("code_challenge", codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", state)
  url.searchParams.set("prompt", "select_account")
  return url.toString()
}


/**
 * Begin the web redirect (auth-code + PKCE) Google sign-in: make a PKCE
 * verifier/challenge + a `state`, stash them in `sessionStorage`, then navigate
 * the top-level window to Google's consent screen. Unlike GIS, this uses no
 * popup, no `postMessage`, and no third-party cookies — so ad blockers / tracking
 * prevention can't break it. The callback route finishes the exchange.
 */
export async function initiateWebGoogleSignin(clientId: string): Promise<void> {
  const { verifier, challenge } = await makePkce()
  const state = randomState()
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ verifier, state } satisfies PendingGoogleOAuth))
  window.location.assign(buildGoogleAuthUrl(clientId, challenge, state))
}


/**
 * Read + clear the stashed PKCE verifier / `state` on the callback. Returns null
 * when absent or malformed (e.g. a stale/forged callback), so the caller can
 * reject the sign-in instead of trusting it.
 */
export function consumePendingGoogleOAuth(): PendingGoogleOAuth | null {
  const raw = sessionStorage.getItem(STORAGE_KEY)
  sessionStorage.removeItem(STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as PendingGoogleOAuth
    return typeof parsed?.verifier === "string" && typeof parsed?.state === "string" ? parsed : null
  } catch {
    return null
  }
}
