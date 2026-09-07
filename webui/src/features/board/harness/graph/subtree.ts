/**
 * Descendant-cascade node removal — the local analog of the backend
 * `GraphStore.delete_node` (BFS over `parent_id`).
 *
 * Two-part, because a local board renders only ONE layer at a time:
 *   1. Loaded layer — remove the node + any descendants present in the live
 *      store, in one batch (so a single undo restores them, edges included).
 *   2. Deeper layers — a folder's children live in a deeper layer that isn't in
 *      the store. Sweep them from the WHOLE board via persistence (the oplog
 *      covers every layer), recording their removal so they don't orphan, then
 *      enter the sync intake (`submitLocalBatch`, off-scene) so a synced board
 *      pumps them to the relay promptly instead of only on the next edit.
 *
 * On backend boards there's no local persistence ref, so only step 1 runs and the
 * server performs its own cascade (unchanged behaviour).
 */
import type { CanvasStore, NodeId, Op } from "@canvas-harness/core"
import type { OpBatch } from "@canvas-harness/core"
import type { DimNode } from "@/features/board/model"
import { getBoardPersistenceRef } from "@/features/board/persist/local/board-persistence-ref"
import { getBoardSyncRef } from "@/features/board/harness/sync/board-sync-ref"
import { makeBatch } from "@/features/board/harness/make-batch"
import { isDurableDelete } from "@/features/board/harness/node-types/durable-delete"
import { cascadeRemovedDocs } from "@/features/board/harness/agent/use-doc-node-cascade"
import { useBoardAppStore } from "@/features/board/harness/store/board-app-store"


/**
 * Collect `roots` plus every transitive descendant (via `data.parentId`) as a
 * de-duplicated id set. Cycle-safe: a node is visited at most once. Works even
 * when a root isn't in `nodes` (its children still resolve via `parentId`).
 */
export const collectSubtreeIds = (nodes: DimNode[], roots: NodeId[]): Set<NodeId> => {
  const childrenByParent = new Map<string, NodeId[]>()
  for (const node of nodes) {
    const parentId = node.data?.parentId
    if (!parentId) continue
    const siblings = childrenByParent.get(parentId) ?? []
    siblings.push(node.id)
    childrenByParent.set(parentId, siblings)
  }

  const collected = new Set<NodeId>()
  const queue: NodeId[] = [...roots]
  while (queue.length > 0) {
    const id = queue.shift()
    if (id === undefined || collected.has(id)) continue
    collected.add(id)
    for (const child of childrenByParent.get(id) ?? []) {
      if (!collected.has(child)) queue.push(child)
    }
  }
  return collected
}


/** The node id an edge end points at (canvas-harness end is `{ nodeId }`, or a bare id). */
const edgeEndId = (end: unknown): string | undefined => {
  if (typeof end === "string") return end
  if (end && typeof end === "object" && "nodeId" in end) return String((end as { nodeId: unknown }).nodeId)
  return undefined
}


/**
 * Remove descendants that live in deeper (unloaded) layers, straight from the
 * whole-board oplog. Best-effort: a failure leaves orphans (prior behaviour) but
 * never throws into the click handler.
 *
 * Returns the ids of removed `document` nodes: these are swept via the oplog, so
 * the store never emits a 'change' for them and `useDocNodeCascade` can't see
 * them — the caller cascades their DocRepo cleanup explicitly.
 */
const sweepDeepDescendants = async (
  store: CanvasStore,
  roots: NodeId[],
  loaded: Set<NodeId>,
  origin: OpBatch["origin"],
): Promise<string[]> => {
  const persistence = getBoardPersistenceRef()
  if (!persistence) return [] // backend board / nothing else loaded — server cascades

  try {
    await persistence.flush() // make the loaded-layer removal durable first
    const content = await persistence.load() // whole board (every layer)
    const all = collectSubtreeIds(content.nodes, roots)
    const deep = new Set<string>()
    for (const id of all) if (!loaded.has(id)) deep.add(id)
    if (deep.size === 0) return []

    const removeNodes = content.nodes.filter((n) => deep.has(n.id))
    const removeEdges = content.edges.filter((e) => {
      const s = edgeEndId(e.source)
      const t = edgeEndId(e.target)
      return (s !== undefined && deep.has(s)) || (t !== undefined && deep.has(t))
    })

    const ops: Op[] = [
      ...removeEdges.map((edge) => ({ type: "edge.remove", edge }) as Op),
      ...removeNodes.map((node) => ({ type: "node.remove", node }) as Op),
    ]
    const batch = makeBatch(store, origin, ops)
    persistence.record(batch)
    await persistence.flush()
    // On a synced board, enter the sync-correct intake so the batch pumps to the
    // relay promptly (and is serverSeq-stamped on ack) instead of shipping only
    // opportunistically on the next unrelated edit. `scene: false` — these ops
    // target unloaded layers, so they must NOT join the in-scene rebase set. On a
    // local board there's no sync ref (null) and the oplog record alone is
    // sync-correct (no outbox to desync).
    getBoardSyncRef()?.submitLocalBatch(batch, { scene: false })
    return removeNodes.filter((n) => n.type === "document").map((n) => String(n.id))
  } catch (err) {
    console.warn("[harness] deep subtree cascade failed", err)
    return []
  }
}


/**
 * Build `node.remove` + incident `edge.remove` ops for the loaded nodes in
 * `ids`, so a durable delete can be applied as an explicit non-undoable batch
 * (the imperative `store.removeNode` cascades edges but is always undoable).
 */
const buildLoadedRemovalOps = (store: CanvasStore, ids: Set<NodeId>): Op[] => {
  const removeEdges = store.getAllEdges().filter((e) => {
    const s = edgeEndId(e.source)
    const t = edgeEndId(e.target)
    return (s !== undefined && ids.has(s as NodeId)) || (t !== undefined && ids.has(t as NodeId))
  })
  const removeNodes = store.getAllNodes().filter((n) => ids.has(n.id as NodeId))
  return [
    ...removeEdges.map((edge) => ({ type: "edge.remove", edge }) as Op),
    ...removeNodes.map((node) => ({ type: "node.remove", node }) as Op),
  ]
}


/**
 * Remove nodes and all their descendants. Synchronously clears the loaded layer
 * (immediate UI + one undo), then sweeps deeper layers via persistence.
 */
export const removeNodesSubtreeAsync = async (store: CanvasStore, roots: NodeId[]): Promise<void> => {
  if (roots.length === 0) return
  const loaded = collectSubtreeIds(store.getAllNodes() as DimNode[], roots)
  // If ANY node in the removed set is a durable type (see DURABLE_DELETE) its
  // state lives outside the store, so undo can't losslessly restore it — take
  // the whole delete off the undo stack via an explicit `history`-origin batch
  // rather than the default undoable `store.batch`. Keyed off the collected set,
  // not just the roots, so a durable node nested under a plain container still
  // deletes non-undoably.
  const durable = [...loaded].some((id) => isDurableDelete(store.getNode(id)?.type))
  if (loaded.size > 0) {
    if (durable) {
      store.applyBatch(makeBatch(store, "history", buildLoadedRemovalOps(store, loaded)))
    } else {
      store.batch(() => {
        for (const id of loaded) store.removeNode(id)
      })
    }
  }
  // Deep-layer document removals never reach the store, so cascade their DocRepo
  // cleanup here (the store-'change' listener in useDocNodeCascade can't see them).
  const deepDocIds = await sweepDeepDescendants(store, roots, loaded, durable ? "history" : "local")
  if (deepDocIds.length > 0) {
    const boardId = useBoardAppStore.getState().boardId
    if (boardId) await cascadeRemovedDocs(boardId, deepDocIds)
  }
}


/** Fire-and-forget variant for click handlers (the loaded-layer removal is sync). */
export const removeNodesSubtree = (store: CanvasStore, roots: NodeId[]): void => {
  void removeNodesSubtreeAsync(store, roots)
}


/** Remove one node and all its descendants (its subtree). */
export const removeNodeSubtree = (store: CanvasStore, root: NodeId): void => {
  removeNodesSubtree(store, [root])
}
