import { API_URL } from "@/config/api"
import {
  getAccessToken,
  getRefreshToken,
  setAccessToken,
  setRefreshToken,
  clearTokens,
} from "./features/signin/auth-storage"
import { notifyHttpFailure } from "@/features/connection/connection-state"


/**
 * Wrap `fetch` so a network-level failure (timeout, DNS, abort, offline)
 * notifies the connection-state detector. HTTP non-2xx responses are NOT
 * notified — those mean the server *did* respond, just unhappily; the
 * detector only cares about reachability.
 */
const trackedFetch: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init)
  } catch (err) {
    notifyHttpFailure()
    throw err
  }
}

let isRedirecting = false

function isAuthPage() {
  const p = location.pathname
  return p === "/signin" || p === "/signup" || p === "/forgot-password" || p === "/reset-password"
}

function isBrowserAsset(reqUrl: string) {
  try {
    const u = new URL(reqUrl, location.origin)
    return u.pathname === "/favicon.ico"
  } catch {
    return false
  }
}

let logoutHandler: (() => void) | null = null
export function registerLogoutHandler(cb: () => void) {
  logoutHandler = cb
}

/**
 * HTTP methods supported by the API.
 */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"


/**
 * Options for the apiFetch function.
 */
export type ApiOptions<TBody = unknown> = {
  path: string | URL
  method?: HttpMethod
  params?: Record<string, string | number | boolean | null | undefined>
  headers?: HeadersInit
  body?: TBody extends FormData ? FormData : TBody
  signal?: AbortSignal
  noAuth?: boolean
}


/**
 * The payload returned by the authentication endpoints.
 */
export type TokenPayload = {
  access_token: string
  token_type: string
  refresh_token?: string | null
}


export type EmailVerificationStatus = {
  enabled: boolean
  verified: boolean
}


export type AuthMethods = {
  local: boolean
  google: boolean
  google_client_id?: string | null
  /** Web redirect (auth-code + PKCE) sign-in — available only when the web client
   *  secret is configured server-side for the code exchange. */
  google_web_redirect?: boolean
  /** Desktop (Tauri) authorizes against its own "Desktop app" OAuth client. */
  google_desktop_client_id?: string | null
}


async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  /** Read API error payloads and return a user-facing message. */
  const text = await res.text()
  if (!text) return fallback
  try {
    const parsed = JSON.parse(text) as { data?: { message?: string } }
    return parsed.data?.message || fallback
  } catch {
    return text
  }
}


/* ---------------------------
   Single-flight refresh logic
---------------------------- */
let refreshing: Promise<void> | null = null


/**
 * Refresh the access token using the stored refresh token.
 */
async function refreshAccessToken(): Promise<void> {
  if (refreshing) return refreshing

  refreshing = (async () => {
    const rt = getRefreshToken()
    if (!rt) throw new Error("No refresh token")

    const url = new URL("/users/refresh", API_URL)
    const res = await trackedFetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: rt }),
    })

    if (!res.ok) throw new Error("Refresh failed")

    const json: unknown = await res.json()
    // backend: { data: { token: {...} } } because of with_standard_response
    const token = (json as { data?: { token?: TokenPayload }; token?: TokenPayload }).data?.token
      ?? (json as { token?: TokenPayload }).token

    if (!token?.access_token) throw new Error("Bad refresh payload")

    setAccessToken(token.access_token)
    if (token.refresh_token) setRefreshToken(token.refresh_token)
  })()

  try {
    await refreshing
  } finally {
    refreshing = null
  }
}


/* ---------------------------
   Core request wrapper
---------------------------- */

/**
 * A wrapper around fetch() that handles:
 * - Building the full URL from API_URL + path
 * - Adding query parameters
 * - Adding Authorization header with access token
 * - Refreshing the access token on 401 responses and retrying once
 * - JSON request and response handling
 */
export async function apiFetch<TResponse = unknown, TBody = unknown>(
  opts: ApiOptions<TBody>
): Promise<TResponse> {
  const { method = "GET", headers, body, params, signal, noAuth } = opts

  // Build absolute URL from API_URL + path
  const url = new URL(
    typeof opts.path === "string" ? opts.path : opts.path.toString(),
    API_URL
  )

  if (params) {
    const sp = new URLSearchParams(url.search)
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) sp.set(k, String(v))
    })
    url.search = sp.toString()
  }

  const h = new Headers(headers)

  if (!noAuth) {
    const token = getAccessToken()
    if (token) h.set("Authorization", `Bearer ${token}`)
  }

  let payload: BodyInit | undefined
  if (body instanceof FormData) {
    payload = body
  } else if (body !== undefined && body !== null) {
    h.set("Content-Type", "application/json")
    payload = JSON.stringify(body)
  }

  // First attempt
  let res = await trackedFetch(url.toString(), { method, headers: h, body: payload, signal })

  // If unauthorized and we are allowed to refresh -> refresh then retry once
  if (res.status === 401 && !noAuth) {
    try {
      await refreshAccessToken()

      const newHeaders = new Headers(h)
      const newToken = getAccessToken()
      if (newToken) newHeaders.set("Authorization", `Bearer ${newToken}`)

      res = await trackedFetch(url.toString(), {
        method,
        headers: newHeaders,
        body: payload,
        signal,
      })
    } catch {
      clearTokens()
      // If it's a favicon or we're on an auth page, do NOT bounce again
      if (isAuthPage() || isBrowserAsset(url.toString())) {
        throw new Error("Unauthorized")
      }

      // Prefer SPA logout handler if registered
      if (logoutHandler && !isRedirecting) {
        isRedirecting = true
        logoutHandler()
        return await new Promise<never>(() => {}) // stop here
      }

      if (!isRedirecting) {
        isRedirecting = true
        window.location.replace("/signin")
      }
      throw new Error("Unauthorized")
    }
  }

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status} ${res.statusText} - ${text}`)
  }

  const ct = res.headers.get("content-type") || ""
  return ct.includes("application/json")
    ? ((await res.json()) as TResponse)
    : ((await res.text()) as unknown as TResponse)
}

/* ---------------------------
   Auth helpers (typed)
---------------------------- */

/**
 * Sign in a user and store the returned tokens.
 */
export async function signin(username: string, password: string): Promise<TokenPayload> {
  const url = new URL("/users/signin", API_URL)
  const form = new URLSearchParams()
  form.set("username", username)
  form.set("password", password)

  const res = await trackedFetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  })

  if (!res.ok) {
    const message = await readErrorMessage(res, "Signin failed")
    throw new Error(message)
  }

  const json: unknown = await res.json()
  const token = (json as { data?: { token?: TokenPayload }; token?: TokenPayload }).data?.token
    ?? (json as { token?: TokenPayload }).token

  if (!token?.access_token) throw new Error("Wrong password or username.")

  setAccessToken(token.access_token)
  if (token.refresh_token) setRefreshToken(token.refresh_token)

  return token
}


/**
 * Sign up a new user and store the returned tokens.
 */
export async function signup(body: {
  email: string
  password: string
  name: string
  username: string
}): Promise<TokenPayload> {
  const tokenWrap = await apiFetch<{ data: { token: TokenPayload } }>({
    path: "/users/signup",
    method: "POST",
    body,
    noAuth: true,
  })

  const token = tokenWrap?.data?.token
  if (!token?.access_token) throw new Error("Bad signup payload")

  setAccessToken(token.access_token)
  if (token.refresh_token) setRefreshToken(token.refresh_token)

  return token
}


/**
 * Fetch which sign-in methods are currently available.
 */
export async function getAuthMethods(): Promise<AuthMethods> {
  const res = await apiFetch<{ data: AuthMethods }>({
    path: "/users/auth-methods",
    method: "GET",
    noAuth: true,
  })
  return res.data
}


/**
 * Web Google sign-in: hand the redirect auth code + PKCE verifier to the backend,
 * which exchanges them (secret stays server-side) and returns app tokens. Replaces
 * the legacy GIS id_token flow, which depended on third-party cookies / postMessage.
 */
export async function googleSigninWeb(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<TokenPayload> {
  const res = await trackedFetch(new URL("/users/google-signin-web", API_URL).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: codeVerifier, redirect_uri: redirectUri }),
  })

  if (!res.ok) {
    const message = await readErrorMessage(res, "Google sign in failed")
    throw new Error(message)
  }

  const json: unknown = await res.json()
  const token = (json as { data?: { token?: TokenPayload }; token?: TokenPayload }).data?.token
    ?? (json as { token?: TokenPayload }).token

  if (!token?.access_token) throw new Error("Google sign in failed")

  setAccessToken(token.access_token)
  if (token.refresh_token) setRefreshToken(token.refresh_token)

  return token
}


/**
 * Desktop Google sign-in: hand the loopback auth code + PKCE verifier to the
 * backend, which exchanges them (secret stays server-side) and returns app tokens.
 */
export async function googleSigninDesktop(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<TokenPayload> {
  const res = await trackedFetch(new URL("/users/google-signin-desktop", API_URL).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: codeVerifier, redirect_uri: redirectUri }),
  })

  if (!res.ok) {
    const message = await readErrorMessage(res, "Google sign in failed")
    throw new Error(message)
  }

  const json: unknown = await res.json()
  const token = (json as { data?: { token?: TokenPayload }; token?: TokenPayload }).data?.token
    ?? (json as { token?: TokenPayload }).token

  if (!token?.access_token) throw new Error("Google sign in failed")

  setAccessToken(token.access_token)
  if (token.refresh_token) setRefreshToken(token.refresh_token)

  return token
}


/**
 * Refresh the access token using the stored refresh token.
 */
export async function refresh(): Promise<TokenPayload> {
  await refreshAccessToken()
  return {
    access_token: getAccessToken() ?? "",
    token_type: "bearer",
    refresh_token: getRefreshToken(),
  }
}


/**
 * Fetch email verification status for the current authenticated user.
 */
export async function getEmailVerificationStatus(): Promise<EmailVerificationStatus> {
  const res = await apiFetch<{ data: EmailVerificationStatus }>({
    path: "/users/email-verification-status",
    method: "GET",
  })
  return res.data
}


/**
 * Request a verification email resend for the current authenticated user.
 */
export async function resendVerificationEmail(): Promise<void> {
  await apiFetch<{ data: { message: string } }>({
    path: "/users/resend-verification",
    method: "POST",
  })
}


/**
 * Verify an email token received from the verification link.
 */
export async function verifyEmailToken(token: string): Promise<void> {
  await apiFetch<{ data: { message: string } }, { token: string }>({
    path: "/users/verify-email",
    method: "POST",
    body: { token },
    noAuth: true,
  })
}


export type PasswordResetStatus = {
  enabled: boolean
}


/**
 * Fetch whether the password reset flow is enabled on the backend.
 */
export async function getPasswordResetStatus(): Promise<PasswordResetStatus> {
  const res = await apiFetch<{ data: PasswordResetStatus }>({
    path: "/users/password-reset-status",
    method: "GET",
    noAuth: true,
  })
  return res.data
}


/**
 * Request a password reset email. Backend always 200s to avoid email enumeration.
 */
export async function forgotPassword(email: string): Promise<void> {
  await apiFetch<{ data: { message: string } }, { email: string }>({
    path: "/users/forgot-password",
    method: "POST",
    body: { email },
    noAuth: true,
  })
}


/**
 * Complete a password reset by exchanging a reset token for a new password.
 */
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  await apiFetch<{ data: { message: string } }, { token: string; new_password: string }>({
    path: "/users/reset-password",
    method: "POST",
    body: { token, new_password: newPassword },
    noAuth: true,
  })
}


export type RawInit = RequestInit & { noAuth?: boolean }

/**
 * Fetch that:
 *  - attaches Bearer from localStorage
 *  - if 401 (and not noAuth), calls refresh() once
 *  - retries the original request
 *  - returns the Response without reading it (safe for streaming)
 */
export async function fetchWithAuthRaw(input: string | URL, init: RawInit = {}): Promise<Response> {
  const { noAuth, headers, ...rest } = init

  const h = new Headers(headers)
  if (!noAuth) {
    const token = getAccessToken()
    if (token) h.set("Authorization", `Bearer ${token}`)
  }

  const doFetch = (hdrs: Headers) =>
    trackedFetch(typeof input === "string" ? input : input.toString(), { ...rest, headers: hdrs })

  // first attempt
  let res = await doFetch(h)

  if (res.status === 401 && !noAuth) {
    try {
      await refresh() // will set new access token (and maybe refresh token)
      const h2 = new Headers(h)
      const t2 = getAccessToken()
      if (t2) h2.set("Authorization", `Bearer ${t2}`)
      res = await doFetch(h2)
    } catch {
      clearTokens()

      // If it's a favicon or we're on an auth page, do NOT bounce again
      if (isAuthPage()) {
        throw new Error("Unauthorized")
      }

      // Prefer SPA logout handler if registered
      if (logoutHandler && !isRedirecting) {
        isRedirecting = true
        logoutHandler()
        return await new Promise<never>(() => {}) // stop here
      }

      if (!isRedirecting) {
        isRedirecting = true
        window.location.replace("/signin")
      }
      throw new Error("Unauthorized")
    }
  }

  return res
}
