/**
 * Local full-text search (A5) — a derived index over the board's nodes.
 *
 * The index is a *derived read-model*, never a source of truth: it's rebuildable
 * from the store at any time (`rebuildFromStore`). It updates incrementally from
 * store `change` events (insert/update/remove) so it always reflects the live
 * store (INV-9). A node's searchable text is its title (`data.label`) + body
 * (`content`).
 *
 * Per the no-RAG decision this is full-text only (Orama BM25); a vector/hybrid
 * upgrade stays available later without changing this seam. Index persistence to
 * IndexedDB is a deferred optimization — cold start rebuilds from the store.
 */
import { count, create, getByID, insert, remove, search } from "@orama/orama"
import type { CanvasStore, Node, NodeId } from "@canvas-harness/core"
import type { DimNodeData } from "@/features/board/model"
import { labelText } from "@/features/board/model"


const SCHEMA = { title: "string", body: "string" } as const


/**
 * Coerce a value to a plain string for the index. `content` is typed `string`,
 * but the store types `data` as generic; a non-string just isn't full-text
 * indexed (Orama's `"string"` schema would otherwise reject the whole insert).
 */
const asText = (value: unknown): string => (typeof value === "string" ? value : "")


const docOf = (node: Node) => ({
  id: node.id,
  // `data.label` is RichText (`{ markdown }`); `labelText` also tolerates a legacy
  // bare string. A naive string read indexed every title as empty (unsearchable).
  title: labelText((node.data as DimNodeData | undefined)?.label),
  body: asText(node.content),
})


export class LocalSearchIndex {
  private db = create({ schema: SCHEMA })
  private queue: Promise<void> = Promise.resolve()


  /**
   * Subscribe to store changes, keeping the index in sync. Returns unsubscribe.
   * SKIPS `remote` batches: a layer switch reloads the store as a `remote`
   * hydrate batch (node.remove of the old layer + node.add of the new), and
   * processing that would evict every OTHER layer from this whole-board index.
   * Live local edits (agent/user) are `local`/`history` and flow through. Mirrors
   * `BoardPersistence`, which skips remote on its own 'change' path for the same reason.
   */
  attach(store: CanvasStore): () => void {
    return store.subscribe("change", (batch) => {
      if (batch.origin === "remote") return
      for (const op of batch.ops) {
        if (op.type === "node.add") this.enqueue(() => this.upsert(store, op.node.id))
        else if (op.type === "node.update") this.enqueue(() => this.upsert(store, op.id))
        else if (op.type === "node.remove") this.enqueue(() => this.removeDoc(op.node.id))
      }
    })
  }


  /** Merge a set of nodes (the whole board, across layers) into the index — the
   *  whole-board build so search spans every folder, not just the current layer. */
  async indexNodes(nodes: Node[]): Promise<void> {
    for (const node of nodes) this.enqueue(() => this.upsertNode(node))
    await this.queue
  }


  /** Ranked full-text query. Returns matching node ids. */
  async query(term: string): Promise<string[]> {
    const results = await search(this.db, { term })
    return results.hits.map((h) => String(h.id))
  }


  /** Number of indexed documents. */
  count(): number {
    return count(this.db)
  }


  /** Whether a node id is currently indexed. */
  has(id: string): boolean {
    return getByID(this.db, id) !== undefined
  }


  /** Drop and rebuild the index from the store (the derived-model recovery path). */
  async rebuildFromStore(store: CanvasStore): Promise<void> {
    this.db = create({ schema: SCHEMA })
    for (const node of store.getAllNodes()) {
      await insert(this.db, docOf(node))
    }
  }


  /** Resolve once all queued incremental updates have applied. */
  async idle(): Promise<void> {
    await this.queue
  }


  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn)
  }


  private async upsert(store: CanvasStore, id: NodeId): Promise<void> {
    const node = store.getNode(id)
    if (node) await this.upsertNode(node)
  }


  private async upsertNode(node: Node): Promise<void> {
    // remove-then-insert (not Orama `update`): insert preserves the doc's `id`
    // field, whereas `update` reassigns a fresh id — which would break getByID.
    if (getByID(this.db, node.id) !== undefined) {
      await remove(this.db, node.id)
    }
    await insert(this.db, docOf(node))
  }


  private async removeDoc(id: NodeId): Promise<void> {
    if (getByID(this.db, id) !== undefined) {
      await remove(this.db, id)
    }
  }
}
