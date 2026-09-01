import { invoke } from "@tauri-apps/api/core"
import { googleSigninDesktop, type TokenPayload } from "@/api"
import { makePkce, randomState } from "./pkce"


/**
 * Desktop Google sign-in via the system browser (loopback + PKCE). The Rust
 * `google_oauth` command opens the default browser to Google's consent screen and
 * returns the auth `code` from the loopback redirect; the backend then exchanges
 * the code (its client secret) for tokens. Google can't run OAuth inside the
 * webview, which is why this goes through the OS browser instead of GIS.
 */
export async function desktopGoogleSignin(clientId: string): Promise<TokenPayload> {
  const { verifier, challenge } = await makePkce()
  const state = randomState()
  const { code, redirect_uri } = await invoke<{ code: string; redirect_uri: string }>(
    "google_oauth",
    { clientId, scope: "openid email profile", codeChallenge: challenge, state },
  )
  return googleSigninDesktop(code, verifier, redirect_uri)
}
