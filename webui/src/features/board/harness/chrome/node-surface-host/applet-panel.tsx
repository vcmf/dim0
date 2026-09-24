// Floating inspect surface for an applet note (read-only).
//
// The applet counterpart to MiniAppPanel, but INSPECT-ONLY: it shows the applet
// larger (a "Preview" tab via AppletRenderer) and its canonical JSX source (a
// read-only, syntax-highlighted "Source" tab) so the author can see what an
// on-canvas error came from. It never mutates `note.content` — editing the source
// with live re-validation is a tracked follow-up (see the applet ADR / plan).
//
// The Preview is ephemeral: interactions here are NOT saved back (the on-canvas
// node remains the source of truth for live state), which sidesteps a two-writer
// race between this panel and the node view mounted behind the backdrop. It
// hydrates from persisted state, so for a `persist` applet it reflects the saved
// state (modulo the node's ~300ms debounce); for a non-`persist` applet nothing is
// saved, so the Preview shows the applet's declared defaults, not the live
// on-canvas state.

import { memo, useCallback, useEffect, useState } from "react"

import { ChartLineIcon } from "@phosphor-icons/react"
import { useNode } from "@canvas-harness/react"
import type { NodeId } from "@canvas-harness/core"

import { CancelPlainIcon, DownloadIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CodeArea } from "@/features/board/components/flow/code-area"
import { AppletRenderer, useAppletInitialState } from "@/features/applet/render"
import { downloadTextFile } from "@/lib/download-file"

import type { NoteNodeData } from "../../convert/note-to-node"
import { useBoardAppStore } from "../../store/board-app-store"
import { SURFACE_PANEL_CLASS } from "./panel-chrome"


export interface AppletPanelProps {
  nodeId: string
  onClose: () => void
}


/**
 * Read-only inspect surface for an applet: a larger Preview render plus the
 * canonical JSX Source (highlighted, non-editable) and a source download. Opened
 * by the node's green traffic-light; closing dispatches back to the store.
 */
export const AppletPanel = memo(function AppletPanel({
  nodeId,
  onClose,
}: AppletPanelProps) {
  const node = useNode(nodeId as NodeId)
  const data = (node?.data ?? {}) as Partial<NoteNodeData>
  const label = data.label?.markdown
  const setActiveSurfaceLabel = useBoardAppStore((s) => s.setActiveSurfaceLabel)

  // Applets are in the on-device surface list, so the breadcrumb normally resolves
  // this leaf from it; publishing the live title covers the gap before that list
  // loads (or when the node isn't in the replica yet, e.g. just created).
  useEffect(() => {
    setActiveSurfaceLabel(label ?? "")
    return () => setActiveSurfaceLabel(null)
  }, [setActiveSurfaceLabel, label])

  const [activeTab, setActiveTab] = useState("preview")

  // Hydrate the preview from persisted state; `stateLoaded` gates the render so we
  // don't flash defaults then re-mount (shared with the on-canvas node view).
  const { initialState, stateLoaded } = useAppletInitialState(nodeId)

  const source = (node?.content ?? "").trim()
  const displayTitle = label?.trim() || "Untitled applet"

  const handleDownloadSource = useCallback(() => {
    downloadTextFile(label || "applet", source, { ext: "jsx", mime: "text/plain;charset=utf-8", fallback: "applet" })
  }, [source, label])

  if (!node) {
    return (
      <div className={`${SURFACE_PANEL_CLASS} items-center justify-center gap-3 text-sm text-muted-foreground`}>
        <p>This applet no longer exists.</p>
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    )
  }

  return (
    <div className={SURFACE_PANEL_CLASS} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 pr-2">
          <ChartLineIcon className="size-4 shrink-0" />
          <span className="block max-w-full truncate text-sm font-semibold text-foreground" title={displayTitle}>
            {displayTitle}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleDownloadSource}
            title="Download .jsx"
            aria-label="Download source"
            disabled={!source}
          >
            <DownloadIcon className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            <CancelPlainIcon className="size-4" />
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="min-h-0 flex-1 gap-0">
        <div className="border-b border-border/70 px-4 py-2">
          <TabsList>
            <TabsTrigger value="preview">Preview</TabsTrigger>
            <TabsTrigger value="source">Source</TabsTrigger>
          </TabsList>
        </div>

        <div className="relative min-h-0 flex-1">
          <div className={activeTab === "preview" ? "flex h-full flex-col overflow-auto scrollbar-thin p-4" : "hidden h-full"}>
            {source ? (
              stateLoaded ? (
                // Natural height (not h-full): each applet visual carries a definite height
                // (chart 220px; graph/map definiteHeight), so letting the content flow lets the
                // `overflow-auto` container above scroll. h-full pinned it to the viewport and
                // the applet-root's `contain: paint` then clipped the overflow, making the bottom
                // (e.g. the step table) unreachable.
                <AppletRenderer source={source} initialState={initialState} className="w-full" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">Loading…</div>
              )
            ) : (
              <div className="flex h-full w-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                Applet source is empty.
              </div>
            )}
          </div>

          <div className={activeTab === "source" ? "flex h-full flex-col bg-background" : "hidden h-full"}>
            <CodeArea value={node.content ?? ""} onChange={() => {}} language="tsx" readOnly />
          </div>
        </div>
      </Tabs>
    </div>
  )
})
