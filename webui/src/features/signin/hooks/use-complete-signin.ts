import { useCallback } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { decodeJwt, resolveBillingPlan } from "@/lib/decode-jwt"
import { useAppStore } from "@/store"
import { getEmailVerificationStatus, type TokenPayload } from "@/api"


/**
 * Route a successful authentication into the app: hydrate the user store from the
 * JWT, resolve email-verification status, and navigate (to `/verify-email` when
 * required, else `/`). Shared by password + Google (web redirect + desktop)
 * sign-in and the OAuth callback, so the post-auth handling stays in one place.
 */
export function useCompleteSignin(): (token: TokenPayload) => Promise<void> {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const setUserId = useAppStore((s) => s.setUserId)
  const setUserEmail = useAppStore((s) => s.setUserEmail)
  const setUserPlan = useAppStore((s) => s.setUserPlan)
  const setEmailVerificationEnabled = useAppStore((s) => s.setEmailVerificationEnabled)
  const setEmailVerified = useAppStore((s) => s.setEmailVerified)

  return useCallback(
    async (token: TokenPayload) => {
      queryClient.clear()
      const p = decodeJwt(token.access_token)
      if (p.sub) setUserId(String(p.sub))
      if (typeof p.email === "string") setUserEmail(p.email)
      setUserPlan(resolveBillingPlan(p))
      const status = await getEmailVerificationStatus()
      setEmailVerificationEnabled(status.enabled)
      setEmailVerified(status.verified)
      if (status.enabled && !status.verified) {
        navigate({ to: "/verify-email", replace: true })
        return
      }
      navigate({ to: "/", replace: true })
    },
    [navigate, queryClient, setEmailVerificationEnabled, setEmailVerified, setUserEmail, setUserId, setUserPlan],
  )
}
