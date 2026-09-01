// src/router/index.tsx
import {
  createRouter,
  createRootRoute,
  createRoute,
  redirect,
} from "@tanstack/react-router"
import { RootLayout } from "./root-layout"
import { ChatScreen } from "@/features/agent/screens/chat-screen"
import { BoardScreen } from "@/features/board/screens/board-screen"
import { SigninPage } from "@/features/signin/screens/sign-in"
import { SignupPage } from "@/features/signin/screens/sign-up"
import { GoogleCallbackPage } from "@/features/signin/screens/google-callback"
import { clearTokens, getAccessToken } from "@/features/signin/auth-storage"
import { decodeJwt } from "@/lib/decode-jwt"
import { getEmailVerificationStatus } from "@/api"
import { SubscriptionsScreen } from "@/features/newsfeed/screens/subscriptions"
import { NewsfeedsScreen } from "@/features/newsfeed/screens/newsfeeds"
import { NewsfeedLinearPage } from "@/features/newsfeed/screens/newsfeed-linear-page"
import { IndexHome } from "@/features/home/screens/index-home"
import { DashboardScreen } from "@/features/board/screens/dashboard-screen"
import { NotFoundPage } from "@/components/not-found"
import { SettingsScreen } from "@/features/user-settings/screens/settings-screen"
import { BillingScreen } from "@/features/user-settings/screens/billing-screen"
import { VerifyEmailPage } from "@/features/signin/screens/verify-email"
import { ForgotPasswordPage } from "@/features/signin/screens/forgot-password"
import { ResetPasswordPage } from "@/features/signin/screens/reset-password"
import { InstallScreen } from "@/features/install/screens/install-screen"
import { ShareLandingScreen } from "@/features/sharing/screens/share-landing"
import { LocalBoardScreen } from "@/features/board/local/local-board-screen"


export const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
})

// --- auth guard ---
const requireAuth = () => {
  const token = getAccessToken()
  if (!token) throw redirect({ to: "/signin" })
  try {
    const payload = decodeJwt(token)
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      clearTokens()
      throw redirect({ to: "/signin" })
    }
  } catch {
    clearTokens()
    throw redirect({ to: "/signin" })
  }
}


const requireVerifiedAuth = async () => {
  requireAuth()
  try {
    const status = await getEmailVerificationStatus()
    if (status.enabled && !status.verified) {
      throw redirect({ to: "/verify-email" })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("404") && message.includes("User not found")) {
      clearTokens()
      throw redirect({ to: "/signin" })
    }
    throw error
  }
}

// auth pages (unguarded)
const signinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signin",
  component: SigninPage,
})

const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signup",
  component: SignupPage,
})

const googleCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signin/google/callback",
  component: GoogleCallbackPage,
})

const verifyEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/verify-email",
  beforeLoad: requireAuth,
  component: VerifyEmailPage,
})

const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/forgot-password",
  component: ForgotPasswordPage,
})

const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  component: ResetPasswordPage,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  // The front door is open: signed-out users land on the local dashboard.
  // Only enforce auth/email-verification once a user is genuinely signed in. A
  // missing OR stale/expired token is treated as logged-out (clear + fall
  // through) so the front door never bounces to /signin.
  beforeLoad: async () => {
    const token = getAccessToken()
    if (!token) return
    try {
      const payload = decodeJwt(token)
      if (payload.exp && payload.exp * 1000 < Date.now()) {
        clearTokens()
        return
      }
    } catch {
      clearTokens()
      return
    }
    await requireVerifiedAuth()
  },
  component: IndexHome,
})

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/home",
  beforeLoad: () => { throw redirect({ to: "/" }) },
})

// /chats (protected)
export const NewChatUrl = "/chats"
const chatsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: NewChatUrl,
  beforeLoad: requireVerifiedAuth,
  component: ChatScreen,
})

// /chats/:id (protected)
export const ChatUrl = "/chats/$id"
const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ChatUrl,
  beforeLoad: requireVerifiedAuth,
  component: ChatScreen,
})

// /boards (protected)
export const DashboardUrl = "/boards"
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: DashboardUrl,
  beforeLoad: requireVerifiedAuth,
  component: DashboardScreen,
})

// /boards/:id (protected). Surface routes (sheets/$noteId,
// code-sandbox/$noteId, widgets/$noteId) are *children* of this route,
// not siblings — that way navigating into / out of a surface keeps the
// parent (BoardScreen + canvas) mounted instead of unmounting React
// Flow and re-running the board-hydration effect each time.
export const BoardUrl = "/boards/$id"
const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: BoardUrl,
  beforeLoad: requireVerifiedAuth,
  component: BoardScreen,
})

// /boards/:id/sheets/:noteId — child of boardRoute. The component is
// intentionally null: BoardScreen reads URL state via
// `useActiveSurfaceFromUrl` and mounts the panel itself.
export const SheetUrl = "/boards/$id/sheets/$noteId"
const sheetRoute = createRoute({
  getParentRoute: () => boardRoute,
  path: "/sheets/$noteId",
  component: () => null,
})

// /boards/:id/code-sandbox/:noteId — child of boardRoute.
export const CodeSandboxUrl = "/boards/$id/code-sandbox/$noteId"
const codeSandboxRoute = createRoute({
  getParentRoute: () => boardRoute,
  path: "/code-sandbox/$noteId",
  component: () => null,
})

// /boards/:id/widgets/:noteId — child of boardRoute.
export const WidgetUrl = "/boards/$id/widgets/$noteId"
const widgetRoute = createRoute({
  getParentRoute: () => boardRoute,
  path: "/widgets/$noteId",
  component: () => null,
})

// /boards/:id/mini-apps/:noteId — child of boardRoute. Same shape as
// widgetRoute: BoardScreen owns rendering via useActiveSurfaceFromUrl.
export const MiniAppUrl = "/boards/$id/mini-apps/$noteId"
const miniAppRoute = createRoute({
  getParentRoute: () => boardRoute,
  path: "/mini-apps/$noteId",
  component: () => null,
})

// /subscriptions (protected)
export const SubscriptionsUrl = "/subscriptions"
const subscriptionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: SubscriptionsUrl,
  beforeLoad: requireVerifiedAuth,
  component: SubscriptionsScreen,
})

// /subscriptions/:id/newsfeeds (protected)
export const NewsfeedsUrl = "/subscriptions/$id"
const newsfeedsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: NewsfeedsUrl,
  beforeLoad: requireVerifiedAuth,
  component: NewsfeedsScreen,
})

/**
 * /subscriptions/:id/newsfeeds/:newsfeedId → single newsletter
 * (child of the list route, same file for convenience)
 */
export const NewsfeedDetailUrl = "/subscriptions/$id/newsfeeds/$newsfeedId"
const newsfeedDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: NewsfeedDetailUrl,
  beforeLoad: requireVerifiedAuth,
  component: NewsfeedLinearPage
})

export const SettingsUrl = "/settings"
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: SettingsUrl,
  beforeLoad: requireVerifiedAuth,
  component: SettingsScreen,
})

export const SettingsBillingUrl = "/settings/billing"
const settingsBillingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: SettingsBillingUrl,
  beforeLoad: requireVerifiedAuth,
  component: BillingScreen,
})

export const InstallUrl = "/install"
const installRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: InstallUrl,
  beforeLoad: requireVerifiedAuth,
  component: InstallScreen,
})

// /share/:token — share-link landing page. Intentionally *unguarded*:
// the screen itself handles the "not signed in" case by stashing the
// token and routing through /signin. Verified-auth gating would 404
// the very users we want to onboard.
export const ShareLandingUrl = "/share/$token"
const shareLandingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ShareLandingUrl,
  component: ShareLandingScreen,
})

// /local + /local/:boardId — local-only boards. Intentionally UNGUARDED:
// no account required, no backend. The whole point of Phase A.
export const LocalDashboardUrl = "/local"
const localDashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: LocalDashboardUrl,
  // Same unified dashboard as `/boards`, but unguarded: a signed-out user lands
  // here and sees the on-device group only (the synced group needs an account).
  component: DashboardScreen,
})

export const LocalBoardUrl = "/local/$boardId"
const localBoardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: LocalBoardUrl,
  component: LocalBoardScreen,
})

// Local surface routes mirror the synced `/boards/$id/*` children (same
// null-component pattern): LocalBoardScreen reads URL state via
// `useHarnessSurfaceFromUrl(local)` and mounts the panel over the still-mounted
// canvas. Param is `$boardId` (not `$id`).
export const LocalSheetUrl = "/local/$boardId/sheets/$noteId"
const localSheetRoute = createRoute({
  getParentRoute: () => localBoardRoute,
  path: "/sheets/$noteId",
  component: () => null,
})

export const LocalCodeSandboxUrl = "/local/$boardId/code-sandbox/$noteId"
const localCodeSandboxRoute = createRoute({
  getParentRoute: () => localBoardRoute,
  path: "/code-sandbox/$noteId",
  component: () => null,
})

export const LocalWidgetUrl = "/local/$boardId/widgets/$noteId"
const localWidgetRoute = createRoute({
  getParentRoute: () => localBoardRoute,
  path: "/widgets/$noteId",
  component: () => null,
})

export const LocalMiniAppUrl = "/local/$boardId/mini-apps/$noteId"
const localMiniAppRoute = createRoute({
  getParentRoute: () => localBoardRoute,
  path: "/mini-apps/$noteId",
  component: () => null,
})

const routeTree = rootRoute.addChildren([
  localDashboardRoute,
  localBoardRoute.addChildren([
    localSheetRoute,
    localCodeSandboxRoute,
    localWidgetRoute,
    localMiniAppRoute,
  ]),
  signinRoute,
  signupRoute,
  googleCallbackRoute,
  verifyEmailRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  indexRoute,
  homeRoute,
  chatsIndexRoute,
  chatRoute,
  dashboardRoute,
  boardRoute.addChildren([sheetRoute, codeSandboxRoute, widgetRoute, miniAppRoute]),
  subscriptionsRoute,
  newsfeedsRoute,
  newsfeedDetailRoute,
  settingsRoute,
  settingsBillingRoute,
  installRoute,
  shareLandingRoute,
])

export const router = createRouter({ routeTree })
export type AppRouter = typeof router
