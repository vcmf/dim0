import { asNodeId, type Node, type Op } from "@canvas-harness/core"
import type { Page, PageProvider } from "@/components/editor/tiptap/page/types"
import type { BoardContent } from "@/features/board/model"
import { queryClient } from "@/query-client"
import { getLocalStores } from "@/features/local-stores"
import { BoardPersistence } from "@/features/board/persist/local/board-persistence"
import { getBoardPersistenceRef } from "@/features/board/persist/local/board-persistence-ref"
import { getBoardSyncRef } from "@/features/board/harness/sync/board-sync-ref"
import { getCanvasStoreRef } from "@/features/board/harness/canvas-store-ref"
import { useBoardAppStore } from "@/features/board/harness/store/board-app-store"
import { makeBatch } from "@/features/board/harness/make-batch"
import { noteToNode, type NoteNodeData } from "../harness/convert/note-to-node"
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


/** A page is a sheet-kind note — dispatch type or the persisted `styleType`. */
function isSheet(node: Node): boolean {
  return node.type === "sheet" || (node.data as NoteNodeData | undefined)?.styleType === "sheet"
}


/** Title from node data — RichText label or a legacy bare string; "Untitled" if blank. */
function titleFromData(data: NoteNodeData | undefined): string {
  const label = typeof data?.label === "string" ? data.label : data?.label?.markdown
  return label?.trim() || "Untitled"
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
  return {
    id: node.id as unknown as string,
    title: titleFromData(data),
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
 *
 * Returns false when there's no live board mounted to write into — the caller
 * MUST NOT report the page as created in that case.
 */
function writeSheetNode(node: Node, layer: string | null): boolean {
  const store = getCanvasStoreRef()
  if (!store) return false // no live board mounted — nothing to write into
  const currentLayer = useBoardAppStore.getState().rootId ?? null
  if (layer === currentLayer) {
    store.addNode(node)
    return true
  }
  const persistence = getBoardPersistenceRef()
  if (!persistence) return false
  const batch = makeBatch(store, "local", [{ type: "node.add", node } as Op])
  persistence.record(batch)
  getBoardSyncRef()?.submitLocalBatch(batch, { scene: false })
  return true
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

  // A short-lived whole-board cache: `list` runs per keystroke and `get` misses
  // hit the replica, and BoardPersistence.load() replays the snapshot+oplog each
  // call — without this, typeahead would replay the whole board on every key.
  // Bounded so it self-heals; cleared on create so a new page shows immediately.
  const CACHE_MS = 1500
  let cache: { at: number; content: BoardContent } | null = null
  const loadBoard = async (): Promise<BoardContent> => {
    const now = Date.now()
    if (cache && now - cache.at < CACHE_MS) return cache.content
    const { engine } = await getLocalStores()
    const content = await new BoardPersistence(boardId, { engine }).load()
    cache = { at: now, content }
    return content
  }

  return {
    async list(query?: string) {
      const { nodes } = await loadBoard()
      const sheets: Page[] = nodes
        .filter(isSheet)
        .map((n) => {
          const data = n.data as NoteNodeData | undefined
          return { id: n.id as unknown as string, title: titleFromData(data), icon: data?.properties?.iconData?.icon ?? null }
        })

      const q = query?.trim().toLowerCase()
      if (!q) return sheets
      return sheets.filter((p) => p.title.toLowerCase().includes(q))
    },

    async get(id: string) {
      // Contract: return null (never throw) on missing / no access — so a
      // malformed id (asNodeId/getNode) can't reject the promise either.
      try {
        // The live store holds the current layer — freshest, and the common case.
        // Only trust it when it IS this provider's board (a sub-graph provider must
        // not resolve an id against a different mounted board).
        const live =
          boardId === useBoardAppStore.getState().boardId
            ? getCanvasStoreRef()?.getNode(asNodeId(id))
            : undefined
        if (live) return isSheet(live) ? nodeToPage(live) : null
        // Otherwise resolve from the whole-board replica (a page in another layer).
        const node = (await loadBoard()).nodes.find((n) => (n.id as unknown as string) === id)
        return node && isSheet(node) ? nodeToPage(node) : null
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
      const ok = writeSheetNode(noteToNode(note), note.parentId ?? null)
      if (!ok) throw new Error("createBoardPageProvider: no live board to write the page into")
      // Make the write durable BEFORE refreshing readers: an off-scene write emits
      // no store 'change', so nothing else flush-chains the invalidate, and the
      // contents index (fresh snapshot+oplog load) would miss an unflushed batch.
      await getBoardPersistenceRef()?.flush()
      cache = null // a new page must show in the next list()
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
