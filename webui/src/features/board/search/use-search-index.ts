import { useEffect } from "react"
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
  useEffect(() => {
    if (!enabled) return
    // A FRESH index per (board, store): reusing one across board switches would
    // leak board A's notes into board B, because `attach` deliberately ignores the
    // layer/board hydrate batch (so it never evicts other layers).
    const index = new LocalSearchIndex()
    setSearchIndexRef(index)
    let detach = () => {}
    let cancelled = false
    // Seed the WHOLE board (all layers) FIRST, THEN attach — attaching first would
    // let a persisted (pre-edit) node re-inserted by the seed clobber a fresh live
    // edit made during the async load. Errors are logged, not swallowed.
    void (async () => {
      if (boardId) await rebuildNoteIndex(index, boardId)
      if (!cancelled) detach = index.attach(store)
    })().catch((e) => console.error("[search] note index seed failed", e))
    return () => {
      cancelled = true
      detach()
      setSearchIndexRef(null)
    }
  }, [store, boardId, enabled])
}
