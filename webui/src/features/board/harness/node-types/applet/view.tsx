// On-canvas view for an applet note.
//
// Unlike the legacy mini-app (a ~5 MB sandboxed iframe with deferred mounting),
// an applet renders INLINE as lightweight React via AppletRenderer — so this view
// just wraps it in the standard canvas chrome (traffic lights + title caption) and
// gates pointer events on selection so canvas pan/zoom passes cleanly through
// unselected applets. State is hydrated from / persisted to the local store.
//
// Zoomed out / off-screen, the node shows the cheap canvas placeholder (drawAppletPlaceholder),
// exactly like the `sheet` node type — no snapshot bitmaps in the LOD path. (`snapshotApplet`
// exists only for on-demand PNG/SVG export of selected nodes, not for this placeholder.)

import { useCallback, useEffect, useMemo, useRef } from "react"

import { ChartLineIcon } from "@phosphor-icons/react"
import { type NodeId } from "@canvas-harness/core"
import { useCanvasStore, useNode, useSelection } from "@canvas-harness/react"

import { AppletRenderer, deleteAppletState, saveAppletState, useAppletInitialState } from "@/features/applet/render"
import { removeNodeSubtree } from "@/features/board/harness/graph/subtree"
import { cn } from "@/lib/utils"

import type { NoteNodeData } from "../../convert/note-to-node"
import { createDeferredMount, NodeTitleCaption, NodeTrafficLights } from "../../shared-views"
import { useBoardAppStore } from "../../store/board-app-store"


// Bounded pool of LIVE applet views. Unlike the mini-app's ~5 MB iframes, an applet is
// lightweight React — but on a hundreds-of-applets board we still cap how many run the
// interpreter + live canvases at once (the rest show the canvas placeholder). Cap 10,
// slightly above the mini-app's 8 since applets are cheaper; tune post-measurement.
const useAppletMount = createDeferredMount({ cap: 10 })


export interface AppletViewProps {
  id: NodeId
}


/**
 * Canvas view for an applet note. Loads persisted state, then renders the applet
 * inline; interaction is enabled only when the node is selected so board gestures
 * aren't captured by an idle widget.
 */
export function AppletNodeView({ id }: AppletViewProps) {
  const node = useNode(id)
  const store = useCanvasStore()
  const canEdit = useBoardAppStore((s) => s.canEdit)
  const openNodeSurface = useBoardAppStore((s) => s.openNodeSurface)
  const selection = useSelection()
  const isSelected = selection.includes(id)
  const noteId = id as unknown as string
  const source = node?.content ?? ""

  const wrapRef = useRef<HTMLDivElement>(null) // outer box → drives in-view / retention

  // Deferred mount: bound how many applets run live at once. `isSelected` overrides so
  // an interacting applet always hydrates immediately regardless of the pool.
  const { shouldMount, isInView } = useAppletMount(noteId, wrapRef)

  // Hydrate persisted state before mounting the renderer, so the applet inits with
  // saved state instead of flashing defaults then re-mounting (shared with the
  // inspect surface).
  const { initialState, stateLoaded } = useAppletInitialState(noteId)

  // Debounce persistence: a rapidly-updating applet (slider, text field) would
  // otherwise issue an IndexedDB write per keystroke. Coalesce to one write ~300ms
  // after the last change, and flush the pending state on unmount.
  const pendingState = useRef<Record<string, unknown> | null>(null)
  const persistTimer = useRef<number | null>(null)
  /** Persist the latest pending applet state now: cancel any debounce timer and, if a
   *  change is pending, write it to the local store. Called on the debounced settle and
   *  once on unmount so the final state isn't lost. */
  const flushPersist = useCallback(() => {
    if (persistTimer.current !== null) {
      clearTimeout(persistTimer.current)
      persistTimer.current = null
    }
    if (pendingState.current !== null) {
      void saveAppletState(noteId, pendingState.current)
      pendingState.current = null
    }
  }, [noteId])
  const onPersist = useCallback(
    (next: Record<string, unknown>) => {
      pendingState.current = next
      if (persistTimer.current !== null) clearTimeout(persistTimer.current)
      persistTimer.current = window.setTimeout(flushPersist, 300)
    },
    [flushPersist],
  )
  useEffect(() => () => flushPersist(), [flushPersist])

  // Live iff mounted-by-the-pool (or selected) and ready to render.
  const live = (shouldMount || isSelected) && !!source && stateLoaded

  // Memoize the renderer element (stable across re-renders driven by isInView/isSelected,
  // e.g. a pan settle or a select) so React skips re-reconciling the interpreted subtree —
  // AppletRenderer isn't memoized and would otherwise re-interpret on every such re-render.
  const appletEl = useMemo(
    () => <AppletRenderer source={source} initialState={initialState} onPersist={onPersist} className="h-full w-full" />,
    [source, initialState, onPersist],
  )

  if (!node) return null

  const data = (node.data ?? {}) as Partial<NoteNodeData>
  const label = data.label?.markdown

  return (
    <div ref={wrapRef} className="pointer-events-none relative h-full w-full select-none">
      <div
        className="absolute inset-0 flex flex-col overflow-hidden rounded-2xl border border-border bg-background px-2 pb-2 pt-10"
        // Retained-but-off-screen: keep the live tree mounted (no re-interpret) but skip
        // its paint/layout — restores instantly on return, no re-mount flash. A selected
        // applet stays painted so its interaction never blanks.
        style={{ contentVisibility: shouldMount && !isInView && !isSelected ? "hidden" : undefined }}
      >
        <div
          className={cn(
            "scrollbar-thin relative h-full w-full overflow-auto rounded-xl border border-border/50 bg-background",
            isSelected ? "pointer-events-auto" : "pointer-events-none",
          )}
        >
          {live ? (
            appletEl
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground">
              <ChartLineIcon className="size-5 shrink-0" />
              <span>{source ? "Loading…" : "Applet source will render here"}</span>
            </div>
          )}
        </div>
      </div>

      {/* Green traffic-light opens the read-only inspect surface (larger Preview
          + the canonical JSX Source). Editing the source in-place with live
          re-validation is a tracked follow-up (see the applet ADR / plan). */}
      <NodeTrafficLights
        onDelete={
          canEdit
            ? () => {
                void deleteAppletState(noteId) // don't orphan the persisted state row
                removeNodeSubtree(store, id)
              }
            : undefined
        }
        onExpand={canEdit ? () => openNodeSurface(noteId, "applet") : undefined}
      />

      <div className="pointer-events-auto absolute left-1/2 top-full z-20 mt-2 w-full -translate-x-1/2">
        <NodeTitleCaption
          nodeId={id}
          label={label}
          placeholder="Untitled applet"
          textClassName="text-center text-sm font-handwriting text-foreground"
        />
      </div>
    </div>
  )
}
