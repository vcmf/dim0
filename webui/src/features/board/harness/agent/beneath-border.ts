import type { CanvasStore } from "@canvas-harness/core"


// Gap between existing board content and freshly-added notes. Matches the
// backend's DEFAULT_NOTE_GAP (notes/service.py) so local and server placement
// agree.
export const NOTE_TAIL_GAP = 80


type XY = { x: number; y: number }
type Box = { x: number; y: number; h: number }


/**
 * Top-left origin just beneath a set of nodes' border: left-aligned to the
 * leftmost node, one gap below the lowest bottom edge. `(0, 0)` when empty.
 * The shared placement rule for freshly-added content (min x, max bottom + gap).
 */
export const originBeneath = (nodes: ReadonlyArray<Box>): XY => {
  if (nodes.length === 0) return { x: 0, y: 0 }
  const x = Math.min(...nodes.map((n) => n.x))
  const y = Math.max(...nodes.map((n) => n.y + n.h)) + NOTE_TAIL_GAP
  return { x, y }
}


/**
 * The (dx, dy) that moves a freshly-laid-out cluster so its top-left corner
 * lands on `origin` (left edge → origin.x, top → origin.y). No move for an
 * empty cluster. Apply the result to every node in the cluster.
 */
export const offsetToOrigin = (cluster: ReadonlyArray<XY>, origin: XY): XY => {
  if (cluster.length === 0) return { x: 0, y: 0 }
  const minX = Math.min(...cluster.map((n) => n.x))
  const minY = Math.min(...cluster.map((n) => n.y))
  return { x: origin.x - minX, y: origin.y - minY }
}


/**
 * Top-left origin just beneath the current graph's border. Frontend analog of
 * the backend's `compute_note_position` (min existing x, max existing bottom +
 * gap). `(0, 0)` on an empty board.
 */
export const beneathBorderOrigin = (store: CanvasStore): XY => originBeneath(store.getAllNodes())
