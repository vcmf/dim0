import * as React from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { useCanvasStore } from "@canvas-harness/react"
import { asNodeId } from "@canvas-harness/core"
import { CaretRightIcon, DotsThreeIcon } from "@phosphor-icons/react"
import { LocalBoardUrl } from "@/routes"
import { cn } from "@/lib/utils"
import {
  CodeFileIcon,
  FolderIcon,
  NotepadIcon,
  PencilEditIcon,
  StockWidgetIcon,
  type AppIconComponent,
} from "@/components/icons"
import { IconPropertyView } from "@/components/icons/icon-property-view"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { BoardContentKind } from "@/features/board/api/list-board-contents"
import { useLocalBoardContents } from "@/features/board/api/list-local-board-contents"
import { applyTitleUpdateToBoardContents } from "@/features/board/api/apply-title-update-to-board-contents"
import type { BoardContentItem } from "@/features/board/api/list-board-contents"
import { renameNoteOffScene } from "@/features/board/harness/chrome/node-surface-host/use-off-scene-note"
import { useBoardAppStore } from "@/features/board/harness/store/board-app-store"
import { buildNodePath, type CrumbSegment } from "./build-node-path"


const ICON_BY_KIND: Record<BoardContentKind, AppIconComponent | null> = {
  folder: FolderIcon,
  sheet: NotepadIcon,
  "code-sandbox": CodeFileIcon,
  widget: StockWidgetIcon,
}


/** Kind icon (custom user icon wins) for one crumb, at the given pixel size. */
function CrumbIcon({ segment, size }: { segment: CrumbSegment; size: number }) {
  if (segment.icon) {
    return <IconPropertyView icon={segment.icon} size={size} className="shrink-0 opacity-70" />
  }
  const Icon = ICON_BY_KIND[segment.kind]
  return Icon ? <Icon className="shrink-0 opacity-70" style={{ width: size, height: size }} strokeWidth={2} /> : null
}


const Caret = () => <CaretRightIcon className="size-3 shrink-0 text-muted-foreground/70" />


type Props = {
  /** Local (no-backend) board — picks the route for crumb navigation. */
  local: boolean
}


/**
 * Persistent location bar for the board — a single breadcrumb, mounted once above
 * the surface backdrop, that always reflects the *deepest* context:
 * `[Board name] › … › [Leaf ✎]`. The leaf is the open surface (sheet / sub-page /
 * code / widget) when one is open, else the current folder layer. The middle
 * collapses to a `…` dropdown; the leaf is always inline-editable.
 *
 * Hidden at the board root with nothing open (no leaf to show). Reads the flat
 * surface list from the on-device replica (works for local and synced boards),
 * which is invalidated on every rename / move so labels stay live.
 */
export function BoardBreadcrumb({ local }: Props) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const liveStore = useCanvasStore()

  const boardId = useBoardAppStore((s) => s.boardId)
  const boardLabel = useBoardAppStore((s) => s.boardLabel)
  const rootId = useBoardAppStore((s) => s.rootId)
  const activeNodeSurface = useBoardAppStore((s) => s.activeNodeSurface)
  const activeSurfaceRename = useBoardAppStore((s) => s.activeSurfaceRename)
  const openNodeSurface = useBoardAppStore((s) => s.openNodeSurface)
  const closeNodeSurface = useBoardAppStore((s) => s.closeNodeSurface)

  // Deepest node: the open surface wins over the folder layer (its parentId chain
  // already includes any folder ancestors).
  const leafId = activeNodeSurface?.nodeId ?? rootId ?? null

  // Only load once there's a leaf to show — the bar is hidden at the board root,
  // so gating on leafId avoids an eager oplog replay for nothing.
  const { data: items } = useLocalBoardContents(boardId ?? "", {
    enabled: Boolean(boardId) && Boolean(leafId),
  })
  const segments = React.useMemo(() => buildNodePath(items, leafId), [items, leafId])

  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState("")
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  // The leaf the current edit began on — guards a blur/commit that lands after the
  // leaf changed mid-edit (e.g. a subpage navigation) from renaming the new leaf.
  const editingLeafRef = React.useRef<string | null>(null)

  const leaf = segments[segments.length - 1]
  const ancestors = segments.slice(0, -1)
  const rawLeafLabel = React.useMemo(
    () => (leafId ? items?.find((i) => i.id === leafId)?.label ?? "" : ""),
    [items, leafId],
  )

  // Reset the draft whenever the leaf (or its label) changes while not editing.
  React.useEffect(() => {
    if (!editing) setDraft(rawLeafLabel ?? "")
  }, [rawLeafLabel, editing])

  React.useEffect(() => {
    if (!editing) return
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [editing])

  // If the leaf changes while editing (e.g. a subpage navigation), abandon the
  // in-flight edit so a blur/commit can't rename the new leaf with the old draft.
  React.useEffect(() => {
    setEditing(false)
    editingLeafRef.current = null
  }, [leafId])

  const startEdit = React.useCallback(() => {
    editingLeafRef.current = leafId
    setEditing(true)
  }, [leafId])

  const navigateToLayer = React.useCallback(
    (layerId: string | null) => {
      if (!boardId) return
      const clearOrSet = (prev: Record<string, unknown>) => {
        const next = { ...prev }
        if (layerId) next.root_id = layerId
        else delete next.root_id
        return next
      }
      if (local) navigate({ to: LocalBoardUrl, params: { boardId }, search: clearOrSet })
      else navigate({ to: "/boards/$id", params: { id: boardId }, search: clearOrSet })
    },
    [boardId, local, navigate],
  )

  const goRoot = React.useCallback(() => {
    closeNodeSurface()
    navigateToLayer(null)
  }, [closeNodeSurface, navigateToLayer])

  const onCrumbClick = React.useCallback(
    (segment: CrumbSegment) => {
      if (segment.kind === "folder") {
        closeNodeSurface()
        navigateToLayer(segment.id)
        return
      }
      openNodeSurface(segment.id, segment.kind)
    },
    [closeNodeSurface, navigateToLayer, openNodeSurface],
  )

  const commit = React.useCallback(
    (save: boolean) => {
      const editLeaf = editingLeafRef.current
      setEditing(false)
      editingLeafRef.current = null
      // Bail if cancelled, or if the leaf moved out from under the edit — never
      // rename a node other than the one the edit began on.
      if (!save || !boardId || !leafId || editLeaf !== leafId) return
      const trimmed = draft.trim()
      if (trimmed === (rawLeafLabel ?? "").trim()) return
      // The open surface owns its store — rename through the panel's registered
      // hook (which does its own optimistic patch). Otherwise write directly: the
      // live store for an on-canvas leaf (top-level sheet / code / widget), else a
      // one-shot off-scene rename for a folder in a parent layer.
      if (activeNodeSurface?.nodeId === leafId && activeSurfaceRename) {
        activeSurfaceRename(trimmed)
        return
      }
      // Optimistic sidebar/breadcrumb update so the rename shows before the
      // store invalidation / off-scene flush lands.
      queryClient.setQueriesData<BoardContentItem[]>(
        { queryKey: ["localBoardContents", boardId] },
        (old) => applyTitleUpdateToBoardContents(old, leafId, trimmed || null),
      )
      const liveLeaf = liveStore.getNode(asNodeId(leafId))
      if (liveLeaf) {
        const prev = (liveLeaf.data ?? {}) as Record<string, unknown>
        liveStore.updateNode(asNodeId(leafId), {
          data: { ...prev, label: trimmed ? { markdown: trimmed } : undefined },
        })
      } else {
        void renameNoteOffScene(liveStore, boardId, leafId, trimmed)
      }
    },
    [
      boardId,
      leafId,
      draft,
      rawLeafLabel,
      queryClient,
      activeNodeSurface,
      activeSurfaceRename,
      liveStore,
    ],
  )

  if (!boardId || !leafId || !leaf) return null

  return (
    <nav
      aria-label="Breadcrumb"
      onClick={(e) => e.stopPropagation()}
      className="absolute left-3 top-3 z-[60] flex max-w-[70vw] items-center gap-1 overflow-hidden rounded-md border border-border bg-background/95 px-2 py-1 shadow-sm backdrop-blur"
    >
      {/* Board root — real board name; clears the layer + closes any surface. */}
      <button
        type="button"
        onClick={goRoot}
        title={boardLabel || "Board"}
        className="max-w-[160px] shrink-0 truncate rounded px-1 py-0.5 text-sm font-normal text-muted-foreground transition-colors hover:text-foreground hover:underline"
      >
        {boardLabel || "Board"}
      </button>

      {/* Middle ancestors collapse into a single dropdown when there are ≥2
          non-root segments; a lone leaf renders no collapse. */}
      {ancestors.length > 0 && (
        <>
          <Caret />
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Show intermediate levels"
              className="flex shrink-0 items-center rounded px-1 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <DotsThreeIcon className="size-4" weight="bold" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[200px]">
              {ancestors.map((segment) => (
                <DropdownMenuItem
                  key={segment.id}
                  onClick={() => onCrumbClick(segment)}
                  className="gap-2"
                >
                  <CrumbIcon segment={segment} size={16} />
                  <span className="truncate">{segment.label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}

      <Caret />

      {/* Leaf — always inline-editable. */}
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(true)}
          onKeyDown={(e) => {
            // Keep typing (and Esc) inside the input: the surface host and canvas
            // both listen on window — Esc would close the open surface and letter
            // keys would fire tool shortcuts.
            e.stopPropagation()
            if (e.key === "Enter") {
              e.preventDefault()
              commit(true)
            }
            if (e.key === "Escape") {
              e.preventDefault()
              commit(false)
            }
          }}
          placeholder="Untitled"
          className="min-w-0 max-w-[220px] flex-1 border-0 border-b border-foreground/30 bg-transparent px-0 py-0 text-sm text-foreground focus:border-secondary-foreground focus:outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={startEdit}
          title={`${leaf.label} — click to rename`}
          className={cn(
            "group flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-sm font-medium text-foreground",
            "transition-colors hover:bg-muted/60",
          )}
        >
          <CrumbIcon segment={leaf} size={14} />
          <span className="max-w-[220px] truncate">{leaf.label}</span>
          <PencilEditIcon
            className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
            strokeWidth={2}
          />
        </button>
      )}
    </nav>
  )
}
