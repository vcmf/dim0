import { useEffect, useRef } from "react"
import type { CanvasStore, Node } from "@canvas-harness/core"
import { getLocalStores } from "@/features/local-stores"
import { BoardPersistence } from "@/features/board/persist/local/board-persistence"
import { LocalSearchIndex } from "./local-index"
import { setSearchIndexRef } from "./search-index-ref"


/** A whole-board (all layers) search index + an id→node lookup for the agent. */
export type WholeBoardSearch = { index: LocalSearchIndex; notes: ReadonlyMap<string, Node> }


/**
 * Build a WHOLE-board note search for one agent turn: the board's entire persisted
 * content (all layers — the live store holds only the current one) OVERLAID with
 * the live store's nodes (freshest: current-layer edits/creates made this turn,
 * before the debounced flush), so both a cross-folder note AND a just-created one
 * are findable + resolvable. Read-only; built fresh per turn.
 */
export const buildWholeBoardSearch = async (boardId: string, store: CanvasStore): Promise<WholeBoardSearch> => {
  const { engine } = await getLocalStores()
  const persisted = (await new BoardPersistence(boardId, { engine }).load()).nodes as unknown as Node[]
  const byId = new Map<string, Node>(persisted.map((n) => [String(n.id), n]))
  for (const n of store.getAllNodes()) byId.set(String(n.id), n) // live current-layer wins
  const nodes = [...byId.values()]
  const index = new LocalSearchIndex()
  await index.indexNodes(nodes)
  return { index, notes: byId }
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
