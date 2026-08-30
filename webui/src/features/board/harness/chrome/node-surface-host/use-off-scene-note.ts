import { useEffect, useState } from "react"
import { asNodeId, createCanvasStore } from "@canvas-harness/core"
import type { CanvasStore, Node } from "@canvas-harness/core"
import { generateUuid } from "@/lib/common"
import { queryClient } from "@/query-client"
import { contentToScene, emptyContent } from "@/features/board/persist/local/codec"
import { filterContentByLayer } from "@/features/board/model/layer"
import { getBoardPersistenceRef } from "@/features/board/persist/local/board-persistence-ref"
import { getBoardSyncRef } from "@/features/board/harness/sync/board-sync-ref"
import { affectsSurfaceTree } from "@/features/board/harness/canvas/use-sidebar-contents-sync"


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
): Promise<{ store: CanvasStore | null; node: Node | null; dispose: () => void }> {
  const persistence = getBoardPersistenceRef()
  // Flush first so a re-open reflects this session's own (debounced) off-scene
  // edits, rather than re-seeding from a stale oplog tail.
  await persistence?.flush()
  const content = persistence ? await persistence.load() : emptyContent()
  const target = content.nodes.find((n) => (n.id as unknown as string) === nodeId)
  // Not in the replica → let the caller's REST path handle it; don't build a
  // store (avoids a wasted seed + subscription for a synced-not-local note).
  if (!target) return { store: null, node: null, dispose: () => {} }

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
  const dispose = store.subscribe("change", (batch) => {
    persistence?.record(batch)
    getBoardSyncRef()?.submitLocalBatch(batch, { scene: false })
    if (boardId && affectsSurfaceTree(batch)) {
      void Promise.resolve(persistence?.flush()).then(() =>
        queryClient.invalidateQueries({ queryKey: ["localBoardContents", boardId] }),
      )
    }
  })
  return { store, node: store.getNode(asNodeId(nodeId)) ?? null, dispose }
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
): { store: CanvasStore | null; node: Node | null; ready: boolean } {
  const [source, setSource] = useState<{ store: CanvasStore | null; node: Node | null } | null>(null)
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
        setSource({ store: res.store, node: res.store?.getNode(asNodeId(nodeId)) ?? null })
      const unsubReactive = res.store?.subscribe("change", reRead) ?? (() => {})
      dispose = () => {
        unsubReactive()
        res.dispose()
      }
      setSource({ store: res.store, node: res.node })
      setReady(true)
    })
    return () => {
      cancelled = true
      dispose()
    }
  }, [enabled, boardId, nodeId, liveStore])

  return { store: source?.store ?? null, node: source?.node ?? null, ready }
}
