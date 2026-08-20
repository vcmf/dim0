import { useEffect, useRef } from "react"
import type { CanvasStore, Node } from "@canvas-harness/core"
import { getLocalStores } from "@/features/local-stores"
import { BoardPersistence } from "@/features/board/persist/local/board-persistence"
import { LocalSearchIndex } from "./local-index"
import { setSearchIndexRef } from "./search-index-ref"


/**
 * Build the note index from the board's WHOLE persisted content (all layers), so
 * `search_notes` spans every folder — not just the layer currently in the store.
 * Read-only load; no attach/writes. Best-effort (a fresh board has no snapshot yet).
 */
export const rebuildNoteIndex = async (index: LocalSearchIndex, boardId: string): Promise<void> => {
  const { engine } = await getLocalStores()
  const content = await new BoardPersistence(boardId, { engine }).load()
  await index.indexNodes(content.nodes as unknown as Node[])
}


/**
 * Attach a search index to a store and publish it on the module ref. Returns a
 * cleanup that detaches and clears the ref. Extracted from the hook so the
 * lifecycle is testable without React.
 */
export const wireSearchIndex = (store: CanvasStore, index: LocalSearchIndex): (() => void) => {
  setSearchIndexRef(index)
  const detach = index.attach(store)
  return () => {
    detach()
    setSearchIndexRef(null)
  }
}


/**
 * Own the local board's full-text search index: create it once, seed it from the
 * WHOLE board (all layers) so search spans folders, keep it synced with the live
 * store's local edits (`attach` ignores the `remote` layer-switch hydrate so
 * switching folders doesn't evict other layers), and publish it on the module ref
 * so the agent's `search_notes` tool can reach it. `enabled` gates it to the
 * browser-agent engine (backend boards use server-side search).
 */
export const useLocalSearchIndex = (store: CanvasStore, boardId: string, enabled: boolean): void => {
  const ref = useRef<LocalSearchIndex | null>(null)

  useEffect(() => {
    if (!enabled) return
    if (!ref.current) ref.current = new LocalSearchIndex()
    const index = ref.current
    // Attach FIRST (catch live edits during the async whole-board load), then
    // merge in every layer from persistence. Both paths go through the index's
    // internal queue, so they serialize without clobbering.
    const detach = wireSearchIndex(store, index)
    if (boardId) void rebuildNoteIndex(index, boardId).catch(() => undefined)
    return detach
  }, [store, boardId, enabled])
}
