/**
 * Mount the offline-first coordinator on a synced board (syncEngine=v2).
 *
 * The v2 sibling of `use-ws-collab`: instead of a thin adapter over a server-
 * authoritative graph, it runs a local IndexedDB replica (BoardPersistence) +
 * `attachBoardSync` over a real WebSocket, with reconnect supervision, snapshot
 * hydration, and inbound theme/geometry normalization. Enabled only when the
 * board is flagged v2 (see `sync-engine-flag`); otherwise a no-op so legacy
 * boards are completely untouched.
 *
 * Hydration reuses `applyGraphToStore` (one `origin:"remote"` batch → no echo).
 * The local replica gives the outbox its offline durability, and the store is
 * painted from it on load so a board isn't blank offline. On first open the WHOLE
 * board (all layers) is seeded into the local base via `materializeBoardOffline`
 * — so every subboard is offline-readable, not just the opened layer. Replacing a
 * base on reconnect drift is a follow-up (roadmap).
 */
import { useEffect, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { CanvasStore } from "@canvas-harness/core"
import camelcaseKeys from "camelcase-keys"
import { API_URL } from "@/config/api"
import { mintCollabTicket } from "@/features/board/api/collab-ticket"
import type { BoardRole } from "@/features/board/api/get-board"
import { getLocalStores } from "@/features/local-stores"
import { useAppStore } from "@/store"
import type { Graph } from "@/features/board/types/board"
import { buildLocalPresence } from "./presence-identity"
import { BoardPersistence } from "@/features/board/persist/local/board-persistence"
import { setBoardPersistenceRef } from "@/features/board/persist/local/board-persistence-ref"
import { normalizeInboundBatch } from "../sync/inbound-normalize"
import { enrichEdgeMidpoints } from "../sync/outbound-enrich"
import { dedupeRepeatUpdates } from "../sync/outbound-dedupe"
import { ReconnectSupervisor } from "../sync/reconnect-supervisor"
import { attachBoardSync } from "../sync/board-sync"
import type { BoardSyncHandle } from "../sync/board-sync"
import { setBoardSyncRef } from "../sync/board-sync-ref"
import { createWebSocketRelay } from "../sync/ws-relay"
import { applyGraphToStore } from "../persist/snapshot-load"
import { applyContentToStore } from "@/features/board/persist/local/apply-content"
import { materializeBoardOffline } from "@/features/board/persist/local/materialize-board"
import { boardOfflineKey } from "@/features/board/api/board-offline-status"


const wsBaseFromApiUrl = (apiUrl: string): string => apiUrl.replace(/^http/i, "ws")


/** Wire a v2 synced board to the relay via the offline-first coordinator. */
export const useBoardSyncV2 = (
  store: CanvasStore,
  boardId: string | null,
  enabled: boolean,
  rootId: string | null,
  // Reports the caller's board role, resolved from the collab ticket at connect
  // time. The v2 hydrate path can't compute canEdit/role itself (it skips the
  // REST hydrate), so it defaults to read-only and upgrades via this callback.
  onRole?: (role: BoardRole) => void,
): void => {
  const userEmail = useAppStore((s) => s.userEmail)
  const userId = useAppStore((s) => s.userId)
  // Held in refs so neither a fresh inline `onRole` nor a new QueryClient
  // identity re-runs the mount effect (which would tear down + rebuild the whole
  // coordinator: stop the supervisor, detach sync, flush+close persistence).
  const onRoleRef = useRef(onRole)
  onRoleRef.current = onRole
  const queryClient = useQueryClient()
  const queryClientRef = useRef(queryClient)
  queryClientRef.current = queryClient

  useEffect(() => {
    if (!enabled || !boardId) return
    let cancelled = false
    let handle: BoardSyncHandle | null = null
    let supervisor: ReconnectSupervisor | null = null
    let persistence: BoardPersistence | null = null
    let detachPersist: (() => void) | null = null

    void getLocalStores()
      .then((stores) => {
        if (cancelled) return
        persistence = new BoardPersistence(boardId, { engine: stores.engine })
        setBoardPersistenceRef(persistence)
        return persistence.load().then((content) => {
          if (cancelled || !persistence) return
          // Paint from the local replica so a synced board isn't blank offline
          // (or before the welcome arrives). Applied as one remote batch (no
          // echo/persist) and BEFORE attach, so it isn't recorded; the welcome
          // merges authoritative state on top when online. Projected to the
          // current layer like a local board — persistence stays whole-board.
          // Called unconditionally (like the local branch): a no-op on empty
          // content, and restores groups/frame layout too, not just nodes/edges.
          applyContentToStore(store, content, rootId ?? null)
          detachPersist = persistence.attach(store) // local replica: outbox + durable edits
          // Seed the WHOLE board offline (all layers, not just the opened one).
          // Reuse this mounted persistence (single writer). Self-guarding +
          // best-effort: seeds whenever fully synced (an all-acked oplog seeds
          // too, not just a pristine one); defers on an unsent-local edit or a
          // relay op mid-fetch; a rejection (offline) just means "not this time".
          void materializeBoardOffline(boardId, {
            engine: stores.engine,
            persistence,
          })
            .then((wrote) => {
              // Flip the sidebar's offline marker to "ready" without waiting for
              // the status query's staleTime.
              if (wrote) void queryClientRef.current.invalidateQueries({ queryKey: boardOfflineKey(boardId) })
            })
            .catch(() => {})
          const clientId = store.clientId
          // Seed local presence identity (name + color). Cursor/selection are
          // filled in live by useLocalPresence; attachSync ships changes to peers.
          store.presence.setLocal(buildLocalPresence(userEmail, userId, clientId))
          const supe = new ReconnectSupervisor({ reconnect: () => handle?.reconnect() })
          supervisor = supe
          handle = attachBoardSync({
            store,
            persistence,
            engine: stores.engine,
            boardId,
            clientId,
            connect: (sinceSeq) => {
              supe.onConnecting()
              return createWebSocketRelay({
                boardId,
                clientId,
                sinceSeq,
                rootId: rootId ?? undefined,
                mintTicket: async (id) => {
                  const { ticket, role } = await mintCollabTicket(id)
                  // Ignore a mint that resolved after this board's effect was torn
                  // down (rapid board switch) — else a stale role would clobber the
                  // now-current board's state on the singleton store.
                  if (!cancelled) onRoleRef.current?.(role)
                  return ticket
                },
                wsUrl: (path) => `${wsBaseFromApiUrl(API_URL)}${path}`,
                onClose: (code) => supe.onClose(code),
              })
            },
            onWelcome: () => supe.onWelcome(),
            onSnapshot: (snapshot) => {
              // Server ships snake_case; the converters expect camelCase (same as
              // the REST path). Merge mode: never wipe on an empty/partial payload.
              // This is the live per-layer welcome; the offline base is seeded
              // separately from the WHOLE board (materializeBoardOffline above).
              const graph = camelcaseKeys(
                snapshot as Record<string, unknown>,
                { deep: true },
              ) as unknown as Graph
              applyGraphToStore(store, graph, { mode: "merge" })
            },
            normalizeRemote: (batch) => normalizeInboundBatch(batch, store),
            enrichOutbound: (batch) => enrichEdgeMidpoints(dedupeRepeatUpdates(batch), store),
            coalesceMs: 75, // merge a burst (e.g. rotate's per-tick ops) into one send
          })
          // Publish the sync-correct intake so headless/cross-layer writers enter
          // the same rebase + send path instead of writing the oplog directly.
          setBoardSyncRef(handle)
        })
      })
      .catch((err) => {
        if (!cancelled) console.error("[sync-v2] mount failed", err)
      })

    const onVisibility = (): void => {
      if (document.visibilityState === "visible") supervisor?.retryNow()
    }
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", onVisibility)
      supervisor?.stop()
      setBoardSyncRef(null)
      handle?.detach()
      detachPersist?.()
      setBoardPersistenceRef(null)
      const p = persistence
      if (p) void p.flush().finally(() => p.close())
    }
  }, [store, boardId, enabled, rootId, userEmail, userId])
}
