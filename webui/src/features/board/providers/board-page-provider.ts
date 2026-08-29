import { asNodeId, type Node, type Op } from "@canvas-harness/core"
import type { Page, PageProvider } from "@/components/editor/tiptap/page/types"
import { queryClient } from "@/query-client"
import { getLocalStores } from "@/features/local-stores"
import { BoardPersistence } from "@/features/board/persist/local/board-persistence"
import { getBoardPersistenceRef } from "@/features/board/persist/local/board-persistence-ref"
import { getBoardSyncRef } from "@/features/board/harness/sync/board-sync-ref"
import { getCanvasStoreRef } from "@/features/board/harness/canvas-store-ref"
import { useBoardAppStore } from "@/features/board/harness/store/board-app-store"
import { makeBatch } from "@/features/board/harness/make-batch"
import { noteToNode, type NoteNodeData } from "../harness/convert/note-to-node"
import { listLocalBoardContents } from "../api/list-local-board-contents"
import { createDefaultNote, type Note } from "../types/note"


/**
 * Configuration for the editor's PageProvider when running inside the board:
 * a "page" maps to a sheet-kind note in the same board. The `parentNoteId`
 * is used by /subpage to make the new note a child of the current note (the
 * editor host). Reference creation (@mention "Create new") leaves
 * `parentId` unset so the new page is top-level.
 */
export interface BoardPageProviderConfig {
  /** Graph (board) the editor lives in. All page CRUD is scoped to it. */
  boardId: string
  /** ID of the note the editor is currently editing (i.e. potential parent). */
  parentNoteId?: string
  /** Called when the user clicks a page reference chip. */
  onNavigate?: (id: string) => void
}


function snippetFromMarkdown(markdown: string | undefined): string | undefined {
  if (!markdown) return undefined
  // Strip headings, list bullets and excess whitespace for a one-liner peek.
  const stripped = markdown
    .replace(/^#+\s*/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
  return stripped.slice(0, 240) || undefined
}


/**
 * Map a board Note onto the editor's `Page` shape: title (falling back to
 * "Untitled"), the user's custom icon (`iconData.icon`, else null so the
 * chip uses its default), parent id, and a body snippet for the hover card.
 * Pure so the title/icon mapping can be unit-tested without the network.
 */
export function noteToPage(note: Note): Page {
  return {
    id: note.id,
    title: note.label?.markdown?.trim() || "Untitled",
    icon: note.properties?.iconData?.icon ?? null,
    parentId: note.parentId,
    snippet: snippetFromMarkdown(note.content?.markdown),
  }
}


/**
 * Map a live canvas-harness `Node` (runtime `NoteNodeData` + string `content`)
 * onto a `Page`. The local analog of {@link noteToPage} for the on-device store,
 * where the body rides on `node.content` (a string), not `note.content.markdown`.
 */
function nodeToPage(node: Node): Page {
  const data = node.data as NoteNodeData | undefined
  const label = typeof data?.label === "string" ? data.label : data?.label?.markdown
  return {
    id: node.id as unknown as string,
    title: label?.trim() || "Untitled",
    icon: data?.properties?.iconData?.icon ?? null,
    parentId: data?.parentId ?? undefined,
    snippet: snippetFromMarkdown(node.content ?? undefined),
  }
}


/**
 * Write a freshly-built sheet node into the board, sync-correctly, without
 * disturbing the user's view:
 *  - target layer == the visible layer → through the live store (renders + the
 *    store's change pipeline persists + syncs it, exactly like a manual create);
 *  - otherwise (a /subpage's child layer, or a top-level page created while the
 *    user is inside a folder) → off-scene: record to the oplog + enter the sync
 *    intake with `scene: false` (the headless path, ADR-SYNC-001), so it never
 *    lands in the current scene.
 */
function writeSheetNode(node: Node, layer: string | null): void {
  const store = getCanvasStoreRef()
  if (!store) return // no live board mounted — nothing to write into
  const currentLayer = useBoardAppStore.getState().rootId ?? null
  if (layer === currentLayer) {
    store.addNode(node)
    return
  }
  const persistence = getBoardPersistenceRef()
  if (!persistence) return
  const batch = makeBatch(store, "local", [{ type: "node.add", node } as Op])
  persistence.record(batch)
  getBoardSyncRef()?.submitLocalBatch(batch, { scene: false })
}


/**
 * Build a `PageProvider` backed by the on-device store (offline-first): pages are
 * the board's sheet-kind notes. `list` reads the local surface index, `get`
 * resolves a note from the live store or the whole-board replica, and `create`
 * writes a new sheet sync-correctly. (Formerly REST-backed — that broke once
 * boards became local/synced, since those routes have no local-board counterpart.)
 */
export function createBoardPageProvider(
  config: BoardPageProviderConfig,
): PageProvider {
  const { boardId, onNavigate } = config

  return {
    async list(query?: string) {
      const items = await listLocalBoardContents(boardId)
      const sheets: Page[] = items
        .filter((it) => it.kind === "sheet")
        .map((it) => ({ id: it.id, title: it.label?.trim() || "Untitled", icon: it.iconData ?? null }))

      const q = query?.trim().toLowerCase()
      if (!q) return sheets
      return sheets.filter((p) => p.title.toLowerCase().includes(q))
    },

    async get(id: string) {
      // The live store holds the current layer — freshest, and the common case.
      const live = getCanvasStoreRef()?.getNode(asNodeId(id))
      if (live) return nodeToPage(live)
      // Otherwise resolve from the whole-board replica (a page in another layer).
      try {
        const { engine } = await getLocalStores()
        const content = await new BoardPersistence(boardId, { engine }).load()
        const node = content.nodes.find((n) => (n.id as unknown as string) === id)
        return node ? nodeToPage(node) : null
      } catch (err) {
        console.warn("[boardPageProvider] get failed", id, err)
        return null
      }
    },

    async create(opts: { title: string; parentId?: string }) {
      const note = createDefaultNote({ boardId, nodeType: "sheet" })
      note.label = { markdown: opts.title || "Untitled" }
      // Empty body — without this, noteToNode seeds the body from the label.
      note.content = { markdown: "" }
      if (opts.parentId) note.parentId = opts.parentId
      writeSheetNode(noteToNode(note), note.parentId ?? null)
      // Refresh the on-device contents index (sidebar tree / page picker).
      void queryClient.invalidateQueries({ queryKey: ["localBoardContents", boardId] })
      return {
        id: note.id,
        title: opts.title || "Untitled",
        parentId: opts.parentId,
      }
    },

    onNavigate,
  }
}
