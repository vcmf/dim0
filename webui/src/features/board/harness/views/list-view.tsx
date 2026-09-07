import { memo, useCallback } from "react"
import { useNavigate } from "@tanstack/react-router"
import type { Node, NodeId } from "@canvas-harness/core"
import { useCanvasStore } from "@canvas-harness/react"
import { removeNodeSubtree } from "@/features/board/harness/graph/subtree"
import {
  ConsoleIcon,
  DeleteIcon,
  FolderIcon,
  LearnWidgetIcon,
  NotepadIcon,
  PdfIcon,
  type AppIconComponent,
} from "@/components/icons"
import { IconPropertyView } from "@/components/icons/icon-property-view"
import { formatDistanceToNow } from "@/features/board/utils/date"
import { nodeStamp } from "@/features/board/utils/node-meta"
import type { IconProperty } from "@/features/newsfeed/types/properties"
import { useDocumentLikeNodes } from "../canvas/use-document-like-nodes"
import type { NoteNodeData } from "../convert/note-to-node"
import {
  useBoardAppStore,
  type NodeSurfaceKind,
} from "../store/board-app-store"


type RowMeta = {
  icon: AppIconComponent
  /** User-picked icon (any node kind); falls back to `icon` when unset. */
  customIcon?: IconProperty["icon"] | null
  label: string
  surfaceKind?: NodeSurfaceKind
  isFolder?: boolean
}


/**
 * Resolve an icon, label, and click behavior for a list row. Folders
 * navigate to the subboard via the router; everything else opens its
 * surface modal via the existing `openNodeSurface` action.
 */
const metaOf = (node: Node): RowMeta => {
  const data = (node.data ?? {}) as Partial<NoteNodeData>
  const label = data.label?.markdown?.trim() ?? ""
  const customIcon = data.properties?.iconData?.icon ?? null
  switch (node.type) {
    case "folder":
      return { icon: FolderIcon, customIcon, label: label || "Untitled folder", isFolder: true }
    case "document":
      return { icon: PdfIcon, customIcon, label: label || "Untitled document" }
    case "widget":
      return { icon: LearnWidgetIcon, customIcon, label: label || "Untitled widget", surfaceKind: "widget" }
    case "code-sandbox":
      return {
        icon: ConsoleIcon,
        customIcon,
        label: label || "Untitled sandbox",
        surfaceKind: "code-sandbox",
      }
    default:
      return { icon: NotepadIcon, customIcon, label: label || "Untitled note", surfaceKind: "sheet" }
  }
}


type RowProps = {
  node: Node
  index: number
  isLast: boolean
}


/**
 * OS-Finder-style row. Hanging tree connector on the left, icon +
 * label + relative date in the middle, delete-on-hover at the right.
 * Double-click opens the surface or navigates into a folder.
 */
const ListRow = memo(function ListRow({ node, index, isLast }: RowProps) {
  const store = useCanvasStore()
  const navigate = useNavigate()
  const boardId = useBoardAppStore((s) => s.boardId)
  const canEdit = useBoardAppStore((s) => s.canEdit)
  const openNodeSurface = useBoardAppStore((s) => s.openNodeSurface)
  const meta = metaOf(node)
  const Icon = meta.icon
  const data = node.data as Partial<NoteNodeData> | undefined
  // Canonical `meta` (agent notes) or legacy top-level strings — same stamp the
  // sheet card shows.
  const { text: timeAgo, tooltip: fullDate } = formatDistanceToNow(
    nodeStamp(data).iso,
  )

  const handleOpen = useCallback(() => {
    if (meta.isFolder) {
      if (!boardId) return
      navigate({
        to: "/boards/$id",
        params: { id: boardId },
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          root_id: node.id as unknown as string,
        }),
      })
      return
    }
    if (!canEdit || !meta.surfaceKind) return
    openNodeSurface(node.id as unknown as string, meta.surfaceKind)
  }, [meta, boardId, navigate, node.id, canEdit, openNodeSurface])

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      removeNodeSubtree(store, node.id as NodeId)
    },
    [store, node.id],
  )

  return (
    <div className="group relative pl-12">
      {/* hanging tree connector */}
      <div className="pointer-events-none absolute left-0 top-0 h-full w-10">
        {index > 0 ? (
          <div className="absolute left-5 top-0 bottom-1/2 w-px bg-border/80 transition-colors group-hover:bg-foreground/45" />
        ) : null}
        {!isLast ? (
          <div className="absolute left-5 top-1/2 bottom-0 w-px bg-border/80 transition-colors group-hover:bg-foreground/45" />
        ) : null}
        <div className="absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 rounded-bl-md border-b border-l border-border/80 transition-colors group-hover:border-foreground/45" />
      </div>

      <div
        className="flex min-h-11 select-none items-center gap-3 rounded-md border border-transparent px-3 py-2 transition-colors group-hover:border-border/70 group-hover:bg-accent/30"
        onMouseDown={(e) => {
          if (e.detail > 1) e.preventDefault()
        }}
        onDoubleClick={handleOpen}
        title={`Double-click to open ${meta.label}`}
      >
        {meta.customIcon ? (
          <span className="shrink-0">
            <IconPropertyView icon={meta.customIcon} size={20} />
          </span>
        ) : (
          <Icon className="size-5 shrink-0 text-muted-foreground" strokeWidth={1.9} />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {meta.label}
        </span>
        {timeAgo ? (
          <span
            className="hidden shrink-0 text-xs text-muted-foreground md:block"
            title={fullDate}
          >
            {timeAgo}
          </span>
        ) : null}
        {canEdit ? (
          <button
            type="button"
            onClick={handleDelete}
            className="rounded-md p-1 text-foreground/55 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
            aria-label={`Delete ${meta.label}`}
            title="Delete"
          >
            <DeleteIcon className="size-4" strokeWidth={2} />
          </button>
        ) : null}
      </div>
    </div>
  )
})


/**
 * Lightweight, OS-finder-style index of document-like nodes on the
 * current scope. Sorted by `listOrder`. Reorder happens in the Files
 * view; this view is read-mostly with double-click-to-open + delete.
 */
export const ListView = memo(function ListView() {
  const store = useCanvasStore()
  const nodes = useDocumentLikeNodes(store)
  return (
    <div className="absolute inset-0 h-full w-full overflow-y-auto overflow-x-hidden scrollbar-thin">
      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-0 px-4 pb-8 pt-24 md:px-8 md:pb-20 md:pt-28">
        {nodes.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Nothing to list yet. Add a note, folder, or document from the toolbar.
          </div>
        ) : (
          nodes.map((node, index) => (
            <ListRow
              key={node.id as unknown as string}
              node={node}
              index={index}
              isLast={index === nodes.length - 1}
            />
          ))
        )}
      </div>
    </div>
  )
})
