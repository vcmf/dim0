import type { BoardSyncHandle } from "./board-sync"


/**
 * Module ref to the active synced board's sync coordinator. Mirrors
 * `board-persistence-ref` so code outside the harness (e.g. a headless,
 * cross-layer writer) can enter the sync-correct local-batch intake
 * (`submitLocalBatch(batch, { scene: false })`) instead of writing the oplog
 * directly — a direct write skips the send trigger, so the batch ships only
 * opportunistically on the next unrelated pump and desyncs a synced board.
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
