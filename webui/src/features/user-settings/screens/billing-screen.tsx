import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CardsThree, GithubLogo, Headset, UsersThree } from "@phosphor-icons/react"
import {
  AwardIcon,
  ChatTranslateIcon,
  DocumentIcon,
  PuzzlePieceIcon,
  SparklesFeatureIcon,
  SparklesIcon,
  WarningIcon,
  type AppIconComponent,
} from "@/components/icons"
import { refresh } from "@/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { TierBadge } from "@/features/user-settings/components/tier-badge"
import {
  createCheckoutSession,
  createPortalSession,
  getBillingPublicConfig,
  getBillingSummary,
  type BillingPublicConfig,
  type BillingSummary,
  type PaidPlan,
  type PriceInfo
} from "@/features/user-settings/api/billing"
import { getAccessToken } from "@/features/signin/auth-storage"
import { decodeJwt, resolveBillingPlan, type BillingPlan } from "@/lib/decode-jwt"
import { isTauri, openExternalUrl } from "@/platform"
import { useAppStore } from "@/store"


const GITHUB_URL = "https://github.com/vcmf/dim0"


type FeatureRowProps = {
  icon: AppIconComponent
  label: string
}


function FeatureRow({ icon, label }: FeatureRowProps) {
  const Icon = icon

  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={2} />
      <span>{label}</span>
    </div>
  )
}


export function BillingScreen() {
  const userPlan = useAppStore(s => s.userPlan)
  const setUserPlan = useAppStore(s => s.setUserPlan)
  const billingActive = useAppStore(s => s.billingActive)
  const [busyAction, setBusyAction] = useState<"upgrade-basic" | "upgrade-plus" | "manage" | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [billingSummary, setBillingSummary] = useState<BillingSummary | null>(null)
  const [billingPublicConfig, setBillingPublicConfig] = useState<BillingPublicConfig | null>(null)
  const refreshedAfterReturn = useRef(false)
  // Desktop only: the plan we held when we sent the user out to Stripe, or null
  // when no Stripe round-trip is in flight. Gates the focus-refresh so it fires
  // only on return from checkout/portal — never on unrelated window focus.
  const pendingReturnPlan = useRef<BillingPlan | null>(null)
  const refreshing = useRef(false)

  const searchParams = useMemo(() => new URLSearchParams(window.location.search), [])

  useEffect(() => {
    if (!billingActive) return

    void (async () => {
      try {
        const publicConfig = await getBillingPublicConfig()
        setBillingPublicConfig(publicConfig)
        const summary = await getBillingSummary()
        setBillingSummary(summary)
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Could not load billing status.")
      }
    })()
  }, [billingActive])

  // Re-pull the authoritative plan: refresh the token (its claim is updated by
  // the Stripe webhook), re-derive the plan, and re-read the summary. Returns the
  // resolved plan so callers can detect when the webhook has landed. An in-flight
  // guard prevents two overlapping runs from racing on the summary write.
  const refreshBillingState = useCallback(async (): Promise<BillingPlan | null> => {
    if (refreshing.current) return null
    refreshing.current = true
    try {
      await refresh()
      const token = getAccessToken()
      if (!token) return null
      const plan = resolveBillingPlan(decodeJwt(token))
      setUserPlan(plan)
      setBillingSummary(await getBillingSummary())
      return plan
    } finally {
      refreshing.current = false
    }
  }, [setUserPlan])

  // Web: Stripe redirects the tab back to `?checkout=success`; refresh once.
  useEffect(() => {
    if (!billingActive) return
    if (refreshedAfterReturn.current) return
    if (searchParams.get("checkout") !== "success") return

    refreshedAfterReturn.current = true
    void refreshBillingState().catch(() =>
      setErrorMessage("Could not refresh billing plan after checkout."),
    )
  }, [billingActive, searchParams, refreshBillingState])

  // Desktop: Stripe opens in the OS browser, so the `?checkout=success` redirect
  // never reaches this webview. When the app window regains focus AFTER we sent
  // the user to Stripe (pendingReturnPlan set), re-pull the plan. The webhook may
  // lag the user's return, so poll a few times until the plan changes, then stop
  // — bounded so an unchanged plan (e.g. a portal visit with no purchase) can't
  // loop forever. Gated on the pending flag so ordinary alt-tabbing never
  // triggers a token refresh + fetch.
  useEffect(() => {
    if (!isTauri() || !billingActive) return
    let unlisten: (() => void) | undefined
    let cancelled = false

    const onReturn = async () => {
      const basePlan = pendingReturnPlan.current
      if (basePlan === null) return
      pendingReturnPlan.current = null
      try {
        for (let attempt = 0; attempt < 4 && !cancelled; attempt++) {
          const plan = await refreshBillingState()
          if (plan !== null && plan !== basePlan) break
          await new Promise((r) => setTimeout(r, 1500))
        }
      } catch {
        setErrorMessage("Could not refresh billing plan after checkout.")
      }
    }

    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      if (cancelled) return
      void getCurrentWindow()
        .onFocusChanged(({ payload: focused }) => {
          if (focused) void onReturn()
        })
        .then((un) => {
          if (cancelled) un()
          else unlisten = un
        })
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [billingActive, refreshBillingState])

  const onUpgrade = async (plan: PaidPlan) => {
    setErrorMessage(null)
    setBusyAction(plan === "basic" ? "upgrade-basic" : "upgrade-plus")
    try {
      // Desktop opens Stripe in the OS browser, which can't navigate back to the
      // tauri:// webview origin — omit the return URLs so the backend defaults
      // them to the hosted web app. Web keeps its origin-based round-trip.
      const body = isTauri()
        ? { plan }
        : {
            plan,
            success_url: `${window.location.origin}/settings/billing?checkout=success`,
            cancel_url: `${window.location.origin}/settings/billing?checkout=cancel`,
          }
      const data = await createCheckoutSession(body)
      if (!data.checkout_url) throw new Error("No checkout url returned")
      // Desktop: arm the focus-refresh so returning from the browser re-pulls
      // the plan (there's no redirect back into the webview).
      if (isTauri()) pendingReturnPlan.current = userPlan
      await openExternalUrl(data.checkout_url)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not create checkout session.")
    } finally {
      setBusyAction(null)
    }
  }

  const onManage = async () => {
    setErrorMessage(null)
    setBusyAction("manage")
    try {
      // Desktop: omit return_url so the backend defaults it to the hosted web
      // app (the OS browser can't return to the tauri:// origin). Web keeps it.
      // `createPortalSession({})` — not `()` — so apiFetch sends a JSON body; the
      // endpoint requires one (empty `{}` is valid: return_url is optional).
      const data = isTauri()
        ? await createPortalSession({})
        : await createPortalSession({ return_url: `${window.location.origin}/settings/billing` })
      if (!data.portal_url) throw new Error("No portal url returned")
      if (isTauri()) pendingReturnPlan.current = userPlan
      await openExternalUrl(data.portal_url)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not open billing portal.")
    } finally {
      setBusyAction(null)
    }
  }

  const formattedPeriodEnd =
    billingSummary?.current_period_end
      ? new Date(billingSummary.current_period_end).toLocaleDateString()
      : null

  const subscriptionStatus = useMemo(() => {
    if (billingSummary?.cancel_at_period_end) {
      return formattedPeriodEnd
        ? `Cancels on ${formattedPeriodEnd}`
        : "Cancels at period end"
    }
    return "Active"
  }, [billingSummary, formattedPeriodEnd])

  const formatPrice = (price: PriceInfo | undefined, fallback: string): string => {
    const rawAmount = price?.unit_amount
    const rawCurrency = price?.currency
    if (typeof rawAmount !== "number" || !rawCurrency) return fallback
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: rawCurrency.toUpperCase(),
      minimumFractionDigits: rawAmount % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(rawAmount / 100)
  }

  const basicPriceLabel = useMemo(
    () => formatPrice(billingPublicConfig?.basic_price, "€6.99"),
    [billingPublicConfig]
  )
  const plusPriceLabel = useMemo(
    () => formatPrice(billingPublicConfig?.plus_price, "€11.99"),
    [billingPublicConfig]
  )

  const basicIntervalLabel = billingPublicConfig?.basic_price?.interval || "month"
  const plusIntervalLabel = billingPublicConfig?.plus_price?.interval || "month"

  if (!billingActive) return null

  return (
    <div className="absolute inset-0 overflow-y-auto scrollbar-thin bg-background">
      <div className="mx-auto w-full max-w-7xl px-6 py-20 space-y-6">
        <div className="space-y-2">
          <h1 className="text-5xl leading-none">Billing Plans</h1>
          <p className="text-sm text-muted-foreground">
            Pick the plan that matches your workspace needs
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-3xl">Current subscription</CardTitle>
            <CardDescription>
              Choose your plan and manage your subscription
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground font-bold">Current Plan</span>
              <TierBadge plan={userPlan} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground font-bold">Status</span>
              <Badge
                variant="outline"
                className={[
                  "font-mono font-medium uppercase tracking-wide",
                  billingSummary?.cancel_at_period_end
                    ? "border-destructive/60 bg-destructive/10 text-destructive"
                    : "border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                ].join(" ")}
              >
                {subscriptionStatus}
              </Badge>
            </div>
          </CardContent>

          {billingSummary?.cancel_at_period_end ? (
            <CardContent className="pt-0">
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <div className="flex items-center gap-2">
                  <WarningIcon className="h-4 w-4 shrink-0" />
                  <span className="font-medium">
                    Access remains active until {formattedPeriodEnd ?? "the end of this period"}.
                  </span>
                </div>
              </div>
              <Button
                variant="outline"
                onClick={onManage}
                disabled={busyAction !== null}
                className="mt-3"
              >
                {busyAction === "manage" ? "Opening portal..." : "Resume Membership"}
              </Button>
            </CardContent>
          ) : null}
        </Card>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          <Card className="relative">
            <CardHeader>
              <div className="flex items-center gap-2">
                <CardTitle className="text-4xl font-semibold">Free</CardTitle>
                {userPlan === "free" ? (
                  <Badge variant="outline" className="w-fit bg-background/40 font-mono font-medium uppercase tracking-wide">
                    Current
                  </Badge>
                ) : null}
              </div>
              <CardDescription>Starter plan for personal exploration</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p className="text-3xl font-semibold text-foreground">Free</p>
              <FeatureRow icon={SparklesIcon} label="50 AI requests / day" />
              <FeatureRow icon={SparklesIcon} label="750 AI requests / month" />
              <FeatureRow icon={CardsThree} label="5 boards" />
              <FeatureRow icon={UsersThree} label="Up to 5 collaborators / board" />
              <FeatureRow icon={DocumentIcon} label="3 documents / board" />
              <FeatureRow icon={PuzzlePieceIcon} label="10 mini-apps / board" />
              <FeatureRow icon={ChatTranslateIcon} label="Lite models only" />
              <FeatureRow icon={Headset} label="Community support" />
              <p className="pt-2 text-xs leading-relaxed text-muted-foreground/80">
                Great for trying Dim0 and personal projects. Upgrade any time as your workspace grows.
              </p>
            </CardContent>
          </Card>

          <Card className="relative">
            <CardHeader>
              <div className="flex items-center gap-2">
                <CardTitle className="text-4xl font-semibold">Basic</CardTitle>
                {userPlan === "basic" ? (
                  <Badge variant="outline" className="w-fit bg-background/40 font-mono font-medium uppercase tracking-wide">
                    Current
                  </Badge>
                ) : null}
              </div>
              <CardDescription>For steady, everyday use</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-end gap-2">
                <span className="text-3xl font-semibold text-foreground">{basicPriceLabel}</span>
                <span className="text-sm text-muted-foreground">/ {basicIntervalLabel}</span>
              </div>
              <div className="space-y-2.5 text-sm text-muted-foreground">
                <FeatureRow icon={SparklesIcon} label="150 AI requests / day" />
                <FeatureRow icon={SparklesIcon} label="3,000 AI requests / month" />
                <FeatureRow icon={CardsThree} label="Unlimited boards" />
                <FeatureRow icon={UsersThree} label="Up to 10 collaborators / board" />
                <FeatureRow icon={DocumentIcon} label="10 documents / board" />
                <FeatureRow icon={PuzzlePieceIcon} label="20 mini-apps / board" />
                <FeatureRow icon={ChatTranslateIcon} label="Lite models (no top-tier AI)" />
                <FeatureRow icon={Headset} label="Standard support" />
              </div>

              {userPlan === "basic" ? (
                <Button
                  variant="outline"
                  onClick={onManage}
                  disabled={busyAction !== null}
                  className="w-full"
                >
                  {busyAction === "manage" ? "Opening portal..." : "Manage Subscription"}
                </Button>
              ) : userPlan === "plus" ? (
                // Existing subscriber → switch tier via the portal (not a new
                // checkout, which would create a second subscription).
                <Button
                  variant="outline"
                  onClick={onManage}
                  disabled={busyAction !== null}
                  className="w-full"
                >
                  {busyAction === "manage" ? "Opening portal..." : "Switch to Basic"}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => onUpgrade("basic")}
                  disabled={busyAction !== null}
                  className="w-full"
                >
                  {busyAction === "upgrade-basic" ? "Redirecting..." : "Choose Basic"}
                </Button>
              )}
            </CardContent>
          </Card>

          <Card className="relative border-secondary-foreground/60 bg-gradient-to-br from-secondary-foreground/20 via-secondary-foreground/10 to-card">
            <CardHeader>
              <div className="flex items-center gap-2">
                <AwardIcon className="h-6 w-6 text-secondary-foreground" strokeWidth={2} />
                <CardTitle className="text-4xl font-semibold">Plus</CardTitle>
                {userPlan === "plus" ? (
                  <Badge variant="outline" className="w-fit bg-background/40 font-mono font-medium uppercase tracking-wide">
                    Current
                  </Badge>
                ) : null}
              </div>
              <CardDescription>Best for active daily workflows</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-end gap-2">
                <span className="text-3xl font-semibold text-foreground">{plusPriceLabel}</span>
                <span className="text-sm text-muted-foreground">/ {plusIntervalLabel}</span>
              </div>
              <div className="space-y-2.5 text-sm text-muted-foreground">
                <FeatureRow icon={SparklesIcon} label="Unlimited AI requests" />
                <FeatureRow icon={CardsThree} label="Unlimited boards" />
                <FeatureRow icon={UsersThree} label="Up to 20 collaborators / board" />
                <FeatureRow icon={DocumentIcon} label="25 documents / board" />
                <FeatureRow icon={PuzzlePieceIcon} label="100 mini-apps / board" />
                <FeatureRow icon={SparklesFeatureIcon} label="Frontier models: GPT, Claude, Gemini & more" />
                <FeatureRow icon={Headset} label="Priority support" />
              </div>

              {userPlan === "plus" ? (
                <Button
                  variant="outline"
                  onClick={onManage}
                  disabled={busyAction !== null}
                  className="w-full bg-background/30 border-foreground/60"
                >
                  {busyAction === "manage" ? "Opening portal..." : "Manage Subscription"}
                </Button>
              ) : userPlan === "basic" ? (
                // Existing subscriber → upgrade via the portal so Stripe swaps
                // the plan instead of opening a second subscription.
                <Button
                  onClick={onManage}
                  disabled={busyAction !== null}
                  className="w-full"
                >
                  {busyAction === "manage" ? "Opening portal..." : "Switch to Plus"}
                </Button>
              ) : (
                <Button
                  onClick={() => onUpgrade("plus")}
                  disabled={busyAction !== null}
                  className="w-full"
                >
                  {busyAction === "upgrade-plus" ? "Redirecting..." : "Upgrade to Plus"}
                </Button>
              )}
            </CardContent>
          </Card>
        </div>

        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <span>Prefer to run it yourself? Dim0 is open source (MIT).</span>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline"
          >
            <GithubLogo className="h-3.5 w-3.5" weight="fill" />
            Get the code on GitHub →
          </a>
        </p>

        {errorMessage ? (
          <p className="text-sm text-destructive">{errorMessage}</p>
        ) : null}
      </div>
    </div>
  )
}
