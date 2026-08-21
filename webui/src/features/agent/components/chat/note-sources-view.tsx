import { useNavigate } from "@tanstack/react-router"
import { MapPinIcon, NoteIcon } from "@/components/icons"
import { centerNoteSearch } from "@/features/board/utils/center-note"
import type { NoteSource } from "../../utils/note-sources"


/**
 * Notes an answer cited — the board notes `search_notes` / `get_note` surfaced
 * this turn, keyed by node id. Each expands to the snippets that grounded the
 * answer; "Find on board" opens the note's folder (`root_id`) and centers +
 * selects the node (`center`, via useCenterFromUrl) — cross-folder-aware, unlike
 * the doc card, because whole-board search can surface notes in other layers.
 */
export const NoteSourcesView = ({ sources }: { sources: NoteSource[] }) => {
  const navigate = useNavigate()
  if (sources.length === 0) return null

  const locate = (s: NoteSource): void => {
    // Shared jump contract: root_id opens the note's layer, center selects +
    // centers it (cross-folder aware; same helper the notes search dialog uses).
    void navigate({ to: ".", replace: true, search: centerNoteSearch(s.parentId, s.noteId) })
  }

  return (
    <div className="mt-2 min-w-0 space-y-1">
      <div className="ml-1 flex items-center gap-1 text-xs font-mono text-muted-foreground">
        <NoteIcon className="size-4 shrink-0 text-primary" strokeWidth={2} />
        <span className="text-primary">Notes</span>
      </div>
      {sources.map((s) => (
        <details key={s.noteId} className="scroll-mt-16 rounded-lg border border-border/60 bg-transparent">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 text-xs">
            <NoteIcon className="size-3.5 shrink-0 text-primary" strokeWidth={2} />
            <span className="truncate text-primary">{s.label || "Untitled note"}</span>
            <button
              type="button"
              aria-label="Find on board"
              title="Find on board"
              className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:text-secondary-foreground"
              onClick={(e) => {
                e.preventDefault() // don't toggle the <details>
                e.stopPropagation()
                locate(s)
              }}
            >
              <MapPinIcon className="size-3.5" strokeWidth={2} />
            </button>
          </summary>
          {s.snippets.length > 0 && (
            <div className="space-y-2 px-3 pb-2 pt-1">
              {s.snippets.map((p, i) => (
                <p key={i} className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                  {p}
                </p>
              ))}
            </div>
          )}
        </details>
      ))}
    </div>
  )
}
