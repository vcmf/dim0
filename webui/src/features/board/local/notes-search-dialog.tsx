import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { LocalBoardUrl } from "@/routes"
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import type { DimNode } from "@/features/board/model"
import { getLocalStores } from "@/features/local-stores"
import { BoardPersistence } from "@/features/board/persist/local/board-persistence"
import { useBoardAppStore } from "@/features/board/harness/store/board-app-store"
import { toSearchRows, type SearchRow } from "@/features/board/search/notes-search"
import { centerNoteSearch } from "@/features/board/utils/center-note"


/**
 * Whole-board notes palette for a local board (Cmd/Ctrl+K). Opens from the
 * `notes-search` chrome dialog, loads the WHOLE board (the live store only holds
 * the current layer), and lets the command palette filter by title/body. Selecting
 * a result jumps to that note's layer (`root_id`) and centers it (`center`) via
 * the existing URL-driven navigation.
 */
export function NotesSearchDialog({ boardId }: { boardId: string }) {
  const open = useBoardAppStore((s) => s.chromeDialog === "notes-search")
  const setChromeDialog = useBoardAppStore((s) => s.setChromeDialog)
  const navigate = useNavigate()
  const [nodes, setNodes] = useState<DimNode[]>([])

  // Load the whole board each time the palette opens (fresh, and cheap locally).
  useEffect(() => {
    if (!open || !boardId) return
    let cancelled = false
    void getLocalStores().then(async ({ engine }) => {
      const content = await new BoardPersistence(boardId, { engine }).load()
      if (!cancelled) setNodes(content.nodes)
    })
    return () => {
      cancelled = true
    }
  }, [open, boardId])

  const rows = useMemo(() => toSearchRows(nodes), [nodes])

  const close = (): void => setChromeDialog(null)

  const jump = (row: SearchRow): void => {
    close()
    void navigate({
      to: LocalBoardUrl,
      params: { boardId },
      search: centerNoteSearch(row.parentId, row.id),
    })
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
      title="Search notes"
      description="Find a note by title or content and jump to it."
    >
      <CommandInput placeholder="Search notes…" />
      <CommandList>
        <CommandEmpty>No notes found.</CommandEmpty>
        {rows.map((row) => (
          <CommandItem key={row.id} value={row.value} onSelect={() => jump(row)}>
            <div className="flex min-w-0 flex-col">
              <span className="truncate">{row.title}</span>
              {row.crumb && <span className="truncate text-xs text-muted-foreground">{row.crumb}</span>}
            </div>
          </CommandItem>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
