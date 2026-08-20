import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { LocalBoardUrl } from "@/routes"
import { isTauri } from "@/platform"
import { useQueryClient } from "@tanstack/react-query"
import { hitTestAny, type CanvasStore, type NodeId, type Renderer } from "@canvas-harness/core"
import { createDefaultNote } from "@/features/board/types/note"
import { noteToNode } from "../convert/note-to-node"
import { applyStyleMemory } from "./use-create-handlers"
import { createHarnessTextareaEditor } from "./text-editor-adapter"
import { setAgentBridge } from "../agent/agent-bridge"
import { applyLinkOutput, applyNoteOutput } from "../agent/apply-tool-output"
import { useHarnessApplyMindMap } from "../agent/use-harness-apply-mindmap"
import { setCanvasStoreRef } from "../canvas-store-ref"
import {
  Canvas,
  CanvasProvider,
  Minimap,
  type ArrowToolDefaults,
  type CanvasPointerEvent,
} from "@canvas-harness/react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  CanvasContextMenu,
  EmptyBoardCoachmarks,
  HarnessCollabStatus,
  HarnessPeerChip,
  HarnessReadonlyChip,
  HarnessToolbar,
  HarnessViewportControls,
  NodeSurfaceHost,
  PresentationControls,
  RemoteCursors,
  SlidesPanel,
  StyleSidebar,
} from "../chrome"
import { LinearView, ListView } from "../views"
import { boardNodeTypes, useRenderCustomNodeView } from "../node-types"
import { hydrateBoardStore } from "../persist/snapshot-load"
import { BoardPersistence } from "@/features/board/persist/local/board-persistence"
import { applyContentToStore } from "@/features/board/persist/local/apply-content"
import { getLocalStores } from "@/features/local-stores"
import { saveLocalThumbnail } from "@/features/board/local/save-local-thumbnail"
import { setBoardPersistenceRef } from "@/features/board/persist/local/board-persistence-ref"
import { ShareButton } from "@/features/sharing/share-button"
import { BoardKindBadge } from "@/features/board/components/board-kind-badge"
import { useBoardAppStore } from "../store/board-app-store"
import { createBoardStore } from "../store/create-board-store"
import { adaptEdgeColors, applyColorsToEdgeStyle } from "../theme/color-adapter"
import { getBoardThemeMode } from "../theme/theme-mode-ref"
import { useBoardTheme } from "../theme/use-board-theme"
import { useThemeColorProjection } from "../theme/use-theme-color-projection"
import { useBoardKeyboard } from "./use-board-keyboard"
import { useCenterFromUrl } from "./use-center-from-url"
import { useCreateHandlers } from "./use-create-handlers"
import { useHarnessDropFiles } from "./use-drop-files"
import { useHydrateIconNodes } from "./use-hydrate-icon-nodes"
import { usePresentationMode } from "./use-presentation-mode"
import { useBlockFolderCopy } from "./use-block-folder-copy"
import { resolveStoredEdgeColors, useStampNewEdges } from "./use-stamp-new-edges"
import { useStampNewNodes } from "./use-stamp-new-nodes"
import { useLocalSearchIndex } from "@/features/board/search/use-search-index"
import { isBrowserAgentActive } from "@/features/agent/local/local-agent-flag"
import { useLocalDocIndex } from "@/features/board/search/use-doc-index"
import { useDocNodeCascade } from "@/features/board/harness/agent/use-doc-node-cascade"
import { useStyleMemory } from "./use-style-memory"
import { CUSTOM_NODE_TYPES } from "./custom-node-types"
import { useLocalPresence } from "./use-local-presence"
import { useWsCollab } from "./use-ws-collab"
import { useBoardSyncV2 } from "./use-board-sync-v2"
import { useHistoryBatchIds } from "./use-history-batch-ids"
import { useSyncEngine } from "./use-sync-engine"
import { useThumbnailCapture } from "./use-thumbnail-capture"
import { useViewportPersistence } from "./use-viewport-persistence"
import { useTrackBoardCameraMotion } from "./board-camera-motion"
import { useSidebarContentsSync } from "./use-sidebar-contents-sync"
import { HarnessWrapRefProvider } from "./wrap-ref-provider"


/**
 * Canvas-harness mount for the Dim0 board. One per board view; the
 * canvas-harness store is created lazily and persists across re-renders
 * for the same component instance.
 *
 * Responsibilities:
 *  - Create the canvas store with the custom node-type registry
 *  - Hydrate from the board API on scope change (board-app-store boardId/rootId)
 *  - Subscribe the debounced save once hydration completes
 *  - Wire theme + selection chrome + minimap from useBoardTheme
 *  - Dispatch custom node views via the central router
 *
 * Tool state, top-bar wiring, keyboard shortcuts land in subsequent
 * phase-4 commits.
 */
export function HarnessCanvas({ local = false }: { local?: boolean } = {}) {
  const boardId = useBoardAppStore((s) => s.boardId)
  const rootId = useBoardAppStore((s) => s.rootId)
  const canEdit = useBoardAppStore((s) => s.canEdit)
  const setIsLoading = useBoardAppStore((s) => s.setIsLoading)
  const setCanEdit = useBoardAppStore((s) => s.setCanEdit)
  const setBoardRole = useBoardAppStore((s) => s.setBoardRole)
  const setBoardLabel = useBoardAppStore((s) => s.setBoardLabel)
  const setBoardVisibility = useBoardAppStore((s) => s.setBoardVisibility)

  const storeRef = useRef<CanvasStore | null>(null)
  if (!storeRef.current) {
    storeRef.current = createBoardStore({ nodeTypes: [...boardNodeTypes] })
  }
  const store = storeRef.current

  const tool = useBoardAppStore((s) => s.tool)
  const viewMode = useBoardAppStore((s) => s.viewMode)
  const theme = useBoardTheme()
  const [ready, setReady] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  // Captured via `<Canvas onRenderer>`; presentation mode toggles
  // `setHideFrames` on this so slide chrome (border + label) drops out
  // and only the contents show.
  const rendererRef = useRef<Renderer | null>(null)
  // Stable so `<Canvas>` doesn't tear down + recreate its renderer on
  // every re-render. A fresh renderer always starts with frames shown,
  // so re-apply the present-mode hide here — otherwise a re-render
  // mid-presentation (e.g. chrome hiding) would resurrect the frames.
  const handleRenderer = useCallback((r: Renderer) => {
    rendererRef.current = r
    if (useBoardAppStore.getState().presentationMode) r.setHideFrames(true)
  }, [])
  const queryClient = useQueryClient()

  // Bridge for the agent's post-stream apply block (lives outside this
  // component tree). Closures capture the current store + scope so the
  // applier doesn't need access to React state. Cleared on unmount /
  // scope change.
  useEffect(() => {
    if (!boardId) {
      setAgentBridge(null)
      return
    }
    setAgentBridge({
      applyNoteOutput: (output) =>
        applyNoteOutput(store, queryClient, boardId, rootId, output),
      applyLinkOutput: (output) =>
        applyLinkOutput(store, boardId, output),
    })
    return () => setAgentBridge(null)
  }, [store, queryClient, boardId, rootId])

  // Module-level store ref — lets non-React code (buildMessageContext,
  // other agent helpers) reach the active store without prop-drilling.
  useEffect(() => {
    setCanvasStoreRef(store)
    return () => setCanvasStoreRef(null)
  }, [store])

  // First change subscriber: give undo/redo batches fresh ids so redo isn't
  // dropped by batch-id dedup (local oplog + relay). Must precede persistence
  // + collab so they observe the rewritten id.
  useHistoryBatchIds(store)
  useBoardKeyboard(store)
  useViewportPersistence(store, boardId, rootId, ready)
  // Tracks camera-at-rest so heavy node views (e.g. mini-app iframes) can defer
  // mounting until a pan/scroll stops instead of booting for every node crossed.
  useTrackBoardCameraMotion(store)
  useCenterFromUrl(store, wrapRef, ready)
  const styleMemory = useStyleMemory(store)
  useStampNewEdges(store, boardId, rootId)
  useStampNewNodes(store, boardId, rootId)
  useSidebarContentsSync(store, boardId)
  // The browser agent's local indexes (note search + doc Q&A) must exist whenever
  // the browser agent is the active engine — on local-only boards AND on synced
  // boards in browser-agent mode. Gating on `local` alone left `search_notes` with
  // a null index (empty results for EVERY query) on synced browser-agent boards.
  // Persistence/hydrate below stays gated on `local` — synced boards still sync.
  // Memoized: the flag is reload-stable, so don't read localStorage every render
  // of this hot canvas component.
  const agentLocalIndexes = useMemo(() => isBrowserAgentActive(local), [local])
  useLocalSearchIndex(store, boardId ?? "", agentLocalIndexes)
  useLocalDocIndex(boardId ?? "", agentLocalIndexes)
  useDocNodeCascade(store, boardId ?? "", agentLocalIndexes)
  useBlockFolderCopy(store)
  useHarnessApplyMindMap(store, boardId, rootId)
  useHydrateIconNodes(store, boardId, rootId, ready)
  useThemeColorProjection(store, ready)
  // Local boards store the thumbnail in IndexedDB; capture only at the root
  // layer so the dashboard shows the top-level board, not a sub-board.
  useThumbnailCapture(
    store,
    boardId,
    ready && (!local || !rootId),
    theme.minimap,
    local ? saveLocalThumbnail : undefined,
  )
  usePresentationMode(store, wrapRef, rendererRef)

  // A synced board runs EITHER the legacy WS adapter OR the offline-first
  // coordinator (v2), gated per-board by `BoardMeta.syncEngine` (dev flag as an
  // override). `null` while resolving — hydration below waits on it, so we never
  // mount the wrong client first. Default is v2 (Phase 1 of the backend-agent
  // retirement); a board can be pinned to legacy via `syncEngine: "legacy"`.
  const syncEngine = useSyncEngine(boardId, local)
  const v2 = syncEngine === "v2"
  useWsCollab(store, boardId, ready && !local && !v2, rootId)
  // Fail-closed until the coordinator resolves the role from the ticket: unknown
  // role (null) → no edit affordances / no owner-only Share. Keyed on the board
  // (not rootId), so folder navigation within a board never resets a resolved role.
  useEffect(() => {
    if (v2) {
      setCanEdit(false)
      setBoardRole(null)
    }
  }, [boardId, v2, setCanEdit, setBoardRole])
  useBoardSyncV2(store, boardId, ready && v2, rootId ?? null, (role) => {
    // v2 skips the REST hydrate, so this is where the real role lands (from the
    // collab ticket). Grant edit rights only to owner/member (positive check →
    // fail-closed for null / any future non-editor role); viewers stay read-only.
    setBoardRole(role)
    setCanEdit(role === "owner" || role === "member")
  })
  useLocalPresence(store, wrapRef, ready)

  const { handleCreateDrag } = useCreateHandlers(store, boardId, rootId, styleMemory)
  // Recompute every render — NOT memoized on `styleMemory`. The memory
  // object is intentionally identity-stable for its whole lifetime, so a
  // `useMemo([styleMemory])` would compute once at mount and freeze the
  // edge defaults at their initial (usually empty) value, ignoring every
  // later restyle. The lib reads `arrowDefaults` lazily at edge-draw time
  // (defaultsRef) and keys no effect off it, so a fresh object per render
  // is cheap and is what lets sticky edge styles actually take effect.
  // Factories run lazily at edge-draw time (canvas-harness 0.1.24+), so
  // a fresh arrow-drawn edge enters the store already stamped with
  // scope, version, stored colors, and theme-projected display style.
  // That lets useStampNewEdges' init branch go away — Cmd+Z on a fresh
  // edge now reverts the create in one press.
  const arrowDefaults: ArrowToolDefaults = {
    pathStyle: styleMemory.getEdgePathStyle(),
    style: () => {
      const base = styleMemory.getEdgeStyle() ?? {}
      const stored = resolveStoredEdgeColors(styleMemory.getEdgeStoredColors())
      const mode = getBoardThemeMode()
      const display = mode === "dark" ? adaptEdgeColors(stored, "dark") : stored
      return applyColorsToEdgeStyle(base, display)
    },
    data: () => {
      if (!boardId) return undefined
      return {
        version: 1,
        createdAt: new Date().toISOString(),
        _storedColors: resolveStoredEdgeColors(styleMemory.getEdgeStoredColors()),
        graphUid: boardId,
        parentId: rootId ?? undefined,
      }
    },
  }
  const { onDragOver, onDrop } = useHarnessDropFiles(wrapRef, store, boardId, rootId, canEdit)
  const navigate = useNavigate()

  // Double-click dispatch.
  //
  // canvas-harness's <Canvas> dblclick handler runs BEFORE this consumer
  // callback (see lib's Canvas.tsx) and already does the right thing
  // for every hit kind: node body / edge body / edge label all call
  // `beginEdit(targetId)`; midpoint-handle restores auto-route. So the
  // consumer only needs to (a) override for Dim0's custom node types
  // where the editing surface lives elsewhere, and (b) handle the
  // "truly empty space" case by dropping a quick text node.
  //
  // Earlier this handler branched only on `"nodeId" in hit` and treated
  // edge hits as empty space — which meant a dbl-click on an edge label
  // would clobber the lib's just-started edge-label edit with a brand-new
  // text node. The `if (hit) return` short-circuit (matching the
  // playground) is what prevents that.
  const handleDoubleClick = useCallback(
    (e: CanvasPointerEvent): void => {
      const camera = store.getCamera()
      const hit = hitTestAny(store, e.world, camera.z)

      if (hit) {
        if ("nodeId" in hit) {
          // Override for custom node types where Dim0 owns the editing
          // surface elsewhere (sheet / code-sandbox / widget open via
          // panel; folder dbl-click navigates into the folder; document
          // has no inline editor). Default node types fall through and
          // keep the lib's inline editor.
          const node = store.getNode(hit.nodeId)
          if (node && CUSTOM_NODE_TYPES.has(node.type)) {
            store.cancelEdit()
            if (node.type === "folder" && boardId) {
              // Enter the folder: scope to its layer via the `root_id` search
              // param (local + backend share the mechanism, different routes).
              const search = (prev: Record<string, unknown>) => ({ ...prev, root_id: node.id })
              if (local) {
                navigate({ to: LocalBoardUrl, params: { boardId }, search })
              } else {
                navigate({ to: "/boards/$id", params: { id: boardId }, search })
              }
            }
          }
        }
        // Edge hits: lib already called `beginEdit(edgeId)` — that's
        // exactly the edge-label editor we want. Nothing further to do.
        return
      }

      // Truly-empty space: quick text node + edit. Only in the select
      // tool — other tools have their own click semantics.
      if (e.tool !== "select" || !canEdit || !boardId) return
      const note = createDefaultNote({ boardId, nodeType: "text" })
      if (rootId) note.parentId = rootId
      const size = note.properties.nodeSize?.size ?? { width: 150, height: 20 }
      note.properties.nodePosition = {
        type: "position",
        position: { x: e.world.x - size.width / 2, y: e.world.y - size.height / 2 },
      }
      const styled = applyStyleMemory(noteToNode(note), styleMemory)
      store.addNode(styled)
      store.setSelection([styled.id as NodeId])
      store.beginEdit(styled.id as NodeId)
    },
    [store, boardId, rootId, canEdit, navigate, styleMemory, local],
  )

  // Hydrate on scope change. `cancelled` guards against late-arriving loads
  // when the user navigates rapidly between boards.
  useEffect(() => {
    if (!boardId) {
      setReady(false)
      return
    }
    let cancelled = false
    setReady(false)
    setIsLoading(true)

    // Synced boards: wait until the engine is resolved so we hydrate the right
    // way (v2 skips the REST hydrate). local boards never run a collab client.
    if (!local && syncEngine === null) {
      return () => {
        cancelled = true
      }
    }

    // v2 synced board: the coordinator (useBoardSyncV2) hydrates via the welcome
    // snapshot, so skip the REST content hydrate here (running both would
    // double-apply). Role/canEdit are resolved from the collab ticket by the
    // coordinator's `onRole` and reset fail-closed per-board in a separate effect
    // (below) — NOT here, so folder navigation (a rootId change re-runs this
    // effect) doesn't flicker an editor back to read-only.
    if (v2) {
      setIsLoading(false)
      setReady(true)
      return () => {
        cancelled = true
      }
    }

    // Local-only board: load from IndexedDB + attach local persistence. The
    // analog of the backend hydrate below — it fills the same empty store.
    if (local) {
      let detach: (() => void) | null = null
      let persistence: BoardPersistence | null = null
      void getLocalStores()
        .then((stores) => {
          if (cancelled) return undefined
          // Share the app-wide engine (a desktop build injects SQLite here).
          persistence = new BoardPersistence(boardId, { engine: stores.engine })
          setBoardPersistenceRef(persistence)
          return persistence.load()
        })
        .then((content) => {
          if (cancelled || !content || !persistence) return
          // Project only the current layer into the store (root layer when null);
          // persistence stays whole-board, so other layers are never dropped.
          applyContentToStore(store, content, rootId ?? null)
          detach = persistence.attach(store)
          setCanEdit(true)
          setBoardRole("owner")
          setBoardVisibility("private")
        })
        .catch((err) => {
          if (!cancelled) console.error("[harness] local load failed", err)
        })
        .finally(() => {
          if (cancelled) return
          setIsLoading(false)
          setReady(true)
        })
      return () => {
        cancelled = true
        detach?.()
        setBoardPersistenceRef(null)
        const p = persistence
        if (p) void p.flush().finally(() => p.close())
      }
    }

    hydrateBoardStore(store, {
      boardId,
      rootId: rootId ?? undefined,
      isCancelled: () => cancelled,
    })
      .then(({ graph, canEdit, role }) => {
        if (cancelled) return
        setCanEdit(canEdit)
        setBoardRole(role)
        setBoardLabel(graph.label ?? "")
        if (graph.visibility === "private" || graph.visibility === "public") {
          setBoardVisibility(graph.visibility)
        }
      })
      .catch((err) => {
        if (!cancelled) console.error("[harness] hydrate failed", err)
      })
      .finally(() => {
        if (cancelled) return
        setIsLoading(false)
        setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [boardId, rootId, store, local, v2, syncEngine, setIsLoading, setCanEdit, setBoardRole, setBoardLabel, setBoardVisibility])

  return (
    <CanvasProvider store={store}>
      <HarnessWrapRefProvider value={wrapRef}>
        <div
          ref={wrapRef}
          className="absolute inset-0"
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          <HarnessCanvasInner
            theme={theme}
            tool={tool}
            ready={ready}
            viewMode={viewMode}
            canCollab={!local}
            arrowDefaults={arrowDefaults}
            onCreateDrag={handleCreateDrag}
            onDoubleClick={handleDoubleClick}
            onRenderer={handleRenderer}
          />
          <CanvasContextMenu wrapRef={wrapRef} store={store} rendererRef={rendererRef} />
        </div>
      </HarnessWrapRefProvider>
    </CanvasProvider>
  )
}


type InnerProps = {
  theme: ReturnType<typeof useBoardTheme>
  tool: string
  ready: boolean
  viewMode: "board" | "files" | "list"
  canCollab: boolean
  arrowDefaults: ArrowToolDefaults
  onCreateDrag: ReturnType<typeof useCreateHandlers>["handleCreateDrag"]
  onDoubleClick: (e: CanvasPointerEvent) => void
  onRenderer: (r: Renderer) => void
}


function HarnessCanvasInner({
  theme,
  tool,
  ready,
  viewMode,
  canCollab,
  arrowDefaults,
  onCreateDrag,
  onDoubleClick,
  onRenderer,
}: InnerProps) {
  const renderView = useRenderCustomNodeView()
  const isBoard = viewMode === "board"
  // Hide non-essential chrome (toolbar, viewport controls, minimap)
  // during presentation so the canvas reads as a clean slide. Other
  // already-self-hiding chrome (readonly chip, top-right strip) stays
  // managed by their own components.
  const presenting = useBoardAppStore((s) => s.presentationMode)
  return (
    <>
      {isBoard ? (
        <>
          <Canvas
            tool={tool}
            theme={theme.resolver}
            selectionColor={theme.selectionColor}
            background={theme.background}
            // Desktop (WKWebView) has slower Canvas2D than Chrome, so the lib's
            // area-based default (maxDpr 2 on a mid-size retina board) repaints
            // too many pixels per frame and feels laggy. Cap it lower on desktop
            // — trades a little crispness for smoother pan/zoom. Web keeps the
            // auto default. Tune 1..2 on-device (1 = smoothest, 2 = crispest).
            maxDpr={isTauri() ? 1.5 : undefined}
            renderCustomNodeView={renderView}
            editorAdapter={createHarnessTextareaEditor}
            arrowDefaults={arrowDefaults}
            onCreateDrag={onCreateDrag}
            onDoubleClick={onDoubleClick}
            onRenderer={onRenderer}
          />
          {/*
            Paper grain over the canvas surface: sits above the drawn
            scene (z-index 1) but below all chrome (z-50+), pointer-events
            none so it never intercepts interaction. Hidden while
            presenting for clean slides.
          */}
          {!presenting && <div className="board-paper-grain" aria-hidden="true" />}
          {!presenting && (
            <Minimap
              width={200}
              height={140}
              viewportColor={theme.minimap.viewportColor}
              backgroundColor={theme.minimap.backgroundColor}
              borderColor={theme.minimap.borderColor}
              defaultNodeColor={theme.minimap.defaultNodeColor}
              style={{
                position: "absolute",
                bottom: 16,
                right: 16,
                borderRadius: 6,
                overflow: "hidden",
                zIndex: 50,
              }}
            />
          )}
          {!presenting && <HarnessViewportControls />}
          <StyleSidebar />
          {canCollab && <RemoteCursors />}
          <EmptyBoardCoachmarks ready={ready} />
        </>
      ) : viewMode === "files" ? (
        <LinearView />
      ) : (
        <ListView />
      )}
      {/*
        Always-mounted chrome: toolbar (with view dropdown), save
        status badge, slide-related surfaces. NodeSurfaceHost stays
        mounted everywhere so the modal editor opens from any view.
      */}
      {!presenting && <HarnessToolbar local={!canCollab} />}
      {/*
        Top-right chrome row: save status + share button live in one
        flex container so they never overlap (z-stack collisions cost
        us once already). Each child decides whether to render itself
        — the container is invisible when empty.
      */}
      <div className="absolute right-3 top-3 z-50 flex items-center gap-2">
        {canCollab && <HarnessPeerChip />}
        <HarnessReadonlyChip />
        {/* Local boards have no collab chrome, so surface an explicit
            "On device" badge so they're not mistaken for synced. */}
        {!canCollab && <BoardKindBadge kind="local-only" />}
        {canCollab && <HarnessCollabStatus />}
        {canCollab && <ShareButton />}
      </div>
      <NodeSurfaceHost />
      <SlidesSheet />
      <PresentationOverlay />
    </>
  )
}


/**
 * Right-side Sheet hosting the slides panel. Open state lives on the
 * app store so the toolbar button + keyboard shortcut can toggle it.
 * `modal={false}` + no overlay keeps the canvas interactive while the
 * panel is up (you can still pan / pick a slide on the canvas).
 */
function SlidesSheet() {
  const open = useBoardAppStore((s) => s.slidesPanelOpen)
  const setOpen = useBoardAppStore((s) => s.setSlidesPanelOpen)
  return (
    <Sheet open={open} onOpenChange={setOpen} modal={false}>
      <SheetContent
        side="right"
        showOverlay={false}
        showClose={false}
        className="w-[360px] max-w-[92vw] border-l border-border bg-sidebar p-0 text-sidebar-foreground"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Slides</SheetTitle>
        </SheetHeader>
        <SlidesPanel />
      </SheetContent>
    </Sheet>
  )
}


/** Floating bottom-center controls, only mounted while presenting. */
function PresentationOverlay() {
  const presenting = useBoardAppStore((s) => s.presentationMode)
  if (!presenting) return null
  return <PresentationControls />
}
