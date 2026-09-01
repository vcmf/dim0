import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { getAuthMethods, signin } from "@/api"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Loader2Icon, LockIcon, MailIcon } from "@/components/icons"
import { PasswordInput } from "../components/password-input"
import { initiateWebGoogleSignin } from "../lib/web-google"
import { desktopGoogleSignin } from "../lib/desktop-google"
import { useCompleteSignin } from "../hooks/use-complete-signin"
import { isTauri } from "@/platform"

/** Renders the sign-in screen and routes successful authentication into the app. */
export function SigninPage() {
  const completeSignin = useCompleteSignin()

  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [googleError, setGoogleError] = React.useState<string | null>(null)
  const [googleRedirecting, setGoogleRedirecting] = React.useState(false)

  const authMethodsQuery = useQuery({
    queryKey: ["auth-methods"],
    queryFn: getAuthMethods,
  })

  const startWebGoogle = React.useCallback(async (clientId: string) => {
    setGoogleError(null)
    setGoogleRedirecting(true)
    try {
      // Navigates the top-level window to Google's consent screen; control returns
      // via the /signin/google/callback route.
      await initiateWebGoogleSignin(clientId)
    } catch (error) {
      setGoogleError((error as Error).message || "Unable to continue with Google")
      setGoogleRedirecting(false)
    }
  }, [])

  // Pressing Back from Google's consent restores this page from bfcache with the
  // "redirecting" spinner still latched — `pageshow` (fires on restore) clears it
  // so the button is usable again without a hard reload.
  React.useEffect(() => {
    const reset = () => setGoogleRedirecting(false)
    window.addEventListener("pageshow", reset)
    return () => window.removeEventListener("pageshow", reset)
  }, [])

  const localSigninMutation = useMutation({
    mutationFn: () => signin(email, password),
    onMutate: () => setGoogleError(null),
    onSuccess: completeSignin,
  })

  // Desktop: GIS can't run in the webview, so sign in via the system browser
  // (loopback + PKCE). Uses the "Desktop app" OAuth client, exchanged server-side.
  const desktopGoogleMutation = useMutation({
    mutationFn: (clientId: string) => desktopGoogleSignin(clientId),
    onMutate: () => setGoogleError(null),
    onSuccess: completeSignin,
    onError: error => {
      setGoogleError((error as Error).message || "Unable to continue with Google")
    },
  })

  const authMethods = authMethodsQuery.data
  const desktop = isTauri()
  const showLocalSignin = authMethods?.local ?? true
  // Web uses the redirect (auth-code + PKCE) flow — gated on the backend having the
  // web client secret configured (google_web_redirect). Desktop uses the
  // system-browser flow (own "Desktop app" client id). Never both.
  const showGoogleWeb = !desktop && Boolean(authMethods?.google_web_redirect && authMethods.google_client_id)
  // Desktop availability is independent of the web client — the backend only
  // returns google_desktop_client_id when the Desktop OAuth client is configured,
  // so its presence alone gates the button (a deploy may have desktop but no web).
  const showGoogleDesktop = desktop && Boolean(authMethods?.google_desktop_client_id)
  const showSeparator = showLocalSignin && (showGoogleWeb || showGoogleDesktop)
  const localError = localSigninMutation.isError
    ? (localSigninMutation.error as Error).message || "Unable to sign in"
    : null

  return (
    <div className="w-full max-w-md mx-auto">
      <Card className="bg-card text-card-foreground border border-border shadow-xl">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl flex flex-col items-center justify-center gap-2">
            <img src="/dim0.svg" alt="Dim0 Logo" className="h-12 w-12 aspect-square object-contain" />
            <span className="text-muted-foreground">Welcome back!</span>
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Sign in to continue to your workspace
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-5"
            onSubmit={e => {
              e.preventDefault()
              if (!showLocalSignin) return
              localSigninMutation.mutate()
            }}
          >
            {showLocalSignin ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <div className="relative">
                    <Input
                      id="email"
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      required
                      autoComplete="email"
                      autoFocus
                      className="pl-9"
                    />
                    <MailIcon className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" strokeWidth={2} />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <div className="relative">
                    <PasswordInput
                      id="password"
                      placeholder="••••••••"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      required
                      autoComplete="current-password"
                      className="pl-9 pr-9"
                    />
                    <LockIcon className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" strokeWidth={2} />
                  </div>
                </div>

                {localError ? (
                  <p className="text-sm text-destructive">
                    {localError}
                  </p>
                ) : null}

                <Button type="submit" className="w-full" disabled={localSigninMutation.isPending || authMethodsQuery.isLoading}>
                  {localSigninMutation.isPending ? (
                    <span className="inline-flex items-center gap-2">
                      <Loader2Icon className="h-4 w-4 animate-spin" />
                      Signing in…
                    </span>
                  ) : (
                    "Sign in"
                  )}
                </Button>
              </>
            ) : null}

            {showSeparator ? (
              <div className="space-y-3">
                <Separator />
                <p className="text-center text-sm text-muted-foreground">or</p>
              </div>
            ) : null}

            {showGoogleWeb ? (
              <div className="space-y-2">
                {googleError ? (
                  <p className="text-sm text-destructive">{googleError}</p>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => void startWebGoogle(authMethods!.google_client_id!)}
                  disabled={googleRedirecting}
                >
                  {googleRedirecting ? (
                    <span className="inline-flex items-center gap-2">
                      <Loader2Icon className="h-4 w-4 animate-spin" />
                      Redirecting to Google…
                    </span>
                  ) : (
                    "Continue with Google"
                  )}
                </Button>
              </div>
            ) : null}

            {showGoogleDesktop ? (
              <div className="space-y-2">
                {googleError ? (
                  <p className="text-sm text-destructive">{googleError}</p>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => desktopGoogleMutation.mutate(authMethods!.google_desktop_client_id!)}
                  disabled={desktopGoogleMutation.isPending}
                >
                  {desktopGoogleMutation.isPending ? (
                    <span className="inline-flex items-center gap-2">
                      <Loader2Icon className="h-4 w-4 animate-spin" />
                      Continue in your browser…
                    </span>
                  ) : (
                    "Continue with Google"
                  )}
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  Opens your browser to sign in, then returns here.
                </p>
              </div>
            ) : null}

            {!authMethodsQuery.isLoading && !showLocalSignin && !showGoogleWeb && !showGoogleDesktop ? (
              <p className="text-sm text-destructive">
                No sign-in methods are currently available.
              </p>
            ) : null}

            {authMethodsQuery.isError ? (
              <p className="text-sm text-destructive">
                {(authMethodsQuery.error as Error).message || "Unable to load sign-in methods"}
              </p>
            ) : null}

            <p className="text-center text-xs text-muted-foreground">
              By signing in, you agree to our{" "}
              <a
                href="https://www.dim0.net/terms"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                Terms
              </a>{" "}
              and{" "}
              <a
                href="https://www.dim0.net/privacy"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                Privacy Policy
              </a>
              .
            </p>

            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Don’t have an account?{" "}
                <Link to="/signup" className="font-medium underline">
                  Create one
                </Link>
              </span>
              <Link to="/forgot-password" className="text-muted-foreground underline">
                Forgot password?
              </Link>
            </div>

            <div className="text-center">
              <Link to="/" className="text-sm text-muted-foreground underline underline-offset-2">
                ← Back to local boards
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
