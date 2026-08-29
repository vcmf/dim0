import { useQuery } from "@tanstack/react-query"
import { getLocalStores } from "@/features/local-stores"
import { BoardPersistence } from "@/features/board/persist/local/board-persistence"
import type { NoteNodeData } from "@/features/board/harness/convert/note-to-node"
import type { BoardContentItem, BoardContentKind } from "./list-board-contents"


const SURFACE_KINDS = new Set<BoardContentKind>([
  "sheet",
  "folder",
  "code-sandbox",
  "widget",
])


/**
 * Reconstruct a local board's surface-node hierarchy (sheet / folder /
 * code-sandbox / widget) from the on-device store — the client analog of the
 * synced `/boards/:id/contents` projection (select by `style.type`, echo
 * parent / label / icon).
 *
 * Local persistence is snapshot + oplog, not a per-node table, so there's no
 * lazy per-level query: load the whole board once and return a flat list with
 * `parentId`. Consumers filter per level in memory (mirrors the backend's
 * `get_graph(root_id)` via `filterContentByLayer`).
 */
export async function listLocalBoardContents(boardId: string): Promise<BoardContentItem[]> {
  const { engine } = await getLocalStores()
  const content = await new BoardPersistence(boardId, { engine }).load()

  const items: BoardContentItem[] = []
  for (const node of content.nodes) {
    // Runtime `data` is `NoteNodeData` (the converter's payload) even though the
    // model types it as the leaner `DimNodeData`; read the surface fields off it.
    const data = node.data as NoteNodeData | undefined
    // Prefer the display `styleType`, but fall back to the canonical `node.type`:
    // agent-authored surfaces (built via the mutator, not the convert layer) set
    // only `node.type`, so without this they'd be missing from the tree/picker.
    const kind = (data?.styleType ?? node.type) as BoardContentKind | undefined
    if (!kind || !SURFACE_KINDS.has(kind)) continue
    // label is `RichText` at runtime; fall back to a plain string defensively.
    const label =
      typeof data?.label === "string" ? data.label : (data?.label?.markdown ?? null)
    items.push({
      id: node.id,
      label,
      kind,
      parentId: data?.parentId ?? null,
      iconData: data?.properties?.iconData?.icon ?? null,
    })
  }
  return items
}


/**
 * React Query hook for a local board's full surface-node list. Unlike the synced
 * `useBoardContents` (one level per fetch), this returns every level at once —
 * callers filter by `parentId`. Pass `enabled: false` until the board is
 * expanded so we don't replay the oplog eagerly.
 */
export const useLocalBoardContents = (
  boardId: string,
  options: { enabled?: boolean } = {},
) => {
  const { enabled = true } = options
  return useQuery<BoardContentItem[]>({
    queryKey: ["localBoardContents", boardId],
    queryFn: () => listLocalBoardContents(boardId),
    enabled: enabled && Boolean(boardId),
    // `useSidebarContentsSync` invalidates this exact key on a surface-relevant
    // canvas edit (create / delete / rename / re-icon / move) for the open board,
    // so the tree refreshes live. `staleTime: 0` also makes each fresh expand
    // re-read the store; `refetchOnWindowFocus` off so we don't replay on focus.
    // The snapshot+oplog replay is cheap for local boards; larger synced offline
    // bases could read the open board from the live store instead (a follow-up).
    staleTime: 0,
    refetchOnWindowFocus: false,
  })
}
