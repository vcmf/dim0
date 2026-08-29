import { useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { CanvasStore, OpBatch } from "@canvas-harness/core"
import type { NoteNodeData } from "../convert/note-to-node"
import type { BoardContentKind } from "@/features/board/api/list-board-contents"
import { getBoardPersistenceRef } from "@/features/board/persist/local/board-persistence-ref"


const SURFACE_KINDS = new Set<BoardContentKind>(["sheet", "folder", "code-sandbox", "widget"])


/**
 * Whether a batch changes the sidebar's surface-tree projection: a surface node
 * added or removed (both ops carry the full node, so we check its kind), or a
 * surface node's tree-visible fields (label / icon / parent / kind) edited. A
 * pure drag/resize (position/style only), or any add/remove of a non-surface
 * node (sticky/shape/image), returns false so we don't re-read the tree on edits
 * it never reflects.
 */
export const affectsSurfaceTree = (batch: OpBatch): boolean => {
  for (const op of batch.ops) {
    if (op.type === "node.add" || op.type === "node.remove") {
      // Fall back to `node.type`: agent-authored surfaces set only the canonical
      // type, not the display `styleType`, so keying off styleType alone would
      // skip refreshing the tree when the agent adds/removes a sheet or folder.
      const kind = ((op.node.data as NoteNodeData | undefined)?.styleType ?? op.node.type) as BoardContentKind | undefined
      if (kind && SURFACE_KINDS.has(kind)) return true
    } else if (op.type === "node.update") {
      const data = (op.patch as { data?: Partial<NoteNodeData> } | undefined)?.data
      if (data && ("label" in data || "parentId" in data || "properties" in data || "styleType" in data)) {
        return true
      }
    }
  }
  return false
}


/**
 * Keep the sidebar's surface-tree in sync with live canvas edits. The tree reads
 * the on-device store (`["localBoardContents", boardId]`) for both local and
 * offline-available synced boards, so one debounced invalidation on a surface-
 * relevant op (create / delete / rename / re-icon / move) refreshes it — before
 * this, created surfaces never appeared in the tree and rename/icon lagged until
 * a manual collapse+expand. The debounce only collapses a burst of ops; the
 * re-read is then chained to the board persistence `flush()` (not a fixed time
 * margin) so the fresh snapshot+oplog load always reflects the committed edit,
 * even under a slow/contended IndexedDB write.
 */
export const useSidebarContentsSync = (store: CanvasStore, boardId: string | null): void => {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!boardId) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = store.subscribe("change", (batch) => {
      if (!affectsSurfaceTree(batch)) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        // Await the mounted persistence flush before re-reading (the sidebar's
        // `listLocalBoardContents` opens a fresh snapshot+oplog load, so the
        // write must be durable first). `getBoardPersistenceRef` is the active
        // board's writer for both local + synced; `Promise.resolve(undefined)`
        // when none is mounted → invalidate immediately.
        void Promise.resolve(getBoardPersistenceRef()?.flush()).then(() =>
          queryClient.invalidateQueries({ queryKey: ["localBoardContents", boardId] }),
        )
      }, 150)
    })
    return () => {
      if (timer !== null) clearTimeout(timer)
      unsub()
    }
  }, [store, boardId, queryClient])
}
