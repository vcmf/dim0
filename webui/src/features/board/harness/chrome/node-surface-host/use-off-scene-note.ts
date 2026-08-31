import { useEffect, useState } from "react"
import { asNodeId, createCanvasStore } from "@canvas-harness/core"
import type { BoardContent } from "@/features/board/model"
import type { CanvasStore, Node } from "@canvas-harness/core"
import { generateUuid } from "@/lib/common"
import { queryClient } from "@/query-client"
import { getLocalStores } from "@/features/local-stores"
import { BoardPersistence } from "@/features/board/persist/local/board-persistence"
import { contentToScene, emptyContent } from "@/features/board/persist/local/codec"
import { filterContentByLayer } from "@/features/board/model/layer"
import { getBoardPersistenceRef } from "@/features/board/persist/local/board-persistence-ref"
import { getBoardSyncRef } from "@/features/board/harness/sync/board-sync-ref"
import { affectsSurfaceTree } from "@/features/board/harness/canvas/use-sidebar-contents-sync"
import type { Note } from "@/features/board/types/note"


/**
 * The note's ancestor chain (root → note), the LOCAL analog of the backend
 * `useGetNotePath` — walk `parentId` up over the whole-board replica. Each entry
 * carries just what the sheet breadcrumb + stack need: id, kind (`style.type`),
 * label, and icon; the breadcrumb resolves live values via `useNode` on the id.
 * Cycle-safe.
 */
function buildNotePath(content: BoardContent, nodeId: string): Note[] {
  const byId = new Map(content.nodes.map((n) => [n.id as unknown as string, n]))
  const path: Note[] = []
  const seen = new Set<string>()
  let cur: string | null = nodeId
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const node = byId.get(cur)
    if (!node) break
    const data = node.data as { parentId?: string | null; styleType?: string; label?: Note["label"]; properties?: Note["properties"] } | undefined
    path.push({
      id: cur,
      style: { type: (data?.styleType ?? node.type) as Note["style"]["type"] },
      label: data?.label,
      properties: data?.properties ?? {},
    } as Note)
    cur = data?.parentId ?? null
  }
  return path.reverse()
}


/**
 * Open a throwaway, off-scene store holding the note `nodeId` (and its layer),
 * seeded from the whole-board replica. The surface reads from it and edits
 * through it (`store.updateNode`); every edit is forwarded to the sync-correct
 * intake (`record` + `submitLocalBatch({scene:false})`), so an off-scene edit
 * persists + syncs exactly like an on-canvas one, without moving the user's view.
 * The surface-host analog of the agent's `HeadlessMutator`. Pure (non-React) so
 * the load + sync wiring is unit-testable.
 *
 * Returns `store: null` when the note isn't in the local replica (a synced note
 * not yet materialized) — the caller then falls back to REST, and we skip
 * building a doomed store. Surface-relevant off-scene edits (rename / re-icon /
 * move) invalidate the sidebar's `localBoardContents` cache, since the sidebar
 * sync only listens to the live store. `dispose()` detaches the subscription.
 */
export async function openOffSceneNoteStore(
  liveStore: CanvasStore,
  boardId: string | null,
  nodeId: string,
): Promise<{ store: CanvasStore | null; node: Node | null; path: Note[]; dispose: () => void }> {
  // Flush the ACTIVE writer's pending edits (if the board is mounted) so a re-open
  // reflects this session's own (debounced) off-scene edits.
  await getBoardPersistenceRef()?.flush()
  // Read from the durable replica via a FRESH BoardPersistence — available even
  // before the board's persistence ref mounts (a deep-linked sub-page on reload
  // opens the surface before setBoardPersistenceRef runs), like the sidebar does.
  const { engine } = await getLocalStores()
  const content = boardId ? await new BoardPersistence(boardId, { engine }).load() : emptyContent()
  const target = content.nodes.find((n) => (n.id as unknown as string) === nodeId)
  // Not in the replica → let the caller's REST path handle it; don't build a
  // store (avoids a wasted seed + subscription for a synced-not-local note).
  if (!target) return { store: null, node: null, path: [], dispose: () => {} }
  // The breadcrumb + stack (ancestor chain) — built from the same load.
  const path = buildNotePath(content, nodeId)

  const layer = (target.data as { parentId?: string | null } | undefined)?.parentId ?? null
  const store = createCanvasStore({
    clientId: liveStore.clientId,
    idGenerator: generateUuid,
    initial: contentToScene(filterContentByLayer(content, layer)),
  })
  // Every off-scene edit records to the oplog + enters the sync intake as an
  // off-scene batch (never the in-scene rebase set), mirroring the scene store's
  // persistence.attach + attachSync — minus the render. A surface-relevant edit
  // also refreshes the sidebar tree (the sidebar sync can't see this store).
  // Writes go through the ACTIVE single writer, resolved dynamically — it may
  // mount after the surface opens (deep-linked reload), and it's the only
  // instance whose oplog seq the sync coordinator tracks.
  const dispose = store.subscribe("change", (batch) => {
    getBoardPersistenceRef()?.record(batch)
    getBoardSyncRef()?.submitLocalBatch(batch, { scene: false })
    if (boardId && affectsSurfaceTree(batch)) {
      void Promise.resolve(getBoardPersistenceRef()?.flush()).then(() =>
        queryClient.invalidateQueries({ queryKey: ["localBoardContents", boardId] }),
      )
    }
  })
  return { store, node: store.getNode(asNodeId(nodeId)) ?? null, path, dispose }
}


/**
 * React wrapper over {@link openOffSceneNoteStore}. Loads a note that lives
 * OFF-SCENE — a sub-page in a layer that isn't on the canvas — into a store the
 * surface can read AND edit.
 *
 * `enabled` should be true only when the note ISN'T in the live store (a normal
 * on-canvas sheet edits through the live store, unchanged). `node` stays live —
 * it re-reads on the off-scene store's changes so a rename / icon edit shows in
 * the panel (not just persists). `ready` flips true once the async load settles,
 * so the caller can tell "still loading" from "not found" (→ REST fallback).
 */
export function useOffSceneNote(
  liveStore: CanvasStore,
  boardId: string | null,
  nodeId: string,
  enabled: boolean,
): { store: CanvasStore | null; node: Node | null; path: Note[]; ready: boolean } {
  const [source, setSource] = useState<{ store: CanvasStore | null; node: Node | null; path: Note[] } | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!enabled || !boardId) {
      setSource(null)
      setReady(false)
      return
    }
    let cancelled = false
    let dispose: () => void = () => {}
    setReady(false)
    setSource(null)
    void openOffSceneNoteStore(liveStore, boardId, nodeId).then((res) => {
      if (cancelled) {
        res.dispose()
        return
      }
      // Keep `node` live so panel-visible fields (title, icon) reflect edits.
      const reRead = (): void =>
        setSource({ store: res.store, node: res.store?.getNode(asNodeId(nodeId)) ?? null, path: res.path })
      const unsubReactive = res.store?.subscribe("change", reRead) ?? (() => {})
      dispose = () => {
        unsubReactive()
        res.dispose()
      }
      setSource({ store: res.store, node: res.node, path: res.path })
      setReady(true)
    })
    return () => {
      cancelled = true
      dispose()
    }
  }, [enabled, boardId, nodeId, liveStore])

  return { store: source?.store ?? null, node: source?.node ?? null, path: source?.path ?? [], ready }
}
