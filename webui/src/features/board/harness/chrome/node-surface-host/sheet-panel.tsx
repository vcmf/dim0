import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useCanvasStore, useNode } from "@canvas-harness/react"
import type { NodeId } from "@canvas-harness/core"
import { CancelPlainIcon, DownloadIcon } from "@/components/icons"
import { NoteIconControl } from "@/components/icons/note-icon-control"
import { Button } from "@/components/ui/button"
import { applyIconUpdateToBoardContents } from "@/features/board/api/apply-icon-update-to-board-contents"
import { applyTitleUpdateToBoardContents } from "@/features/board/api/apply-title-update-to-board-contents"
import { useGetNote } from "@/features/board/api/get-note"
import { useGetNotePath } from "@/features/board/api/get-note-path"
import type { BoardContentItem } from "@/features/board/api/list-board-contents"
import { useUpdateNote } from "@/features/board/api/update-note"
import { SheetEditor } from "@/features/board/components/sheet/sheet-editor"
import {
  SheetBreadcrumb,
  type BreadcrumbSegmentKind,
} from "@/features/board/components/sheet/sheet-breadcrumb"
import { SheetStackBackground } from "@/features/board/components/sheet/sheet-stack-background"
import { createBoardPageProvider } from "@/features/board/providers/board-page-provider"
import type { Note, NoteProperties } from "@/features/board/types/note"
import type { IconProperty } from "@/features/newsfeed/types/properties"
import type { NoteNodeData } from "../../convert/note-to-node"
import { useBoardAppStore } from "../../store/board-app-store"
import { useOffSceneNote } from "./use-off-scene-note"


export type SheetPanelProps = {
  nodeId: string
  onClose: () => void
}


const PANEL_CLASS =
  "absolute left-1/2 -translate-x-1/2 top-4 bottom-4 md:top-20 md:bottom-[96px] w-[min(900px,calc(100vw-2rem))] z-[55] flex flex-col rounded-lg border bg-card shadow-xl overflow-visible"


/**
 * Floating sheet editor — TipTap markdown editor backed by either the
 * canvas-harness store (sheets that live on the current canvas) or a
 * direct REST fetch (sub-pages reached from the editor's `/subpage`
 * slash command, which never enter the local scene). Mirrors prod's
 * local-or-remote pattern in sheet-node-panel.tsx.
 */
export const SheetPanel = memo(function SheetPanel({
  nodeId,
  onClose,
}: SheetPanelProps) {
  const liveStore = useCanvasStore()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const liveNode = useNode(nodeId as NodeId)
  const activeBoardId = useBoardAppStore((s) => s.boardId)
  const openNodeSurface = useBoardAppStore((s) => s.openNodeSurface)

  // A sub-page lives in a layer that isn't on the canvas, so it's absent from the
  // live store. Load it OFF-SCENE from the local replica — read + sync-correct
  // edit — instead of the REST path, which 404s for a local (unsynced) board.
  const off = useOffSceneNote(liveStore, activeBoardId ?? null, nodeId, !liveNode)
  const localNode = liveNode ?? off.node
  // The store that actually holds the note: the live canvas store for an on-canvas
  // sheet, else the off-scene store (whose edits sync via its own change wiring).
  const store = liveNode ? liveStore : off.store ?? liveStore
  const localData = (localNode?.data ?? {}) as Partial<NoteNodeData>
  const isLocalNote = !!localNode
  // While the off-scene load is in flight we don't yet know if the note exists —
  // don't flash "no longer exists".
  const offSceneLoading = !liveNode && !!activeBoardId && !off.ready

  // REST fallback ONLY for a synced note not yet materialized locally: the
  // off-scene load has settled (`off.ready`) without finding it in the replica.
  const { data: fetchedNote, isLoading: isFetchingNote } = useGetNote({
    boardId: activeBoardId ?? undefined,
    noteId: nodeId,
    enabled: !isLocalNote && off.ready && !!activeBoardId,
  })

  // Resolved view of the note — prefer local store, fall back to fetch.
  // `boardId` ends with the note's own graphUid when known, so per-note
  // API calls (path, update, subpages) hit the right graph even for
  // sheets that belong to a different sub-graph.
  const noteLabel = localData.label?.markdown ?? fetchedNote?.label?.markdown
  const noteContent =
    localNode?.content ?? fetchedNote?.content?.markdown ?? ""
  const boardId =
    localData.graphUid ?? fetchedNote?.graphUid ?? activeBoardId ?? null
  const exists = isLocalNote || !!fetchedNote

  const { data: notePath = [] } = useGetNotePath({
    boardId: boardId ?? undefined,
    noteId: nodeId,
    // Mirror the useGetNote gate above: a local note's path is resolved from the
    // store/local breadcrumb, never the backend (which 401s logged-out).
    enabled: !isLocalNote && !!boardId,
  })
  const ancestors = useMemo(() => notePath.slice(0, -1), [notePath])
  // The open note's live title/icon are `noteLabel` / its iconData (store for
  // local notes, fetch for sub-pages); the path's trailing segment can lag a
  // just-made rename or icon change, so override it. Ancestor crumbs resolve
  // their own live values inside the breadcrumb.
  const liveIcon =
    localData.properties?.iconData?.icon ??
    fetchedNote?.properties?.iconData?.icon ??
    null
  const lastSegment = notePath[notePath.length - 1]
  const currentSegment: Note | undefined = lastSegment
    ? {
        ...lastSegment,
        label: noteLabel ? { markdown: noteLabel } : lastSegment.label,
        properties: {
          ...lastSegment.properties,
          iconData: liveIcon ? { type: "icon", icon: liveIcon } : { type: "icon" },
        },
      }
    : undefined

  // Page provider — backs TipTap's /subpage slash command. List/get
  // hit the board API; create inserts a new sheet under this one;
  // onNavigate opens the target subpage as the active surface so
  // clicking a subpage ref inside the editor switches to it.
  const pageProvider = useMemo(() => {
    if (!boardId) return null
    return createBoardPageProvider({
      boardId,
      parentNoteId: nodeId,
      onNavigate: (id) => openNodeSurface(id, "sheet"),
    })
  }, [boardId, nodeId, openNodeSurface])

  const handleSegmentClick = useCallback(
    (note: Note, kind: BreadcrumbSegmentKind) => {
      if (kind === "folder") {
        onClose()
        if (boardId) {
          navigate({
            to: "/boards/$id",
            params: { id: boardId },
            search: (prev: Record<string, unknown>) => ({
              ...prev,
              root_id: note.id,
            }),
          })
        }
        return
      }
      if (kind === "sheet" || kind === "code-sandbox" || kind === "widget") {
        openNodeSurface(note.id, kind)
      }
    },
    [boardId, navigate, onClose, openNodeSurface],
  )

  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState(noteLabel ?? "")
  const titleInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (titleEditing) return
    setTitleDraft(noteLabel ?? "")
  }, [noteLabel, titleEditing])

  useEffect(() => {
    if (!titleEditing) return
    const frame = requestAnimationFrame(() => {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [titleEditing])

  const { mutate: updateNoteMutate } = useUpdateNote()
  const persistRemote = useCallback(
    (patch: Partial<Note>) => {
      if (!boardId) return
      updateNoteMutate({ boardId, noteId: nodeId, noteData: patch })
    },
    [boardId, nodeId, updateNoteMutate],
  )

  const persistTitle = useCallback(
    (next: string) => {
      const trimmed = next.trim()
      const prev = noteLabel?.trim() ?? ""
      if (trimmed === prev) return
      // Optimistically patch the sidebar tree so the rename shows before the
      // WS persist (local path) / HTTP round-trip (REST path) lands — mirror
      // of handleIconChange. The list view reads the live store, so its
      // store.updateNode below already keeps it in sync.
      if (boardId) {
        queryClient.setQueriesData<BoardContentItem[]>(
          { queryKey: ["localBoardContents", boardId] },
          (old) => applyTitleUpdateToBoardContents(old, nodeId, trimmed || null),
        )
      }
      if (isLocalNote) {
        // Read the freshest data from the target store (not the render-time
        // snapshot) so a prior off-scene edit isn't clobbered by a stale merge.
        const prevData = (store.getNode(nodeId as NodeId)?.data ?? {}) as Record<string, unknown>
        store.updateNode(nodeId as NodeId, {
          data: {
            ...prevData,
            label: trimmed ? { markdown: trimmed } : undefined,
          },
        })
      } else {
        persistRemote({ label: trimmed ? { markdown: trimmed } : undefined })
      }
    },
    [isLocalNote, nodeId, noteLabel, persistRemote, store, boardId, queryClient],
  )

  const stopTitleEdit = useCallback(
    (save: boolean) => {
      if (save) persistTitle(titleDraft)
      else setTitleDraft(noteLabel ?? "")
      setTitleEditing(false)
    },
    [persistTitle, titleDraft, noteLabel],
  )

  const handleNoteChange = useCallback(
    (markdown: string) => {
      if (markdown === noteContent) return
      if (isLocalNote) {
        store.updateNode(nodeId as NodeId, { content: markdown })
      } else {
        persistRemote({ content: { markdown } })
      }
    },
    [isLocalNote, noteContent, nodeId, persistRemote, store],
  )

  const currentProperties =
    (localData.properties as Partial<NoteProperties> | undefined) ??
    fetchedNote?.properties

  const currentIconValue = currentProperties?.iconData?.icon ?? null

  const handleIconChange = useCallback(
    (next: IconProperty["icon"] | null) => {
      const nextIconData: IconProperty = next ? { type: "icon", icon: next } : { type: "icon" }

      // Optimistically patch the sidebar's cache so it reflects the new
      // icon before persistence lands. Closes the WS-coalesce race on
      // the local path (where a synchronous refetch would beat the
      // 75 ms collab window) and the HTTP-round-trip flicker on the
      // REST path. Every cached level under this board (root + any
      // expanded folder) gets the matching item updated in place.
      if (boardId) {
        queryClient.setQueriesData<BoardContentItem[]>(
          { queryKey: ["localBoardContents", boardId] },
          (old) => applyIconUpdateToBoardContents(old, nodeId, next),
        )
      }

      if (isLocalNote) {
        const prevData = (store.getNode(nodeId as NodeId)?.data ?? {}) as Record<string, unknown>
        const prevProps =
          (prevData.properties as Partial<NoteProperties> | undefined) ?? {}
        store.updateNode(nodeId as NodeId, {
          data: {
            ...prevData,
            properties: { ...prevProps, iconData: nextIconData },
          },
        })
        return
      }
      // REST path: send a fully-merged properties object so the backend
      // (and the optimistic cache spread in useUpdateNote) doesn't drop
      // sibling property fields when replacing `properties`. The
      // refetch in useUpdateNote.onSettled acts as the trust-but-verify
      // step after the backend has confirmed the write.
      const merged: NoteProperties = {
        ...(fetchedNote?.properties as NoteProperties),
        iconData: nextIconData,
      }
      persistRemote({ properties: merged })
    },
    [
      isLocalNote,
      nodeId,
      store,
      fetchedNote,
      persistRemote,
      boardId,
      queryClient,
    ],
  )

  const handleDownloadMarkdown = useCallback(() => {
    if (!noteContent.trim()) return

    const safeBaseName =
      (noteLabel || "sheet")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "sheet"

    const blob = new Blob([noteContent], { type: "text/markdown;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `${safeBaseName}.md`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }, [noteContent, noteLabel])

  // Loading / missing states — only show "no longer exists" once the
  // REST fetch has settled (otherwise sub-pages flash that message
  // before their data arrives).
  if (!exists) {
    if (offSceneLoading || isFetchingNote) {
      return (
        <div
          className={`${PANEL_CLASS} items-center justify-center text-sm text-muted-foreground`}
        >
          Loading note…
        </div>
      )
    }
    return (
      <div
        className={`${PANEL_CLASS} items-center justify-center gap-3 text-sm text-muted-foreground`}
      >
        <p>This sheet no longer exists.</p>
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    )
  }

  const displayTitle = noteLabel?.trim() || "Untitled note"

  const stackDepth = Math.max(0, ancestors.length)

  return (
    <div className={PANEL_CLASS} onClick={(e) => e.stopPropagation()}>
      <SheetStackBackground depth={stackDepth} />
      <div className="flex w-full items-center justify-between gap-2 px-3 py-1.5">
        <div className="min-w-0 flex-1 pr-2">
          <SheetBreadcrumb
            ancestors={ancestors}
            current={currentSegment}
            onSegmentClick={handleSegmentClick}
          />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleDownloadMarkdown}
            title="Download markdown"
            aria-label="Download markdown"
            disabled={!noteContent.trim()}
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

      <SheetEditor
        key={nodeId}
        value={noteContent}
        onSave={handleNoteChange}
        pageProvider={pageProvider}
        parentNoteId={nodeId}
        className="min-h-0 flex-1"
        bodyHeader={
          <div className="group mx-auto max-w-[720px] pb-8">
            <div className="mb-3 min-h-[40px]">
              <NoteIconControl
                icon={currentIconValue}
                onChange={handleIconChange}
              />
            </div>

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
                className="w-full border-0 bg-transparent px-0 py-0.5 text-3xl font-bold tracking-tight text-foreground focus:outline-none md:text-4xl"
                placeholder="Untitled note"
              />
            ) : (
              <button
                type="button"
                onClick={() => setTitleEditing(true)}
                className="block w-full text-left text-3xl font-bold tracking-tight text-foreground transition-opacity hover:opacity-90 md:text-4xl"
                title={displayTitle}
              >
                {displayTitle}
              </button>
            )}
          </div>
        }
      />
    </div>
  )
})
