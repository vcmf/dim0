/** base64url-encode bytes (no padding) — for PKCE + OAuth `state`. */
export const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")


/** A PKCE verifier + its S256 challenge (RFC 7636). Shared by the web-redirect
 *  and desktop-loopback Google sign-in flows. */
export async function makePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: b64url(new Uint8Array(digest)) }
}


/** A URL-safe random string — used as the OAuth `state` (CSRF guard). */
export const randomState = (): string => b64url(crypto.getRandomValues(new Uint8Array(16)))
