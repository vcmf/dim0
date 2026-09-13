/**
 * Board snapshot — the deterministic, LLM-free "state of the board now" that
 * grounds the agent (the local analog of Claude Code's `gitStatus` block).
 *
 * Two pure functions + one indexed oplog read:
 *  - `buildBoardSnapshot(store, rootId, recentOps)` reads the live scene.
 *  - `renderBoardSnapshot(snapshot, opts)` renders it to a budgeted text block.
 *  - `readRecentOps(engine, boardId, sinceSeq)` pulls the oplog tail for the
 *    "recent changes" line.
 *
 * Recomputed on read (never stored), so node adds are self-healing — there is
 * nothing to invalidate. See docs/plans/agent-context-architecture.md.
 */
import type { CanvasStore, Node } from "@canvas-harness/core"
import type { NoteNodeData } from "@/features/board/harness/convert/note-to-node"
import { labelText } from "@/features/board/model"
import type { OplogRecord } from "@/features/board/persist/local/idb"
import type { StorageEngine } from "@/features/board/persist/local/engine"


/** How a node is categorized in the snapshot's type breakdown. */
export type NodeKind = "note" | "folder" | "sheet" | "mini-app" | "applet" | "code-sandbox" | "widget" | "document"


/** One folder layer (or root) in the board's structure. */
export type SnapshotLayer = {
  /** `parentId` of the layer's members; `null` = root. */
  rootId: string | null
  /** Folder label, or `"root"`. */
  title: string
  count: number
  /** Prioritized (selected/recent first), per-layer-capped sample of member titles. */
  sampleTitles: string[]
}


/** A net change to one node since the last snapshot mark. */
export type RecentChange = { id: string; label: string; op: "add" | "edit" | "delete" }


export type BoardSnapshot = {
  total: number
  /** Node counts keyed by `NodeKind`, e.g. `{ note: 22, folder: 2 }`. */
  counts: Record<string, number>
  /** True when every node is at root (no folder layers to outline). */
  flat: boolean
  /** All layers, sorted by count desc. Root is always present when nodes exist. */
  layers: SnapshotLayer[]
  /** `rootId` of the layer currently projected in the view (`null` = root). */
  currentLayer: string | null
  /** Titles of the currently selected nodes. */
  selection: string[]
  /** Net changes since the snapshot mark (add / edit / delete), collapsed per node. */
  recent: RecentChange[]
}


// Budget/format constants — tune with telemetry.
const MAX_LAYERS = 6
const PER_LAYER_TITLES = 4
const CURRENT_LAYER_TITLES = 6
const RECENT_TITLES = 5
const MAX_SELECTION_TITLES = 8
const TITLE_MAX_CHARS = 40


const STRUCTURAL_KINDS: ReadonlySet<string> = new Set(["folder", "sheet", "mini-app", "applet", "code-sandbox", "widget"])


const KIND_PLURAL: Record<NodeKind, [string, string]> = {
  note: ["note", "notes"],
  folder: ["folder", "folders"],
  sheet: ["sheet", "sheets"],
  "mini-app": ["mini-app", "mini-apps"],
  applet: ["applet", "applets"],
  "code-sandbox": ["code sandbox", "code sandboxes"],
  widget: ["widget", "widgets"],
  document: ["document", "documents"],
}


const nodeData = (n: Node): Partial<NoteNodeData> => (n.data ?? {}) as Partial<NoteNodeData>


/**
 * Categorize a node. `noteType` only distinguishes note vs document; the
 * structural type (folder / sheet / mini-app / …) rides on `styleType`.
 */
const nodeKind = (data: Partial<NoteNodeData>): NodeKind => {
  if (data.noteType === "document") return "document"
  const st = data.styleType
  return st && STRUCTURAL_KINDS.has(st) ? (st as NodeKind) : "note"
}


const firstLine = (s: string | undefined): string =>
  (s ?? "").split("\n").find((l) => l.trim())?.trim() ?? ""


const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`


/** Title: `data.label` → first non-blank line of content → `"(untitled)"`, truncated. */
const nodeTitle = (n: Node): string => {
  const data = nodeData(n)
  // labelText tolerates a legacy bare-string label — raw oplog ops read here
  // aren't normalized-on-load the way the live store is.
  const label = labelText(data.label).trim()
  return truncate(label || firstLine(n.content) || "(untitled)", TITLE_MAX_CHARS)
}


const nodeIdOf = (n: Node): string => n.id as unknown as string


/**
 * Build the structured snapshot from the live scene. Pure w.r.t. `store` (reads
 * only), no LLM. `recentOps` is the pre-read oplog tail (see `readRecentOps`).
 */
export const buildBoardSnapshot = (
  store: CanvasStore,
  rootId: string | null,
  recentOps: OplogRecord[],
): BoardSnapshot => {
  const nodes = store.getAllNodes()

  const counts: Record<string, number> = {}
  const byParent = new Map<string | null, Node[]>()
  const folderLabels = new Map<string, string>()
  const titleById = new Map<string, string>()

  for (const n of nodes) {
    const data = nodeData(n)
    const kind = nodeKind(data)
    counts[kind] = (counts[kind] ?? 0) + 1
    titleById.set(nodeIdOf(n), nodeTitle(n))
    if (kind === "folder") folderLabels.set(nodeIdOf(n), nodeTitle(n))
    const parent = data.parentId ?? null
    const arr = byParent.get(parent)
    if (arr) arr.push(n)
    else byParent.set(parent, [n])
  }

  // Orphans — a `parentId` pointing at no existing folder — land at root rather
  // than a phantom layer.
  const root = byParent.get(null) ?? []
  for (const [parent, arr] of byParent) {
    if (parent !== null && !folderLabels.has(parent)) {
      root.push(...arr)
      byParent.delete(parent)
    }
  }
  if (root.length) byParent.set(null, root)

  const selected = new Set(store.getSelection().map((id) => id as unknown as string))
  const selection = nodes.filter((n) => selected.has(nodeIdOf(n))).map((n) => titleById.get(nodeIdOf(n)) ?? nodeTitle(n))

  const recent = collapseRecent(recentOps, titleById)
  const recentIds = new Set(recent.map((r) => r.id))

  const layers: SnapshotLayer[] = []
  for (const [parent, arr] of byParent) {
    const isCurrent = parent === rootId
    layers.push({
      rootId: parent,
      title: parent === null ? "root" : folderLabels.get(parent) ?? "root",
      count: arr.length,
      sampleTitles: sampleTitles(arr, selected, recentIds, isCurrent ? CURRENT_LAYER_TITLES : PER_LAYER_TITLES),
    })
  }
  // Inside an empty folder there are no members and thus no layer — add it so the
  // outline still shows where the user is.
  if (rootId !== null && !layers.some((l) => l.rootId === rootId)) {
    layers.push({ rootId, title: folderLabels.get(rootId) ?? "(current folder)", count: 0, sampleTitles: [] })
  }
  layers.sort((a, b) => b.count - a.count)

  return {
    total: nodes.length,
    counts,
    // Flat only when the sole layer is root and we're viewing root; inside any
    // folder (rootId set) there is structure to outline.
    flat: layers.length <= 1 && layers[0]?.rootId === null,
    layers,
    currentLayer: rootId,
    selection,
    recent,
  }
}


/** Pick titles for a layer, putting selected + recently-changed members first. */
const sampleTitles = (nodes: Node[], selected: Set<string>, recentIds: Set<string>, cap: number): string[] => {
  const priority = (n: Node): number => (selected.has(nodeIdOf(n)) ? 0 : recentIds.has(nodeIdOf(n)) ? 1 : 2)
  return [...nodes]
    .sort((a, b) => priority(a) - priority(b))
    .slice(0, cap)
    .map((n) => nodeTitle(n))
}


/**
 * Collapse the oplog tail to one net change per node id, in op order:
 * add+remove cancels, add+edit stays add, edit+remove becomes delete, a re-add
 * after remove becomes add. Edge/group/frame ops are ignored.
 */
const collapseRecent = (recentOps: OplogRecord[], liveTitles: Map<string, string>): RecentChange[] => {
  const net = new Map<string, "add" | "edit" | "delete">()
  const labels = new Map<string, string>()
  for (const rec of recentOps) {
    for (const op of rec.batch.ops) {
      if (op.type === "node.add") {
        net.set(nodeIdOf(op.node), "add")
        labels.set(nodeIdOf(op.node), nodeTitle(op.node))
      } else if (op.type === "node.update") {
        const id = op.id as unknown as string
        // Don't let a stray update override an add (title stays the add's) or a
        // delete (a node can't be edited after removal — keep the delete).
        const prev = net.get(id)
        if (prev !== "add" && prev !== "delete") net.set(id, "edit")
      } else if (op.type === "node.remove") {
        const id = nodeIdOf(op.node)
        if (net.get(id) === "add") net.delete(id)
        else net.set(id, "delete")
        labels.set(id, nodeTitle(op.node))
      }
    }
  }
  // Drop phantom add/edit for a node that isn't on the board now (e.g. an
  // add+remove that cancelled, then a stray update flips the empty entry to
  // "edit"). Deletes are always kept (the node is legitimately gone).
  return [...net]
    .filter(([id, op]) => op === "delete" || liveTitles.has(id))
    .map(([id, op]) => ({ id, op, label: labels.get(id) ?? liveTitles.get(id) ?? "(untitled)" }))
}


const kindLabel = (kind: string, n: number): string => {
  const forms = KIND_PLURAL[kind as NodeKind]
  const [one, many] = forms ?? [kind, `${kind}s`]
  return `${n} ${n === 1 ? one : many}`
}


/**
 * Render the snapshot to the injected text block (budget-driven, deterministic).
 * `opts.title` is the board title.
 */
export const renderBoardSnapshot = (
  snapshot: BoardSnapshot,
  opts: { title: string },
): string => {
  if (snapshot.total === 0) {
    // Still surface recent changes on a now-empty board — a full clear since you
    // last checked is exactly the "what moved while I was gone" signal to keep.
    const recentLine = renderRecent(snapshot.recent)
    return `Board snapshot: empty board — no nodes yet.${recentLine ? `\n${recentLine}` : ""}`
  }

  const lines: string[] = ["Board snapshot (point-in-time — re-check with tools before acting on it):"]
  lines.push(`- Title: ${opts.title}`)

  const breakdown = Object.entries(snapshot.counts)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => kindLabel(kind, n))
    .join(", ")
  lines.push(`- ${snapshot.total} node${snapshot.total === 1 ? "" : "s"}: ${breakdown}${snapshot.flat ? " — all at root (flat)" : ""}`)

  if (snapshot.flat) {
    const root = snapshot.layers.find((l) => l.rootId === null)
    if (root) lines.push(`- Nodes: ${root.sampleTitles.join(", ")}${root.count > root.sampleTitles.length ? `, … (showing ${root.sampleTitles.length} of ${root.count})` : ""}`)
  } else {
    lines.push(...renderLayers(snapshot))
  }

  if (snapshot.selection.length) {
    const sel = snapshot.selection.slice(0, MAX_SELECTION_TITLES)
    const more = snapshot.selection.length > sel.length ? `, +${snapshot.selection.length - sel.length} more` : ""
    lines.push(`- Selection: ${snapshot.selection.length} selected — ${sel.map((t) => `"${t}"`).join(", ")}${more}`)
  }

  const recentLine = renderRecent(snapshot.recent)
  if (recentLine) lines.push(recentLine)

  return lines.join("\n")
}


/**
 * The "Layers (…)" outline: top-K by size, current always included, remainder
 * collapsed. Root is a *layer*, not a folder, so the wording says "layers".
 */
const renderLayers = (snapshot: BoardSnapshot): string[] => {
  const layers = snapshot.layers
  const shown = layers.slice(0, MAX_LAYERS)
  // Guarantee the current layer is present even when it isn't in the top-K by size.
  const current = layers.find((l) => l.rootId === snapshot.currentLayer)
  if (current && !shown.includes(current)) {
    shown[shown.length - 1] = current
  }
  // Everything not shown (compute after the current-layer swap, so the displaced
  // top-K layer lands here and the swapped-in current layer is not double-counted).
  const hidden = layers.filter((l) => !shown.includes(l))

  const header = `- Layers (${layers.length} total${hidden.length ? `, top ${shown.length} by size` : ""}):`
  const rows = shown.map((l) => {
    const path = l.rootId === null ? "/ (root" : `/${l.title}`
    const marker = l.rootId === snapshot.currentLayer ? (l.rootId === null ? ", current)" : " (current)") : l.rootId === null ? ")" : ""
    const titles = l.sampleTitles.length ? ` — ${l.sampleTitles.join(", ")}${l.count > l.sampleTitles.length ? ", …" : ""}` : ""
    return `  - ${path}${marker}: ${l.count} node${l.count === 1 ? "" : "s"}${titles}`
  })

  if (hidden.length) {
    const names = hidden.slice(0, 4).map((l) => l.title).join(", ")
    const nodes = hidden.reduce((sum, l) => sum + l.count, 0)
    rows.push(`  - + ${hidden.length} more (${names}${hidden.length > 4 ? ", …" : ""}) — ${nodes} nodes total`)
  }
  return [header, ...rows]
}


/** The "Recent changes" line, or null when nothing changed. */
const renderRecent = (recent: RecentChange[]): string | null => {
  if (!recent.length) return null
  const added = recent.filter((r) => r.op === "add")
  const edited = recent.filter((r) => r.op === "edit")
  const deleted = recent.filter((r) => r.op === "delete")
  const part = (verb: string, rows: RecentChange[]): string | null => {
    if (!rows.length) return null
    const titles = rows.slice(0, RECENT_TITLES).map((r) => `"${r.label}"`).join(", ")
    const more = rows.length > RECENT_TITLES ? `, +${rows.length - RECENT_TITLES} more` : ""
    return `${verb === "added" ? "+" : verb === "edited" ? "~" : "-"}${rows.length} ${verb} (${titles}${more})`
  }
  const parts = [part("added", added), part("edited", edited), part("deleted", deleted)].filter(Boolean)
  return `- Recent changes since you last checked: ${parts.join(", ")}`
}


/**
 * Read the oplog tail past `sinceSeq` for the board — one indexed range query.
 * The oplog only holds ops since the last snapshot, so the tail is bounded by the
 * snapshot cadence (not the board's full history).
 */
export const readRecentOps = (
  engine: StorageEngine,
  boardId: string,
  sinceSeq: number,
): Promise<OplogRecord[]> =>
  engine.list<OplogRecord>("oplog", {
    range: { lower: [boardId, sinceSeq], upper: [boardId, Number.MAX_SAFE_INTEGER], lowerOpen: true },
  })
