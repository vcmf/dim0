import { memo, useCallback, useEffect, useRef, useState } from "react"
import { CancelPlainIcon, DownloadIcon, LayoutIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useCanvasStore, useNode } from "@canvas-harness/react"
import type { NodeId } from "@canvas-harness/core"
import { CodeArea } from "@/features/board/components/flow/code-area"
import { WidgetIframe } from "@/features/board/components/flow/widget-iframe"
import { buildWidgetDocument } from "@/features/board/components/flow/widget-document"
import type { NoteNodeData } from "../../convert/note-to-node"
import { useBoardAppStore } from "../../store/board-app-store"


export type WidgetPanelProps = {
  nodeId: string
  onClose: () => void
}


const PANEL_CLASS =
  "absolute left-1/2 -translate-x-1/2 top-4 bottom-4 md:top-20 md:bottom-[96px] w-[min(960px,calc(100vw-2rem))] z-[55] flex flex-col rounded-lg border bg-background shadow-xl overflow-hidden"


/**
 * Floating widget editor — tabs between rendered iframe and HTML
 * source (CodeArea, html language). Both views share the same
 * draft state; debounced autosave persists through the harness op
 * log.
 */
export const WidgetPanel = memo(function WidgetPanel({
  nodeId,
  onClose,
}: WidgetPanelProps) {
  const store = useCanvasStore()
  const node = useNode(nodeId as NodeId)
  const data = (node?.data ?? {}) as Partial<NoteNodeData>
  const setActiveSurfaceLabel = useBoardAppStore((s) => s.setActiveSurfaceLabel)

  // A (deprecated) widget isn't a surface kind in the on-device list, so publish
  // its live title for the unified breadcrumb (which otherwise can't resolve a leaf).
  useEffect(() => {
    setActiveSurfaceLabel(data.label?.markdown ?? "")
    return () => setActiveSurfaceLabel(null)
  }, [setActiveSurfaceLabel, data.label?.markdown])

  const [activeTab, setActiveTab] = useState("rendered")
  const [htmlDraft, setHtmlDraft] = useState(node?.content ?? "")
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState(data.label?.markdown ?? "")
  const titleInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setHtmlDraft(node?.content ?? "")
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
      if (htmlDraft === (node.content ?? "")) return
      store.updateNode(nodeId as NodeId, { content: htmlDraft })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [htmlDraft, node, nodeId, store])

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

  const handleDownloadHtml = useCallback(() => {
    const html = htmlDraft
    if (!html.trim()) return

    const safeBaseName =
      (data.label?.markdown || "widget")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "widget"

    const fullHtml = buildWidgetDocument(html, data.label?.markdown || "Widget")
    const blob = new Blob([fullHtml], { type: "text/html;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `${safeBaseName}.html`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }, [htmlDraft, data.label?.markdown])

  if (!node) {
    return (
      <div className={`${PANEL_CLASS} items-center justify-center gap-3 text-sm text-muted-foreground`}>
        <p>This widget no longer exists.</p>
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    )
  }

  const html = htmlDraft.trim()
  const displayTitle = data.label?.markdown?.trim() || "Untitled widget"

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
                placeholder="Untitled widget"
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
            onClick={handleDownloadHtml}
            title="Download HTML"
            aria-label="Download HTML"
            disabled={!html}
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
            {html ? (
              <WidgetIframe
                html={html}
                title="Widget"
                className="h-full w-full border-0 bg-transparent"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                Widget HTML is empty.
              </div>
            )}
          </div>

          <div className={activeTab === "code" ? "flex h-full flex-col bg-background" : "hidden h-full"}>
            <CodeArea
              value={htmlDraft}
              onChange={setHtmlDraft}
              language="html"
              placeholder={`<section style="padding:24px;">
  <h1>Hello widget</h1>
  <p>Use var(--card), var(--foreground), var(--border), var(--radius), and var(--shadow-sm).</p>
</section>`}
            />
          </div>
        </div>
      </Tabs>
    </div>
  )
})
