import type { BoardContentItem, BoardContentKind } from "@/features/board/api/list-board-contents"
import type { IconProperty } from "@/features/newsfeed/types/properties"
import { parentChain } from "@/features/board/model/parent-chain"
import { UNTITLED_LABEL } from "../../const"


/** One resolved crumb: id, surface kind, display label, and optional custom icon. */
export type CrumbSegment = {
  id: string
  kind: BoardContentKind
  label: string
  icon: IconProperty["icon"] | null
}


/**
 * Build the root→leaf crumb chain for `leafId` by walking `parentId` up over the
 * flat board-contents list (every surface node across all levels). Returns [] when
 * `leafId` is null or missing from the list. Cycle-safe. The local analog of the
 * backend note-path, shared by the unified board breadcrumb.
 */
export function buildNodePath(
  items: BoardContentItem[] | undefined,
  leafId: string | null,
): CrumbSegment[] {
  return parentChain(items, leafId, (item) => item.id, (item) => item.parentId ?? null).map(
    (item) => ({
      id: item.id,
      kind: item.kind,
      label: (item.label ?? "").trim() || UNTITLED_LABEL,
      icon: item.iconData ?? null,
    }),
  )
}
