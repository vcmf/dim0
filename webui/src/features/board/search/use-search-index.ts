import { useEffect, useRef } from "react"
import type { CanvasStore, Node } from "@canvas-harness/core"
import { getLocalStores } from "@/features/local-stores"
import { BoardPersistence } from "@/features/board/persist/local/board-persistence"
import { LocalSearchIndex } from "./local-index"
import { setSearchIndexRef } from "./search-index-ref"


/** A whole-board (all layers) search index + an id→node lookup for the agent. */
export type WholeBoardSearch = { index: LocalSearchIndex; notes: ReadonlyMap<string, Node> }


/**
 * Build a WHOLE-board note search for one agent turn: load the board's entire
 * persisted content (all layers, not the layer-scoped live store) and index it,
 * plus an id→node map so `search_notes`/`get_note` can resolve a cross-folder hit
 * (the live store only holds the current layer). Read-only; built fresh per turn
 * from persistence (current, since the prior turn's writes are flushed at its end).
 */
export const buildWholeBoardSearch = async (boardId: string): Promise<WholeBoardSearch> => {
  const { engine } = await getLocalStores()
  const content = await new BoardPersistence(boardId, { engine }).load()
  const nodes = content.nodes as unknown as Node[]
  const index = new LocalSearchIndex()
  await index.indexNodes(nodes)
  return { index, notes: new Map(nodes.map((n) => [String(n.id), n])) }
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
 * Own the local board's full-text search index: create it once, keep it synced
 * with the live store (it mirrors the current layer via `attach`), and publish it
 * on the module ref so the agent's `search_notes` tool can reach it.
 *
 * Attaches while the store is empty (fresh per mount), so the subsequent hydrate
 * batch and every later edit flow into the index incrementally — no rebuild race.
 * `enabled` gates it to local boards (backend boards use server-side search).
 */
export const useLocalSearchIndex = (store: CanvasStore, enabled: boolean): void => {
  const ref = useRef<LocalSearchIndex | null>(null)

  useEffect(() => {
    if (!enabled) return
    if (!ref.current) ref.current = new LocalSearchIndex()
    return wireSearchIndex(store, ref.current)
  }, [store, enabled])
}
