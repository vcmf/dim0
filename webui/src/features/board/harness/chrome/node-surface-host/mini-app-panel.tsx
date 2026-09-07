// Floating editor for a mini-app note.
//
// Same shape as WidgetPanel — Tabs between Rendered (the iframe via
// MiniAppMount) and Code (CodeArea with typescript syntax). Both views
// share the same draft state; debounced autosave persists through the
// harness op log.

import { memo, useCallback, useEffect, useRef, useState } from "react"

import { CancelPlainIcon, DownloadIcon, LayoutIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useCanvasStore, useNode } from "@canvas-harness/react"
import type { NodeId } from "@canvas-harness/core"

import { CodeArea } from "@/features/board/components/flow/code-area"
import { MiniAppMount } from "@/features/mini-app"

import type { NoteNodeData } from "../../convert/note-to-node"
import { useBoardAppStore } from "../../store/board-app-store"


export interface MiniAppPanelProps {
  nodeId: string
  onClose: () => void
}


const PANEL_CLASS =
  "absolute left-1/2 -translate-x-1/2 top-4 bottom-4 md:top-20 md:bottom-[96px] w-[min(960px,calc(100vw-2rem))] z-[55] flex flex-col rounded-lg border bg-background shadow-xl overflow-hidden"


export const MiniAppPanel = memo(function MiniAppPanel({
  nodeId,
  onClose,
}: MiniAppPanelProps) {
  const store = useCanvasStore()
  const node = useNode(nodeId as NodeId)
  const data = (node?.data ?? {}) as Partial<NoteNodeData>
  const setActiveSurfaceLabel = useBoardAppStore((s) => s.setActiveSurfaceLabel)

  // A mini-app isn't a surface kind in the on-device list, so publish its live
  // title for the unified breadcrumb (which otherwise can't resolve a leaf here).
  useEffect(() => {
    setActiveSurfaceLabel(data.label?.markdown ?? "")
    return () => setActiveSurfaceLabel(null)
  }, [setActiveSurfaceLabel, data.label?.markdown])

  const [activeTab, setActiveTab] = useState("rendered")
  const [sourceDraft, setSourceDraft] = useState(node?.content ?? "")
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState(data.label?.markdown ?? "")
  const titleInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setSourceDraft(node?.content ?? "")
  }, [node?.content, nodeId])

  useEffect(() => {
    if (titleEditing) return
    setTitleDraft(data.label?.markdown ?? "")
  }, [data.label?.markdown, titleEditing])

  useEffect(() => {
    if (!titleEditing) return
    const frame = requestAnimationFrame(() => {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [titleEditing])

  // Debounced autosave through the harness op log.
  useEffect(() => {
    if (!node) return
    const timer = window.setTimeout(() => {
      if (sourceDraft === (node.content ?? "")) return
      store.updateNode(nodeId as NodeId, { content: sourceDraft })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [sourceDraft, node, nodeId, store])

  const commitTitle = useCallback(
    (next: string) => {
      const trimmed = next.trim()
      const prev = data.label?.markdown?.trim() ?? ""
      if (trimmed === prev) return
      const prevData = (node?.data ?? {}) as Record<string, unknown>
      store.updateNode(nodeId as NodeId, {
        data: {
          ...prevData,
          label: trimmed ? { markdown: trimmed } : undefined,
        },
      })
    },
    [data.label?.markdown, node?.data, nodeId, store],
  )

  const stopTitleEdit = useCallback(
    (save: boolean) => {
      if (save) commitTitle(titleDraft)
      else setTitleDraft(data.label?.markdown ?? "")
      setTitleEditing(false)
    },
    [commitTitle, titleDraft, data.label?.markdown],
  )

  const handleDownloadSource = useCallback(() => {
    const source = sourceDraft
    if (!source.trim()) return

    const safeBaseName =
      (data.label?.markdown || "mini-app")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "mini-app"

    const blob = new Blob([source], { type: "text/typescript;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `${safeBaseName}.tsx`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }, [sourceDraft, data.label?.markdown])

  if (!node) {
    return (
      <div className={`${PANEL_CLASS} items-center justify-center gap-3 text-sm text-muted-foreground`}>
        <p>This mini-app no longer exists.</p>
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    )
  }

  const source = sourceDraft.trim()
  const displayTitle = data.label?.markdown?.trim() || "Untitled mini-app"

  return (
    <div className={PANEL_CLASS} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 pr-2">
          <LayoutIcon className="size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            {titleEditing ? (
              <input
                ref={titleInputRef}
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={() => stopTitleEdit(true)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    stopTitleEdit(true)
                  }
                  if (event.key === "Escape") {
                    event.preventDefault()
                    stopTitleEdit(false)
                  }
                }}
                className="w-full border-0 border-b border-foreground/30 bg-transparent px-0 py-0.5 text-sm font-semibold text-foreground focus:border-secondary-foreground focus:outline-none"
                placeholder="Untitled mini-app"
              />
            ) : (
              <button
                type="button"
                onClick={() => setTitleEditing(true)}
                className="block max-w-full truncate text-left text-sm font-semibold text-foreground hover:underline"
                title={displayTitle}
              >
                {displayTitle}
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleDownloadSource}
            title="Download .tsx"
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
            <TabsTrigger value="rendered">Rendered</TabsTrigger>
            <TabsTrigger value="code">Code</TabsTrigger>
          </TabsList>
        </div>

        <div className="relative min-h-0 flex-1">
          <div className={activeTab === "rendered" ? "flex h-full flex-col" : "hidden h-full"}>
            {source ? (
              <MiniAppMount
                noteId={nodeId}
                source={source}
                className="h-full w-full border-0 bg-transparent"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                Mini-app source is empty.
              </div>
            )}
          </div>

          <div className={activeTab === "code" ? "flex h-full flex-col bg-background" : "hidden h-full"}>
            <CodeArea
              value={sourceDraft}
              onChange={setSourceDraft}
              language="typescript"
              placeholder={`function Widget() {
  const [count, setCount] = useState(0)
  return (
    <Card className="p-4">
      <div className="text-2xl">{count}</div>
      <Button onClick={() => setCount(count + 1)}>+</Button>
    </Card>
  )
}`}
            />
          </div>
        </div>
      </Tabs>
    </div>
  )
})
