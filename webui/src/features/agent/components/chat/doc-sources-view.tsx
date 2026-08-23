import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { ChevronDownIcon, DocumentFileIcon } from "@/components/icons"
import { docAnchorId, type DocSource } from "../../utils/doc-sources"


/**
 * One cited document. The row jumps to the doc node on the board (the node's id
 * IS the docId, so `?center=<docId>` centers it via useCenterFromUrl); the
 * chevron expands the passages that grounded the answer, kept separate so a row
 * click always navigates. The `anchorId` lets a linkified title in the answer
 * scroll to THIS message's source card (not an older one's).
 */
const DocSourceItem = ({ source, anchorId }: { source: DocSource; anchorId: string }) => {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  const locate = (): void => {
    void navigate({ to: ".", replace: true, search: (prev: Record<string, unknown>) => ({ ...prev, center: source.docId }) })
  }

  return (
    <div id={anchorId} className="scroll-mt-16 rounded-lg border border-border/60 bg-transparent">
      <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
        <button
          type="button"
          onClick={locate}
          title="Find on board"
          aria-label={`Find "${source.docTitle || "Document"}" on board`}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left hover:text-secondary-foreground"
        >
          <DocumentFileIcon className="size-3.5 shrink-0 text-primary" strokeWidth={2} />
          <span className="truncate text-primary">{source.docTitle || "Document"}</span>
        </button>
        <span className="shrink-0 text-muted-foreground">
          {source.passages.length} passage{source.passages.length === 1 ? "" : "s"}
        </span>
        {source.passages.length > 0 && (
          <button
            type="button"
            aria-label={open ? "Hide passages" : "Show passages"}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-secondary-foreground"
          >
            <ChevronDownIcon className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2} />
          </button>
        )}
      </div>
      {open && source.passages.length > 0 && (
        <div className="space-y-2 px-3 pb-2 pt-1">
          {source.passages.map((p, i) => (
            <p key={i} className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
              {p}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}


/**
 * Document Sources for an answer (F2 B7) — the documents `doc_search` actually
 * retrieved from this turn, keyed by the unique `docId`. Clicking a row jumps to
 * the doc node on the board; the chevron expands its grounding passages.
 */
export const DocSourcesView = ({ sources, messageId }: { sources: DocSource[]; messageId: string }) => {
  if (sources.length === 0) return null

  return (
    <div className="mt-2 min-w-0 space-y-1">
      <div className="ml-1 flex items-center gap-1 text-xs font-mono text-muted-foreground">
        <DocumentFileIcon className="size-4 shrink-0 text-primary" strokeWidth={2} />
        <span className="text-primary">Documents</span>
      </div>
      {sources.map((s) => (
        <DocSourceItem key={s.docId} source={s} anchorId={docAnchorId(messageId, s.docId)} />
      ))}
    </div>
  )
}
