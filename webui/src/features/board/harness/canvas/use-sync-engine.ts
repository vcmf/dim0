/**
 * Resolve which collab client a synced board mounts: the offline-first
 * coordinator (`v2`) or the legacy `use-ws-collab` (`legacy`).
 *
 * Source of truth is the board's `BoardMeta.syncEngine` (persisted in the local
 * registry). The `dim0SyncV2` localStorage flag stays as a dev/testing override
 * that forces v2 on any board — it wins over the stored engine. A board with no
 * local meta and no override resolves to `v2` (the default as of Phase 1 of the
 * backend-agent retirement); a board can still be pinned to the legacy client
 * with an explicit `syncEngine: "legacy"` (an escape hatch during rollout).
 */
import { useEffect, useState } from "react"
import { isLocalAgentOnSynced } from "@/features/agent/local/local-agent-flag"
import type { BoardMeta } from "@/features/board/model"
import { getLocalStores } from "@/features/local-stores"
import { isBoardSyncV2 } from "../sync/sync-engine-flag"


export type SyncEngine = "legacy" | "v2"


/** Pure engine resolution: dev override wins, else stored engine, else v2 (default). */
export const resolveSyncEngine = (
  meta: BoardMeta | undefined,
  devOverride: boolean,
): SyncEngine => (devOverride ? "v2" : (meta?.syncEngine ?? "v2"))


/**
 * Resolve a synced board's engine, reading `BoardMeta` from the local registry.
 * Returns `null` while resolving (and always for `local-only` boards, which
 * don't run a collab client) so callers can defer mounting until the choice is
 * known — avoids briefly mounting the legacy client then swapping to v2.
 */
export const useSyncEngine = (
  boardId: string | null,
  local: boolean,
): SyncEngine | null => {
  const [engine, setEngine] = useState<SyncEngine | null>(null)

  useEffect(() => {
    if (local || !boardId) {
      setEngine(null)
      return
    }
    // Dev override is synchronous — no registry read needed.
    if (isBoardSyncV2(boardId)) {
      setEngine("v2")
      return
    }
    let cancelled = false
    setEngine(null)
    void getLocalStores()
      .then((stores) => stores.boards.getBoard(boardId))
      .then((meta) => {
        if (!cancelled) setEngine(resolveSyncEngine(meta, false))
      })
      .catch(() => {
        if (!cancelled) setEngine("v2") // default engine; consistent with resolveSyncEngine
      })
    return () => {
      cancelled = true
    }
  }, [boardId, local])

  return engine
}


/**
 * Whether the browser agent is the active runtime for a board, given its
 * `syncEngine`. Always on for local-only boards (`local`). On a synced board it's
 * on UNLESS the engine is a confirmed `legacy` pin: v2 is the default, so a board
 * still resolving (`null`) is treated optimistically as v2 rather than starting
 * on the backend agent and swapping to the browser agent once v2 resolves — that
 * swap would fire on every v2 board load and could orphan a turn sent mid-swap.
 *
 * Only an explicit, RESOLVED `legacy` pin routes a board to the backend agent:
 * the legacy WS relay has no DB persistence, so a browser-agent edit there would
 * be lost on reload. The optimistic `null` window is safe because a synced board
 * is still loading then (store empty, no collab client mounted), so there is no
 * real content to edit or lose until the engine resolves.
 */
export const browserAgentActiveFor = (
  local: boolean,
  syncEngine: SyncEngine | null,
): boolean => local || (isLocalAgentOnSynced() && syncEngine !== "legacy")


/**
 * Hook form of {@link browserAgentActiveFor} for callers that don't already hold
 * the resolved engine — resolves it from the local registry via `useSyncEngine`.
 */
export const useBrowserAgentActive = (
  boardId: string | null,
  local: boolean,
): boolean => browserAgentActiveFor(local, useSyncEngine(boardId, local))
