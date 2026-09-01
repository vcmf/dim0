import * as React from "react"
import { Link } from "@tanstack/react-router"
import { googleSigninWeb } from "@/api"
import { Loader2Icon } from "@/components/icons"
import { consumePendingGoogleOAuth, webGoogleRedirectUri } from "../lib/web-google"
import { useCompleteSignin } from "../hooks/use-complete-signin"


/**
 * Google OAuth redirect landing (`/signin/google/callback`). Validates the
 * returned `state` against the value stashed before the redirect (CSRF), then
 * hands the auth `code` + PKCE verifier to the backend to exchange for app
 * tokens. On success `completeSignin` routes into the app; on failure it shows
 * the error with a way back to sign-in.
 */
export function GoogleCallbackPage() {
  const completeSignin = useCompleteSignin()
  const started = React.useRef(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    // The auth code is single-use; guard against React StrictMode's double-invoke.
    if (started.current) return
    started.current = true

    const params = new URLSearchParams(window.location.search)
    const oauthError = params.get("error")
    const code = params.get("code")
    const state = params.get("state")
    // Read + clear the stashed PKCE/state regardless, so a stale one can't linger.
    const pending = consumePendingGoogleOAuth()

    void (async () => {
      if (oauthError) return setError("Google sign in was cancelled or did not complete.")
      if (!code || !state || !pending) return setError("Google sign in could not be completed. Please try again.")
      if (state !== pending.state) return setError("Google sign in failed a security check. Please try again.")
      try {
        const token = await googleSigninWeb(code, pending.verifier, webGoogleRedirectUri())
        await completeSignin(token)
      } catch (e) {
        setError((e as Error).message || "Google sign in failed. Please try again.")
      }
    })()
  }, [completeSignin])

  return (
    <div className="w-full max-w-md mx-auto py-16 text-center">
      {error ? (
        <div className="space-y-4">
          <p className="text-sm text-destructive">{error}</p>
          <Link
            to="/signin"
            replace
            className="inline-block text-sm font-medium text-primary underline underline-offset-4"
          >
            Back to sign in
          </Link>
        </div>
      ) : (
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          Completing sign in…
        </div>
      )}
    </div>
  )
}
