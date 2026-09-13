// On-canvas view for an applet note.
//
// Unlike the legacy mini-app (a ~5 MB sandboxed iframe with deferred mounting),
// an applet renders INLINE as lightweight React via AppletRenderer — so this view
// just wraps it in the standard canvas chrome (traffic lights + title caption) and
// gates pointer events on selection so canvas pan/zoom passes cleanly through
// unselected applets. State is hydrated from / persisted to the local store.

import { useCallback, useEffect, useRef } from "react"

import { ChartLineIcon } from "@phosphor-icons/react"
import { type NodeId } from "@canvas-harness/core"
import { useCanvasStore, useNode, useSelection } from "@canvas-harness/react"

import { AppletRenderer, deleteAppletState, saveAppletState, useAppletInitialState } from "@/features/applet/render"
import { removeNodeSubtree } from "@/features/board/harness/graph/subtree"
import { cn } from "@/lib/utils"

import type { NoteNodeData } from "../../convert/note-to-node"
import { NodeTitleCaption, NodeTrafficLights } from "../../shared-views"
import { useBoardAppStore } from "../../store/board-app-store"


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

  // Hydrate persisted state before mounting the renderer, so the applet inits with
  // saved state instead of flashing defaults then re-mounting (shared with the
  // inspect surface).
  const { initialState, stateLoaded } = useAppletInitialState(noteId)

  // Debounce persistence: a rapidly-updating applet (slider, text field) would
  // otherwise issue an IndexedDB write per keystroke. Coalesce to one write ~300ms
  // after the last change, and flush the pending state on unmount.
  const pendingState = useRef<Record<string, unknown> | null>(null)
  const persistTimer = useRef<number | null>(null)
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

  if (!node) return null

  const data = (node.data ?? {}) as Partial<NoteNodeData>
  const label = data.label?.markdown
  const source = node.content ?? ""

  return (
    <div className="pointer-events-none relative h-full w-full select-none">
      <div className="absolute inset-0 flex flex-col overflow-hidden rounded-2xl border border-border bg-background px-2 pb-2 pt-10">
        <div
          className={cn(
            "scrollbar-thin relative h-full w-full overflow-auto rounded-xl border border-border/50 bg-background",
            isSelected ? "pointer-events-auto" : "pointer-events-none",
          )}
        >
          {source && stateLoaded ? (
            <AppletRenderer source={source} initialState={initialState} onPersist={onPersist} className="h-full w-full" />
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
