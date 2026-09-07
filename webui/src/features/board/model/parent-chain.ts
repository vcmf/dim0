/**
 * Walk `parentId` from `leafId` up a flat node list and return the chain
 * ordered root→leaf. Cycle-safe (each id visited once); empty when `leafId` is
 * null or absent from the list.
 *
 * The shared primitive behind the breadcrumb crumb path (`buildNodePath`) and the
 * off-scene note path (`buildNotePath`) — they differ only in the item shape and
 * how each entry is projected, so callers pass id / parentId accessors and map the
 * returned items themselves.
 */
export function parentChain<T>(
  items: readonly T[] | undefined,
  leafId: string | null,
  getId: (item: T) => string,
  getParentId: (item: T) => string | null,
): T[] {
  if (!leafId || !items?.length) return []
  const byId = new Map(items.map((item) => [getId(item), item]))
  const path: T[] = []
  const seen = new Set<string>()
  let current: string | null = leafId
  while (current && !seen.has(current)) {
    seen.add(current)
    const item = byId.get(current)
    if (!item) break
    path.push(item)
    current = getParentId(item)
  }
  return path.reverse()
}
