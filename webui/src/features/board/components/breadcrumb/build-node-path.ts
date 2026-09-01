import type { BoardContentItem, BoardContentKind } from "@/features/board/api/list-board-contents"
import type { IconProperty } from "@/features/newsfeed/types/properties"
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
  if (!leafId || !items?.length) return []
  const byId = new Map(items.map((item) => [item.id, item]))
  const path: CrumbSegment[] = []
  const seen = new Set<string>()
  let current: string | null = leafId
  while (current && !seen.has(current)) {
    seen.add(current)
    const item = byId.get(current)
    if (!item) break
    path.push({
      id: item.id,
      kind: item.kind,
      label: (item.label ?? "").trim() || UNTITLED_LABEL,
      icon: item.iconData ?? null,
    })
    current = item.parentId ?? null
  }
  return path.reverse()
}
