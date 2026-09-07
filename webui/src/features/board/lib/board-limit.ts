import type { BillingPlan } from "@/lib/decode-jwt"
import { useAppStore } from "@/store"
import { useListBoards } from "../api/list-boards"


// Backend-authoritative billing gate (flag AND Stripe keys, never the raw VITE
// flag — see docs/adr/ADR-BILLING-001). This is a NON-reactive read: the pure
// helpers use it for correctness at call time (create paths read fresh here),
// but a component that must RE-RENDER when billingActive flips (e.g. after boot
// hydration) MUST also select `s.billingActive` itself — see
// useIsBoardCreationLimited / NewBoardItem.
const billingActive = (): boolean => useAppStore.getState().billingActive


// ----------------------------------------------------------------------------
// Workspace-level: number of boards a user may own (per-plan, `Infinity` = unlimited).
// ----------------------------------------------------------------------------
export const BOARD_LIMITS: Record<BillingPlan, number> = {
  free: 5,
  basic: Infinity,
  plus: Infinity,
}

// Back-compat alias still referenced by some components.
export const FREE_PLAN_BOARD_LIMIT = BOARD_LIMITS.free

export const FREE_PLAN_BOARD_LIMIT_TOOLTIP =
  "Board limit reached for your plan. Upgrade for more boards, or self-host for your own unlimited setup."


export function boardLimitForPlan(plan: BillingPlan): number {
  return BOARD_LIMITS[plan]
}


export function isBoardCreationLimited(plan: BillingPlan, boardCount: number): boolean {
  return billingActive() && boardCount >= BOARD_LIMITS[plan]
}


/**
 * Reactive variant of `isBoardCreationLimited` for UI gating.
 * Reuses the cached `listBoards` query so it doesn't trigger extra fetches.
 */
export function useIsBoardCreationLimited(): boolean {
  const userId = useAppStore((s) => s.userId)
  const userPlan = useAppStore((s) => s.userPlan)
  // Subscribe to billingActive so the gate re-renders when the boot fetch flips
  // it (e.g. flag-on-but-keyless self-host: seeded true → hydrated false).
  const billingActive = useAppStore((s) => s.billingActive)
  const { data: boards = [] } = useListBoards(userId)
  return billingActive && isBoardCreationLimited(userPlan, boards.length)
}


// ----------------------------------------------------------------------------
// Per-board node-count limits. One registry, keyed by canvas node type.
// An entry is either a per-plan map (a paywall lever that vanishes when billing
// is off) or a single number (a universal product guardrail that always applies).
// Add a future "X per board" limit by adding one line here.
// ----------------------------------------------------------------------------
type PlanLimits = Record<BillingPlan, number>

export const NODE_LIMITS: Record<string, PlanLimits | number> = {
  document: { free: 3, basic: 10, plus: 25 },
  "mini-app": { free: 10, basic: 20, plus: 100 },
  "code-sandbox": { free: 30, basic: 60, plus: 300 },
  folder: 10, // universal: sub-boards per level (all plans, incl. self-host)
}


/**
 * Effective per-board limit for a node type given the user's plan, or `null`
 * when unlimited. Per-plan limits return `null` while billing is off (OSS);
 * universal (numeric) limits always apply.
 */
export function nodeLimitFor(type: string, plan: BillingPlan): number | null {
  const entry = NODE_LIMITS[type]
  if (entry === undefined) return null
  if (typeof entry === "number") return entry
  if (!billingActive()) return null
  return entry[plan]
}


export function isNodeTypeAtLimit(type: string, plan: BillingPlan, count: number): boolean {
  const limit = nodeLimitFor(type, plan)
  return limit !== null && count >= limit
}


// ----------------------------------------------------------------------------
// Folder nesting depth (universal): root(0) -> child(1) -> child-of-child(2).
// A 4th level is not allowed, so a sub-board can only be created at depth < 2.
// `currentFolderDepth` lives on board-app-store (set by the board breadcrumb).
// ----------------------------------------------------------------------------
export const MAX_BOARD_DEPTH = 2


export function canCreateSubBoard(currentFolderDepth: number): boolean {
  return currentFolderDepth < MAX_BOARD_DEPTH
}
