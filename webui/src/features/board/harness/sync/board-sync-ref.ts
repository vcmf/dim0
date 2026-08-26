import type { BoardSyncHandle } from "./board-sync"


/**
 * Module ref to the active synced board's sync coordinator. Mirrors
 * `board-persistence-ref` so code outside the harness (e.g. a headless,
 * cross-layer writer) can enter the ONE sync-correct local-batch intake
 * (`submitLocalBatch`) instead of writing the oplog directly — which would
 * skip the rebase set + send trigger and desync a synced board.
 *
 * Set by the v2 sync mount, cleared on unmount / scope change. `null` on a
 * purely local board (no relay) — callers fall back to the persistence ref,
 * which is sync-correct there because a local board has no outbox to desync.
 */
let _sync: BoardSyncHandle | null = null


export const setBoardSyncRef = (s: BoardSyncHandle | null): void => {
  _sync = s
}


export const getBoardSyncRef = (): BoardSyncHandle | null => _sync
