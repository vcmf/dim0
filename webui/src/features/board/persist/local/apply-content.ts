import { asBatchId } from "@canvas-harness/core"
import type { CanvasStore, Node, Op } from "@canvas-harness/core"
import type { BoardContent } from "@/features/board/model"
import { normalizeBoardContent } from "@/features/board/model"
import { filterContentByLayer } from "@/features/board/model/layer"
import {
  adaptEdgeColors,
  adaptNodeColors,
  applyColorsToEdgeStyle,
  applyColorsToStyle,
} from "@/features/board/harness/theme/color-adapter"
import { storedNodeColorsOf } from "@/features/board/harness/theme/apply-node-colors"
import { getBoardThemeMode } from "@/features/board/harness/theme/theme-mode-ref"


/**
 * Replace the store's contents with persisted content — the local analog of the
 * backend `hydrateBoardStore` "replace" mode. Existing nodes/edges are cleared
 * and the new set applied as ONE `remote` batch, so it skips the undo stack and
 * (if persistence attaches afterward) isn't re-persisted; `clearHistory` then
 * makes the (re)load non-undoable. Replace semantics are what make a layer
 * SWITCH safe: the old layer is removed before the new one is projected.
 *
 * Re-projects each node/edge's display colors from its canonical
 * `_storedColors` for the CURRENT theme mode — the local analog of what
 * `noteToNode` does on the backend path. Without this, a reload paints whatever
 * theme the colors were last persisted in (the stamp hook + theme-flip
 * projection both skip a `remote` hydrate), so e.g. a dark board reloads
 * mis-themed.
 *
 * When `rootId` is given, only that layer's nodes/edges are projected into the
 * store (root layer for `null`), mirroring the backend `get_graph(root_id)`.
 * Omit it to hydrate the whole board unchanged. Persistence stays whole-board
 * regardless, so filtering here never drops other layers.
 */
export const applyContentToStore = (
  store: CanvasStore,
  content: BoardContent,
  rootId?: string | null,
): void => {
  // Defensive: callers normally pass `persistence.load()` output (already
  // normalized), but this is exported — normalize here too so the store's
  // canonical-label invariant holds regardless of the source. Idempotent + cheap.
  const normalized = normalizeBoardContent(content)
  const scoped = rootId === undefined ? normalized : filterContentByLayer(normalized, rootId)
  const mode = getBoardThemeMode()
  const ops: Op[] = []

  // Clear the current scene first (edges before nodes — a batched `node.remove`
  // doesn't cascade incident edges the way imperative `removeNode` does).
  for (const edge of store.getAllEdges()) ops.push({ type: "edge.remove", edge })
  for (const node of store.getAllNodes()) ops.push({ type: "node.remove", node })

  for (const group of scoped.groups) ops.push({ type: "group.upsert", group })

  // Label shape is already normalized upstream (BoardPersistence.materialize →
  // normalizeBoardContent), so this only re-projects theme colors.
  for (const node of scoped.nodes) {
    const stored = storedNodeColorsOf(node as unknown as Node)
    const display = mode === "dark" ? adaptNodeColors(stored, "dark") : stored
    const style = applyColorsToStyle(node.style ?? {}, display)
    ops.push({ type: "node.add", node: { ...node, style } })
  }

  for (const edge of scoped.edges) {
    const data = edge.data as { _storedColors?: { strokeColor?: string; textColor?: string } } | undefined
    const stored = data?._storedColors ?? { strokeColor: edge.style?.strokeColor, textColor: edge.style?.textColor }
    const display = mode === "dark" ? adaptEdgeColors(stored, "dark") : stored
    const style = applyColorsToEdgeStyle(edge.style ?? {}, display)
    ops.push({ type: "edge.add", edge: { ...edge, style } })
  }

  if (ops.length > 0) {
    store.applyBatch({
      id: asBatchId("local-hydrate"),
      clientId: store.clientId,
      ts: Date.now(),
      origin: "remote",
      ops,
    })
  }
  store.clearHistory()
  if (scoped.frameOrder && scoped.frameOrder.length > 0) {
    store.setFrameOrder(scoped.frameOrder)
  }
}
