/**
 * Local board persistence (A1) — snapshot + op-log via the `StorageEngine` port.
 *
 * Write path: each committed (non-remote) `change` batch is buffered and flushed
 * (debounced) to the oplog. Periodically `compact()` folds the tail into a fresh
 * snapshot. Read path: `load()` = snapshot + replay(oplog tail) → BoardContent.
 *
 * Replay reuses a throwaway canvas-harness store to apply ops, so op semantics
 * are never reimplemented. Appends are serialized through an internal queue so
 * seq assignment is monotonic; batches are de-duplicated by id (idempotency).
 *
 * Crash-safety: correctness never depends on the oplog being truncated. `load()`
 * only replays entries with `seq > snapshot.seq`, so a compaction that wrote the
 * snapshot but didn't delete the tail still loads correctly. The dangerous
 * inverse (oplog deleted without a snapshot) is prevented by doing both writes
 * in a single engine transaction (`writeSnapshot`).
 */
import { createCanvasStore } from "@canvas-harness/core"
import type { CanvasStore, OpBatch } from "@canvas-harness/core"
import type { BoardContent } from "@/features/board/model"
import { normalizeBoardContent } from "@/features/board/model"
import { contentToScene, emptyContent, readContent } from "./codec"
import { pruneDanglingEdges } from "./integrity"
import { IndexedDbEngine } from "./indexeddb-engine"
import type { StorageEngine } from "./engine"
import type { SnapshotRecord, OplogRecord } from "./idb"


export type BoardPersistenceOptions = { engine?: StorageEngine; dbName?: string; debounceMs?: number }


export class BoardPersistence {
  private engine: StorageEngine | null
  private readonly ownsEngine: boolean
  private seq = 0
  private queue: Promise<void> = Promise.resolve()
  private pending: { batch: OpBatch; serverSeq?: number }[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly seen = new Set<string>()
  private readonly boardId: string
  private readonly dbName?: string
  private readonly debounceMs: number


  constructor(boardId: string, opts: BoardPersistenceOptions = {}) {
    this.boardId = boardId
    this.engine = opts.engine ?? null
    this.dbName = opts.dbName
    this.debounceMs = opts.debounceMs ?? 50
    this.ownsEngine = !opts.engine
  }


  /** Open the engine if this instance owns one. Idempotent; a no-op when injected. */
  async init(): Promise<void> {
    if (!this.engine) this.engine = await IndexedDbEngine.open(this.dbName)
  }


  /** Wire to a live store: every local committed batch is persisted. */
  attach(store: CanvasStore): () => void {
    return store.subscribe("change", (batch) => this.record(batch))
  }


  /**
   * Persist a LOCAL committed batch (the attach 'change' path). Remote batches
   * are skipped here on purpose: the load-time hydrate is applied as a `remote`
   * batch, so persisting remote from 'change' would re-persist the whole board.
   * Genuine relay ops are persisted via `recordRemote` (called by the sync
   * coordinator), so a reload reconstructs the converged (local + remote) state.
   */
  record(batch: OpBatch): void {
    if (batch.origin === "remote") return
    this.enqueue(batch)
  }


  /**
   * Persist a batch received from the relay so reload includes remote edits.
   * `serverSeq` is the relay's total-order position — materialize replays by it.
   */
  recordRemote(batch: OpBatch, serverSeq?: number): void {
    this.enqueue(batch, serverSeq)
  }


  /**
   * Record the relay-assigned `serverSeq` for a local batch (called on ack).
   * Ordering the oplog by `serverSeq` at load time makes a reload converge to
   * the same state live sync did, instead of raw local-append order.
   */
  async setServerSeq(localSeq: number, serverSeq: number): Promise<void> {
    const engine = this.requireEngine()
    const rec = await engine.get<OplogRecord>("oplog", [this.boardId, localSeq])
    if (!rec || rec.serverSeq !== undefined) return
    await engine.put<OplogRecord>("oplog", { ...rec, serverSeq })
  }


  /**
   * Remove a batch from the oplog by its local seq. Used when the relay rejects
   * a local op (e.g. read-only): the optimistic edit is rolled back in the store
   * and must not resurrect on reload.
   */
  async removeBatch(localSeq: number): Promise<void> {
    await this.requireEngine().delete("oplog", [this.boardId, localSeq])
  }


  /** Buffer a batch and schedule a debounced flush to the oplog. */
  private enqueue(batch: OpBatch, serverSeq?: number): void {
    this.pending.push({ batch, serverSeq })
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flushPending(), this.debounceMs)
    }
  }


  /** Resolve once all buffered + queued appends have been written. */
  async flush(): Promise<void> {
    this.flushPending()
    await this.queue
  }


  /** Load the board's full content, syncing internal seq + dedupe cursors. */
  async load(): Promise<BoardContent> {
    const { content, seq } = await this.materialize()
    this.seq = seq
    return content
  }


  /**
   * Compact: snapshot current full content and truncate the folded oplog. Sets
   * the seq cursor to the snapshot's seq.
   */
  async compact(): Promise<void> {
    const { content, seq } = await this.materialize()
    await this.writeSnapshot(content, seq)
    this.seq = seq
  }


  /**
   * Capture the current materialized base + the seq it reflects, WITHOUT
   * truncating anything. Used by local→synced promotion to snapshot exactly the
   * content shipped to the server; pair with `foldBase` once the server accepts.
   */
  async capture(): Promise<{ content: BoardContent; seq: number }> {
    return this.materialize()
  }


  /**
   * Write `content` as the snapshot base, truncating the oplog ONLY up to `seq`.
   * Any batch above `seq` is left in the oplog and replays on top of the base on
   * the next load. Two callers, both relying on "everything ≤ seq is already in
   * `content`, so folding it neither loses nor double-applies":
   *   - local→synced promotion: `content` is a `capture()` at `seq`; edits made
   *     during the adopt round-trip (seq' > seq) stay pending to ship via outbox.
   *   - offline materialize: `content` is the server whole-board fetch and `seq`
   *     is the full oplog height at a quiescent moment, so the whole oplog folds
   *     away (nothing replays). See `materializeBoardOffline`.
   */
  async foldBase(content: BoardContent, seq: number): Promise<void> {
    await this.writeSnapshot(content, seq)
    if (seq > this.seq) this.seq = seq
  }


  /** Close the engine if owned, and cancel any pending flush. */
  close(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.ownsEngine) this.engine?.close()
    this.engine = null
  }


  /**
   * Write snapshot + truncate oplog atomically (one transaction). Overridable so
   * tests can simulate a crash before commit. Protected, not for app code.
   */
  protected async writeSnapshot(content: BoardContent, seq: number): Promise<void> {
    await this.requireEngine().tx(["snapshots", "oplog"], async (t) => {
      await t.put<SnapshotRecord>("snapshots", { content, seq }, this.boardId)
      await t.delete("oplog", { lower: [this.boardId, 0], upper: [this.boardId, seq] })
    })
  }


  /** Drain buffered batches into the serialized append queue. */
  private flushPending(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pending.length === 0) return
    const batches = this.pending
    this.pending = []
    for (const entry of batches) {
      this.queue = this.queue.then(() => this.append(entry.batch, entry.serverSeq))
    }
  }


  /** Append one batch to the oplog (assigns next seq; de-dupes by batch id). */
  private async append(batch: OpBatch, serverSeq?: number): Promise<void> {
    if (this.seen.has(batch.id)) return
    this.seen.add(batch.id)
    this.seq += 1
    await this.requireEngine().put<OplogRecord>("oplog", { boardId: this.boardId, seq: this.seq, batch, serverSeq })
  }


  /**
   * Materialize current full content (snapshot + replayed oplog tail) and the
   * highest seq it reflects. Also seeds the dedupe set with replayed batch ids.
   */
  private async materialize(): Promise<{ content: BoardContent; seq: number }> {
    const engine = this.requireEngine()
    const snap = await engine.get<SnapshotRecord>("snapshots", this.boardId)
    const base = snap?.content ?? emptyContent()
    const baseSeq = snap?.seq ?? 0
    const records = await engine.list<OplogRecord>("oplog", {
      range: { lower: [this.boardId, baseSeq], upper: [this.boardId, Number.MAX_SAFE_INTEGER], lowerOpen: true },
    })
    const seq = records.length > 0 ? records[records.length - 1].seq : baseSeq
    if (records.length === 0) return { content: normalizeBoardContent(base), seq }
    // Replay in relay (`serverSeq`) order so a reload converges the same way live
    // sync did; unacked-local ops (no `serverSeq`) sort last, then by local seq.
    // Stable within a serverSeq bucket, so all-local logs keep append order.
    const ordered = [...records].sort((a, b) => {
      const sa = a.serverSeq ?? Number.MAX_SAFE_INTEGER
      const sb = b.serverSeq ?? Number.MAX_SAFE_INTEGER
      return sa !== sb ? sa - sb : a.seq - b.seq
    })
    const store = createCanvasStore({ initial: contentToScene(base) })
    for (const r of ordered) {
      this.seen.add(r.batch.id)
      store.applyBatch({ ...r.batch, origin: "remote" })
    }
    pruneDanglingEdges(store)
    return { content: normalizeBoardContent(readContent(store)), seq }
  }


  private requireEngine(): StorageEngine {
    if (!this.engine) throw new Error("BoardPersistence.init() must be called first")
    return this.engine
  }
}
