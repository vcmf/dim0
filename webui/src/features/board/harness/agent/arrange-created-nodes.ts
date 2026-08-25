import { asNodeId, type CanvasStore, type Edge } from "@canvas-harness/core"
import type { LinkEdge, NoteNode } from "@/features/board/types/flow"
import { autoLayout } from "@/features/board/lib/graph/auto-layout"
import { defaultLayoutOptions, type Direction } from "@/features/board/lib/graph/settings"
import { offsetToOrigin, originBeneath } from "./beneath-border"


type XY = { x: number; y: number }
type Size = { w: number; h: number }
type SizeOf = (id: string) => Size
type SimpleEdge = { source: string; target: string }


/** The node id at an edge end, or null for a free (unattached) endpoint. */
const endNodeId = (end: Edge["source"]): string | null =>
  "nodeId" in end ? String(end.nodeId) : null


/**
 * Run a single Dagre pass over a subset of nodes and return top-left positions.
 * Dagre reads geometry from `data.properties.nodeSize.size`, so that's all we
 * shape onto the flow node.
 */
const runDagre = async (
  ids: string[],
  edges: SimpleEdge[],
  sizeOf: SizeOf,
  direction: Direction,
): Promise<Map<string, XY>> => {
  const idSet = new Set(ids)
  const flowNodes = ids.map((id) => {
    const s = sizeOf(id)
    return {
      id,
      position: { x: 0, y: 0 },
      data: { properties: { nodeSize: { size: { width: s.w, height: s.h } } } },
    } as unknown as NoteNode
  })
  const flowEdges = edges
    .filter((e) => idSet.has(e.source) && idSet.has(e.target))
    .map((e) => ({ id: `${e.source}->${e.target}`, source: e.source, target: e.target }) as unknown as LinkEdge)

  const { nodes: laid } = await autoLayout(flowNodes, flowEdges, { ...defaultLayoutOptions, direction })
  return new Map(laid.map((n) => [n.id, { x: n.position.x, y: n.position.y }]))
}


type Tree = { root: string; childrenOf: Map<string, string[]> }


/** Classify the graph as a single-rooted tree, or null (DAG/cycle/forest). */
const classifyTree = (ids: string[], edges: SimpleEdge[]): Tree | null => {
  const idSet = new Set(ids)
  const indeg = new Map(ids.map((i) => [i, 0]))
  const childrenOf = new Map<string, string[]>(ids.map((i) => [i, []]))
  let edgeCount = 0
  for (const e of edges) {
    if (!idSet.has(e.source) || !idSet.has(e.target)) continue
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
    childrenOf.get(e.source)!.push(e.target)
    edgeCount += 1
  }
  const roots = ids.filter((i) => (indeg.get(i) ?? 0) === 0)
  if (roots.length !== 1 || edgeCount !== ids.length - 1) return null // not a single-rooted tree

  const root = roots[0]
  const seen = new Set<string>()
  const stack = [root]
  while (stack.length) {
    const n = stack.pop()!
    if (seen.has(n)) return null // cycle
    seen.add(n)
    for (const c of childrenOf.get(n)!) stack.push(c)
  }
  return seen.size === ids.length ? { root, childrenOf } : null
}


/** Subtree node count for every node, rooted at `root`. */
const subtreeSizes = (root: string, childrenOf: Map<string, string[]>): Map<string, number> => {
  const size = new Map<string, number>()
  const dfs = (n: string): number => {
    let s = 1
    for (const c of childrenOf.get(n) ?? []) s += dfs(c)
    size.set(n, s)
    return s
  }
  dfs(root)
  return size
}


/** All ids in the subtrees rooted at `roots` (inclusive). */
const descendants = (roots: string[], childrenOf: Map<string, string[]>): string[] => {
  const out: string[] = []
  const stack = [...roots]
  while (stack.length) {
    const n = stack.pop()!
    out.push(n)
    for (const c of childrenOf.get(n) ?? []) stack.push(c)
  }
  return out
}


/** Greedy balance: assign each child to the lighter side (ties → right). */
const partition = (children: string[], size: Map<string, number>): { left: string[]; right: string[] } => {
  const sorted = [...children].sort((a, b) => (size.get(b) ?? 1) - (size.get(a) ?? 1))
  const left: string[] = []
  const right: string[] = []
  let lw = 0
  let rw = 0
  for (const c of sorted) {
    const s = size.get(c) ?? 1
    if (rw <= lw) {
      right.push(c)
      rw += s
    } else {
      left.push(c)
      lw += s
    }
  }
  return { left, right }
}


/**
 * Centered mindmap layout: split the root's children left/right by subtree size,
 * lay each half out with Dagre LR, mirror the left half around the root, and
 * stitch at the root. Returns null when the graph isn't a tree with ≥2 root
 * children split across both sides — the caller falls back to flat LR. Mirrors
 * the backend's bidirectional `_component_layout`.
 */
const layoutBidirectional = async (
  ids: string[],
  edges: SimpleEdge[],
  sizeOf: SizeOf,
): Promise<Map<string, XY> | null> => {
  const tree = classifyTree(ids, edges)
  if (!tree) return null
  const { root, childrenOf } = tree
  const rootChildren = childrenOf.get(root) ?? []
  if (rootChildren.length < 2) return null

  const size = subtreeSizes(root, childrenOf)
  const { left, right } = partition(rootChildren, size)
  if (left.length === 0 || right.length === 0) return null

  const rightIds = [root, ...descendants(right, childrenOf)]
  const leftIds = [root, ...descendants(left, childrenOf)]
  const rightPos = await runDagre(rightIds, edges, sizeOf, "LR")
  const leftPos = await runDagre(leftIds, edges, sizeOf, "LR")

  // Mirror the left half horizontally around the root center so it grows leftward.
  const rootCx = leftPos.get(root)!.x + sizeOf(root).w / 2
  const mirrored = new Map<string, XY>()
  for (const [id, p] of leftPos) mirrored.set(id, { x: 2 * rootCx - p.x - sizeOf(id).w, y: p.y })

  // Align the (mirrored) left root onto the right root, then merge.
  const rRoot = rightPos.get(root)!
  const mRoot = mirrored.get(root)!
  const dx = rRoot.x - mRoot.x
  const dy = rRoot.y - mRoot.y

  const final = new Map<string, XY>(rightPos)
  for (const [id, p] of mirrored) {
    if (id !== root) final.set(id, { x: p.x + dx, y: p.y + dy })
  }
  return final
}


/**
 * Lay out a subset of nodes (mindmap-first, Dagre-LR fallback), returning
 * top-left positions keyed by id. Empty map for < 2 present nodes. Edges are the
 * links whose BOTH ends are in the set. Shared by the create-arrange and the
 * on-demand `arrange` tool.
 */
const layoutNodes = async (store: CanvasStore, ids: string[]): Promise<Map<string, XY>> => {
  const present = ids.filter((id) => store.getNode(asNodeId(id)))
  if (present.length < 2) return new Map()
  const idSet = new Set(present)
  const sizeOf: SizeOf = (id) => {
    const n = store.getNode(asNodeId(id))
    return n ? { w: n.w, h: n.h } : { w: 0, h: 0 }
  }
  const edges: SimpleEdge[] = []
  for (const e of store.getAllEdges()) {
    const s = endNodeId(e.source)
    const t = endNodeId(e.target)
    if (s && t && idSet.has(s) && idSet.has(t)) edges.push({ source: s, target: t })
  }
  return (await layoutBidirectional(present, edges, sizeOf)) ?? (await runDagre(present, edges, sizeOf, "LR"))
}


/** Center of the union AABB of the given boxes (top-left + size). */
const bboxCenter = (boxes: ReadonlyArray<{ x: number; y: number; w: number; h: number }>): XY => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const b of boxes) {
    if (b.x < minX) minX = b.x
    if (b.y < minY) minY = b.y
    if (b.x + b.w > maxX) maxX = b.x + b.w
    if (b.y + b.h > maxY) maxY = b.y + b.h
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
}


/**
 * Arrange the nodes an agent turn just created — the frontend analog of the
 * backend's post-turn `rearrange_created_notes`. Without this, every
 * `write_note` lands at (0,0) and a mindmap collapses to a single point.
 *
 * Tries a centered bidirectional mindmap layout; falls back to flat Dagre LR for
 * non-tree graphs. The result is translated to sit just below existing board
 * content and written back in one local batch, so it snaps into place after the
 * turn (as the system prompt promises). Single-node turns are left untouched.
 */
export const arrangeCreatedNodes = async (store: CanvasStore, createdIds: string[]): Promise<void> => {
  const positions = await layoutNodes(store, createdIds)
  if (positions.size === 0) return

  // Translate the laid-out cluster below existing (non-created) content — the
  // same placement rule the mindmap-apply drain uses (originBeneath).
  const ids = new Set(createdIds)
  const others = store.getAllNodes().filter((n) => !ids.has(String(n.id)))
  const { x: dx, y: dy } = offsetToOrigin([...positions.values()], originBeneath(others))

  store.batch(() => {
    for (const [id, p] of positions) {
      store.updateNode(asNodeId(id), { x: p.x + dx, y: p.y + dy })
    }
  })
}


/**
 * On-demand tidy of EXISTING nodes (the `arrange` tool): re-lays-out `ids` and
 * keeps the tidied cluster centered where it currently sits — it reorganizes in
 * place rather than relocating the cluster beneath other content. Returns how
 * many nodes were moved (0 for < 2 present). Same layout engine as create-arrange.
 */
export const arrangeNodesInPlace = async (store: CanvasStore, ids: string[]): Promise<number> => {
  const positions = await layoutNodes(store, ids)
  if (positions.size === 0) return 0

  const laid = [...positions.entries()].map(([id, p]) => {
    const n = store.getNode(asNodeId(id))!
    return { id, x: p.x, y: p.y, w: n.w, h: n.h, curX: n.x, curY: n.y }
  })
  const laidCenter = bboxCenter(laid)
  const curCenter = bboxCenter(laid.map((n) => ({ x: n.curX, y: n.curY, w: n.w, h: n.h })))
  const dx = curCenter.x - laidCenter.x
  const dy = curCenter.y - laidCenter.y

  store.batch(() => {
    for (const n of laid) store.updateNode(asNodeId(n.id), { x: n.x + dx, y: n.y + dy })
  })
  return laid.length
}
