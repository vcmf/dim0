// Floating inspect surface for an applet note (read-only).
//
// The applet counterpart to MiniAppPanel, but INSPECT-ONLY: it shows the applet
// larger (a "Preview" tab via AppletRenderer) and its canonical JSX source (a
// read-only, syntax-highlighted "Source" tab) so the author can see what an
// on-canvas error came from. It never mutates `note.content` — editing the source
// with live re-validation is a tracked follow-up (see the applet ADR / plan).
//
// The Preview is ephemeral: it hydrates from the persisted state so it reflects
// the current applet, but interactions here are NOT saved back (the on-canvas node
// remains the source of truth for live state), which sidesteps a two-writer race
// between this panel and the node view mounted behind the backdrop.

import { memo, useCallback, useEffect, useState } from "react"

import { ChartLineIcon } from "@phosphor-icons/react"
import { useNode } from "@canvas-harness/react"
import type { NodeId } from "@canvas-harness/core"

import { CancelPlainIcon, DownloadIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CodeArea } from "@/features/board/components/flow/code-area"
import { AppletRenderer, fetchAppletState } from "@/features/applet/render"
import type { JsonValue } from "@/features/applet/tree"

import type { NoteNodeData } from "../../convert/note-to-node"
import { useBoardAppStore } from "../../store/board-app-store"


export interface AppletPanelProps {
  nodeId: string
  onClose: () => void
}


const PANEL_CLASS =
  "absolute left-1/2 -translate-x-1/2 top-4 bottom-4 md:top-20 md:bottom-[96px] w-[min(960px,calc(100vw-2rem))] z-[55] flex flex-col rounded-lg border bg-background shadow-xl overflow-hidden"


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

  // An applet isn't a surface kind in the on-device list, so publish its live
  // title for the unified breadcrumb (which otherwise can't resolve a leaf here).
  useEffect(() => {
    setActiveSurfaceLabel(label ?? "")
    return () => setActiveSurfaceLabel(null)
  }, [setActiveSurfaceLabel, label])

  const [activeTab, setActiveTab] = useState("preview")

  // Hydrate the preview from persisted state so it mirrors the on-canvas applet;
  // `stateLoaded` gates the render so we don't flash defaults then re-mount.
  const [initialState, setInitialState] = useState<Record<string, JsonValue> | undefined>(undefined)
  const [stateLoaded, setStateLoaded] = useState(false)
  useEffect(() => {
    let active = true
    fetchAppletState(nodeId)
      .then((s) => {
        if (!active) return
        if (s && typeof s === "object") setInitialState(s as Record<string, JsonValue>)
        setStateLoaded(true)
      })
      .catch(() => {
        if (active) setStateLoaded(true)
      })
    return () => {
      active = false
    }
  }, [nodeId])

  const source = (node?.content ?? "").trim()
  const displayTitle = label?.trim() || "Untitled applet"

  const handleDownloadSource = useCallback(() => {
    if (!source) return
    const safeBaseName =
      (label || "applet")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "applet"

    const blob = new Blob([source], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `${safeBaseName}.jsx`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }, [source, label])

  if (!node) {
    return (
      <div className={`${PANEL_CLASS} items-center justify-center gap-3 text-sm text-muted-foreground`}>
        <p>This applet no longer exists.</p>
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    )
  }

  return (
    <div className={PANEL_CLASS} onClick={(e) => e.stopPropagation()}>
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
                <AppletRenderer source={source} initialState={initialState} className="h-full w-full" />
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
