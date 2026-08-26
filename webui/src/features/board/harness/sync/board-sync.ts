/**
 * Board sync coordinator (E1.3) — the offline-first client.
 *
 * Ties the live store, local persistence, the outbox, and a `RelayConnection`
 * into one loop:
 *   - local edits are persisted (outbox) and pumped to the relay when connected;
 *   - the relay's `op-applied` advances the durable synced cursor and stamps the
 *     batch's `serverSeq` (its position in the shared total order);
 *   - `peer-op` / `welcome` batches are persisted (`recordRemote`, with their
 *     relay `seq`) and applied via a rebase (see below), so a reload reconstructs
 *     the converged state;
 *   - on reconnect the outbox replays (idempotent at the relay by `batch.id`) and
 *     `hello { since_seq }` fetches missed remote ops.
 *
 * Conflict resolution (E1.4) — server-sequenced per-field LWW. A remote op isn't
 * applied naively: local edits are applied optimistically, so arrival order can
 * differ from relay order. We *rebase* — undo the unacked local batches, apply
 * the remote op onto the confirmed base, then replay the local batches on top —
 * so a local edit always lands after (higher seq than) everything it hasn't yet
 * been sequenced against. Combined with `serverSeq`-ordered replay at load, live
 * and reloaded state converge identically. A referential-integrity pass then
 * drops any edge left dangling by a concurrent node delete.
 *
 * The send source is the outbox, not `attachSync.sendBatch` (which only pumps) —
 * so a batch is only ever sent with a known oplog seq, and acks map cleanly to
 * the cursor. Transport-agnostic: the same code runs against the in-memory relay
 * (tests) and the real WebSocket (E1.5).
 */
import { attachSync, inverseBatch } from "@canvas-harness/core"
import type {
  CanvasStore,
  ClientId,
  OpBatch,
  PresencePatch,
  PresenceState,
  SyncAdapter,
} from "@canvas-harness/core"
import { BoardOutbox } from "@/features/board/persist/local/board-outbox"
import type { OplogRecord } from "@/features/board/persist/local/idb"
import type { BoardPersistence } from "@/features/board/persist/local/board-persistence"
import type { StorageEngine } from "@/features/board/persist/local/engine"
import { pruneDanglingEdges } from "@/features/board/persist/local/integrity"
import type { InboundMessage, RelayConnection } from "./wire"


export type BoardSyncOptions = {
  store: CanvasStore
  /** Already attached to `store` by the caller (records local batches). */
  persistence: BoardPersistence
  engine: StorageEngine
  boardId: string
  clientId: ClientId
  /**
   * Opens a fresh connection to the relay (called on attach + each reconnect).
   * `sinceSeq` is the highest relay seq seen so far — passed at connect time
   * (the real WS carries it as a query param) so the relay picks the welcome
   * mode (snapshot / catch-up / live).
   */
  connect: (sinceSeq: number) => RelayConnection
  /**
   * Hydrate the local replica from a `snapshot`-mode welcome (first connect /
   * drift). Opaque here — the caller knows the server's snapshot shape. Omit in
   * pure-harness tests where the relay never sends a snapshot.
   */
  onSnapshot?: (snapshot: unknown, seq: number) => void
  /** Fired on every welcome (any mode) — the connection is healthy. */
  onWelcome?: () => void
  /**
   * Normalize a remote batch before it's applied to the store (theme colors,
   * edge geometry). Mutates the passed copy — the coordinator applies it but
   * persists the raw batch. Omit in the harness (batches are already local-shaped).
   */
  normalizeRemote?: (batch: OpBatch) => void
  /**
   * Transform a local batch just before it's sent to the relay (e.g. attach the
   * server's `_midpoint` curve rep). Returns the batch to send (a clone, or the
   * original unchanged) — the raw oplog is untouched. Omit in the harness.
   */
  enrichOutbound?: (batch: OpBatch) => OpBatch
  /**
   * Debounce window (ms) for coalescing outbound sends. Local edits made within
   * the window are merged into ONE relay message (their ops concatenated +
   * deduped by `enrichOutbound`), so a per-tick gesture flood (rotate writes one
   * op per pointermove) doesn't ship dozens of frames. 0 (default) sends each
   * batch immediately — the harness uses 0 for determinism.
   */
  coalesceMs?: number
}


export type BoardSyncHandle = {
  /**
   * The single sync-correct intake for a locally-produced batch: track it as an
   * unacked rebase entry and trigger a pump. The store producer (via
   * `attachSync.sendBatch`) is one caller; a headless / off-scene producer is
   * another — both share the same rebase set + send path, so nothing desyncs.
   * The batch must already be recorded to the oplog (the store path is recorded
   * by `persistence`; a headless caller records before submitting).
   */
  submitLocalBatch: (batch: OpBatch) => void
  /** Detach sync + persistence wiring and close the connection. */
  detach: () => void
  /** Simulate going offline (close connection; keep editing locally). */
  disconnect: () => void
  /** Reconnect: replay the outbox and catch up on missed remote ops. */
  reconnect: () => void
  /** Resolve once all queued async work (persist, ack, pump) has settled. */
  settle: () => Promise<void>
}


/** Wire a board's store to the relay with an offline-durable outbox. */
export const attachBoardSync = (opts: BoardSyncOptions): BoardSyncHandle => {
  const outbox = new BoardOutbox(opts.engine, opts.boardId)
  const presenceListeners = new Set<(id: ClientId, s: PresenceState | null) => void>()

  let connection: RelayConnection | null = null
  let clientSeq = 0
  let lastServerSeq = 0
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null
  // client_seq → the oplog seqs + batch ids that send covered. Coalescing sends
  // ONE message for many records, so a single ack advances the cursor over all
  // of them (markSyncedTo(max) is monotonic → reconnect won't re-send them).
  const inFlight = new Map<number, { seqs: number[]; batchIds: string[] }>()
  const rejected = new Set<number>() // oplog seqs the relay refused (don't resend)
  // Unacked local batches, in commit order — the rebase set (applied on top of
  // every remote op so local edits stay "latest"). Keyed by batch id; Map keeps
  // insertion order for undo (reverse) / replay (forward).
  const pending = new Map<string, OpBatch>()

  // Serialize async work so `settle()` can await a quiescent state in tests.
  let work: Promise<void> = Promise.resolve()
  const enqueue = (fn: () => Promise<void> | void): void => {
    work = work.then(fn)
  }

  /**
   * Apply a relay batch via rebase: undo unacked local ops, apply the remote op
   * onto the confirmed base, replay the local ops on top, prune dangling edges,
   * then persist the remote op with its `serverSeq`. All store writes use
   * `origin: "remote"` so nothing echoes back to the relay or re-persists.
   */
  const applyRemote = (batch: OpBatch, serverSeq: number): void => {
    // Self-echo guard: never apply our own batch back. The relay excludes the
    // sender today, so this is defensive — but without it, an echoed batch would
    // be applied as `remote` on top of the identical entry in `pending` (double
    // apply via the rebase). Covers both peer-op and welcome catch-up.
    if (batch.clientId === opts.clientId) return
    // Apply a NORMALIZED copy (theme colors + edge geometry) to the store, but
    // persist the RAW batch — the raw carries theme-independent `_storedColors`,
    // so a reload re-normalizes to whatever theme is active then. Skipping the
    // clone when there's no normalizer keeps the harness path allocation-free.
    let toApply = batch
    if (opts.normalizeRemote) {
      toApply = structuredClone(batch)
      opts.normalizeRemote(toApply)
    }
    const pend = [...pending.values()]
    for (let i = pend.length - 1; i >= 0; i--) {
      opts.store.applyBatch({ ...pend[i], ops: inverseBatch(pend[i]), origin: "remote" })
    }
    opts.store.applyBatch({ ...toApply, origin: "remote" })
    for (const p of pend) opts.store.applyBatch({ ...p, origin: "remote" })
    pruneDanglingEdges(opts.store)
    enqueue(() => opts.persistence.recordRemote(batch, serverSeq)) // raw + durable across reload
  }

  /**
   * Roll back a rejected local batch: undo all unacked local ops, drop the
   * rejected one, replay the rest (same rebase machinery), so the optimistic
   * edit disappears while other pending edits are preserved. Store writes use
   * `origin: "remote"` so nothing re-sends or re-persists.
   */
  const rollbackPending = (batchId: string): void => {
    const pend = [...pending.values()]
    for (let i = pend.length - 1; i >= 0; i--) {
      opts.store.applyBatch({ ...pend[i], ops: inverseBatch(pend[i]), origin: "remote" })
    }
    pending.delete(batchId)
    for (const p of pending.values()) opts.store.applyBatch({ ...p, origin: "remote" })
    pruneDanglingEdges(opts.store)
  }

  // Merge records into one batch: concat ops in seq order, keep the latest
  // batch's envelope (id/ts/origin). `enrichOutbound` then dedupes repeat
  // same-target updates (the rotate flood collapses to one op per node).
  const mergeBatches = (batches: OpBatch[]): OpBatch => ({
    ...batches[batches.length - 1],
    ops: batches.flatMap((b) => b.ops),
  })

  const sendRecords = (recs: OplogRecord[]): void => {
    if (!connection || recs.length === 0) return
    clientSeq += 1
    inFlight.set(clientSeq, { seqs: recs.map((r) => r.seq), batchIds: recs.map((r) => r.batch.id) })
    const merged = recs.length === 1 ? recs[0].batch : mergeBatches(recs.map((r) => r.batch))
    const batch = opts.enrichOutbound ? opts.enrichOutbound(merged) : merged
    connection.send({ kind: "op", client_seq: clientSeq, batch })
  }

  const pump = async (): Promise<void> => {
    if (!connection) return
    await opts.persistence.flush() // ensure fresh local edits are in the oplog
    const unacked = await outbox.pending()
    const inFlightSeqs = new Set([...inFlight.values()].flatMap((r) => r.seqs))
    const eligible = unacked.filter((r) => !rejected.has(r.seq) && !inFlightSeqs.has(r.seq))
    if (eligible.length === 0) return
    if (opts.coalesceMs && opts.coalesceMs > 0) {
      sendRecords(eligible) // one merged message for the whole debounce window
    } else {
      for (const rec of eligible) sendRecords([rec]) // one message per record
    }
  }

  const handle = (msg: InboundMessage): void => {
    switch (msg.kind) {
      case "welcome":
        lastServerSeq = Math.max(lastServerSeq, msg.seq)
        opts.onWelcome?.() // any mode = connected + healthy (resets the reconnect backoff)
        if (msg.mode === "snapshot") {
          opts.onSnapshot?.(msg.snapshot, msg.seq) // hydrate the local replica
          for (const [id, state] of Object.entries(msg.presence ?? {})) {
            for (const cb of presenceListeners) cb(id as ClientId, state)
          }
        } else if (msg.mode === "catch-up") {
          for (const b of msg.batches) applyRemote(b.batch, b.seq)
        }
        enqueue(pump) // live/snapshot/catch-up all resume the outbox
        break
      case "peer-op":
        lastServerSeq = Math.max(lastServerSeq, msg.seq)
        applyRemote(msg.batch, msg.seq)
        break
      case "op-applied": {
        lastServerSeq = Math.max(lastServerSeq, msg.seq)
        const rec = inFlight.get(msg.client_seq)
        inFlight.delete(msg.client_seq)
        if (rec) {
          for (const id of rec.batchIds) pending.delete(id) // acked → no longer rebased on top
          enqueue(async () => {
            await outbox.markSyncedTo(Math.max(...rec.seqs)) // one ack covers the merged range
            for (const s of rec.seqs) await opts.persistence.setServerSeq(s, msg.seq) // reload replays in relay order
          })
        }
        break
      }
      case "op-rejected": {
        const rec = inFlight.get(msg.client_seq)
        inFlight.delete(msg.client_seq)
        if (rec) {
          for (const s of rec.seqs) rejected.add(s) // don't resend a refused op
          for (const id of rec.batchIds) if (pending.has(id)) rollbackPending(id) // revert optimistic edit
          enqueue(async () => {
            for (const s of rec.seqs) await opts.persistence.removeBatch(s) // don't resurrect on reload
          })
        }
        break
      }
      case "presence":
        for (const cb of presenceListeners) cb(msg.clientId, msg.state)
        break
      case "presence-leave":
        for (const cb of presenceListeners) cb(msg.clientId, null)
        break
      case "kick":
        // The relay evicted us (e.g. plan cap). Drop the connection; the caller's
        // reconnect supervisor decides whether/when to retry.
        connection?.close()
        connection = null
        break
    }
  }

  // Local commits arm a debounce (coalesceMs) so a burst merges into one send;
  // with coalesceMs=0 they pump immediately. Reconnect/catch-up pump directly.
  const schedulePump = (): void => {
    if (!opts.coalesceMs || opts.coalesceMs <= 0) {
      enqueue(pump)
      return
    }
    if (coalesceTimer !== null) return
    coalesceTimer = setTimeout(() => {
      coalesceTimer = null
      enqueue(pump)
    }, opts.coalesceMs)
  }

  const flushCoalesce = (): void => {
    if (coalesceTimer === null) return
    clearTimeout(coalesceTimer)
    coalesceTimer = null
    enqueue(pump)
  }

  const openConnection = (): void => {
    // Close any prior socket first: a direct reconnect() while one is still open
    // would otherwise leak it and leave a second `handle` registered on it.
    connection?.close()
    // A fresh socket: anything sent on the previous connection but not yet acked
    // is lost with it, so drop the in-flight tracking — those oplog records are
    // still unacked and must become eligible to re-send, or they're stranded
    // until a reload. This is the supervised-reconnect path, which (unlike the
    // test-only `disconnect()`) never cleared in-flight before.
    inFlight.clear()
    // `sinceSeq` at connect time lets the relay pick the welcome mode; no separate
    // hello-with-since_seq message (the real WS carries it as a query param).
    connection = opts.connect(lastServerSeq)
    connection.onMessage(handle)
    // Replay coalesced (same grouping as the live send): a coalesced message's
    // relay id is its LAST record's id, so re-sending the same set keeps that id
    // and the relay dedups it. Re-sending records individually would give earlier
    // records ids the relay never recorded → re-apply. (A superset re-send, if a
    // new edit landed during the drop, still changes the id — see PR notes.)
    enqueue(pump)
  }

  // The single intake for a locally-produced batch's SYNC side: track it as an
  // unacked rebase entry (applied on top of every remote op so local edits stay
  // "latest") and trigger a pump. The send source is the outbox, so the batch
  // object itself is only used for rebase. Both the store producer (via
  // `attachSync.sendBatch`) and future headless producers route through here.
  const submitLocalBatch = (batch: OpBatch): void => {
    pending.set(batch.id, batch)
    schedulePump()
  }

  const adapter: SyncAdapter = {
    capabilities: { causalOrdering: true },
    // A local (store) commit enters the shared intake — same rebase + send path
    // a headless producer uses.
    sendBatch: submitLocalBatch,
    sendPresence: (patch: PresencePatch) => {
      const state = { ...patch, clientId: opts.clientId } as PresenceState
      connection?.send({ kind: "presence", clientId: opts.clientId, state })
    },
    // Remote batches are applied by `applyRemote` (rebase), not through this cb —
    // attachSync's default apply is intentionally left unwired.
    onBatch: () => () => {},
    onPresence: (cb) => {
      presenceListeners.add(cb)
      return () => presenceListeners.delete(cb)
    },
  }

  const detachSync = attachSync(opts.store, adapter)
  openConnection()

  const clearTimer = (): void => {
    if (coalesceTimer !== null) {
      clearTimeout(coalesceTimer)
      coalesceTimer = null
    }
  }

  return {
    submitLocalBatch,
    detach: () => {
      clearTimer()
      detachSync()
      connection?.close()
      connection = null
    },
    disconnect: () => {
      clearTimer()
      connection?.close()
      connection = null
      inFlight.clear() // un-acked ops re-pump on reconnect
    },
    reconnect: openConnection,
    settle: async () => {
      flushCoalesce() // force any pending debounced send before draining
      // Drain until the work chain stops growing (acks/pumps enqueue more work).
      let seen: Promise<void>
      do {
        seen = work
        await seen
      } while (seen !== work)
      await opts.persistence.flush() // make recordRemote'd batches durable
    },
  }
}
