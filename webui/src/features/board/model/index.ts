/**
 * Phase A — local-first data model (A0).
 *
 * The persisted/synced model IS the canvas-harness scene: geometry, content,
 * style, and groups are native `@canvas-harness/core` fields, so persistence is
 * identity (no convert layer). dim0's non-geometry domain fields ride in the
 * node/edge `data` slot (`DimNodeData` / `DimEdgeData`) — the one place the
 * library leaves open for app payload.
 *
 * Three board planes, by who-owns-and-what-syncs:
 *   - BoardContent — shared CRDT content (nodes/edges/groups). Synced.
 *   - BoardMeta    — title/kind/ACL. Server-authoritative (D1) + local index.
 *   - BoardView    — camera/selection. Per-device, never synced as content.
 *
 * See offline-first-data-model.md for the rationale.
 */
import type {
  CameraState,
  EdgeId,
  Group,
  NodeId,
  SchemaVersion,
  Edge as ChEdge,
  Node as ChNode,
} from "@canvas-harness/core"
import type { RichText } from "@/features/board/types/note"


/** App-level id. canvas-harness brands node/edge ids; this is the unbranded form. */
export type Id = string


/**
 * The string form of a node/edge `label`. The canonical shape is `RichText`
 * (`{ markdown }`, matching the backend `Resource.label` and the convert layer),
 * but boards persisted before unification may still hold a bare string — tolerate
 * both so legacy local boards keep reading. Prefer this over `label.markdown`.
 */
export const labelText = (label: { markdown?: string } | string | undefined): string =>
  typeof label === "string" ? label : (label?.markdown ?? "")


/** Coerce a label (possibly a legacy bare string) to the canonical `RichText`. */
export const asRichLabel = (label: RichText | string | undefined): RichText | undefined =>
  label === undefined ? undefined : typeof label === "string" ? { markdown: label } : label


/**
 * Per-entity sync + lifecycle envelope. Rides inside `data.meta`.
 * `updatedAt` is wall-clock for DISPLAY only — never used for merge ordering.
 * `hlc` (logical clock) is deferred to Lift 2; v1 leans on relay ordering.
 */
export type SyncMeta = {
  v: number
  createdAt: number
  updatedAt: number
  deletedAt?: number
}


/**
 * Typed metadata value with a runtime-defined key. Only used in the optional
 * `props` bag (user-defined columns + agent outputs); omitted entirely in v1
 * unless those features ship. Values are always typed — only keys are dynamic.
 */
export type DataProperty =
  | { id: Id; type: "number"; number: number | null }
  | { id: Id; type: "date"; date: string | null }
  | { id: Id; type: "boolean"; boolean: boolean | null }
  | { id: Id; type: "text"; text: string | null }
  | { id: Id; type: "keyword"; value: string | number | null }
  | { id: Id; type: "url"; url: string | null }
  | { id: Id; type: "image"; image: { url: string; caption?: string } | null }
  | { id: Id; type: "file"; file: { url: string; name: string; size?: number } | null }
  | { id: Id; type: "location"; location: { lat: number; lng: number } | null }
  | { id: Id; type: "multi_text"; texts: string[] }
  | { id: Id; type: "multi_keyword"; values: (string | number)[] }
  // agent outputs — payloads kept loose for now (typed when the agent lands)
  | { id: Id; type: "reasoning"; reasoning: unknown[] }
  | { id: Id; type: "source"; sources: unknown[] }


/**
 * dim0 payload carried in a canvas-harness `node.data`. Geometry (x/y/w/h/z/
 * angle), body (`node.content`), style, and groups stay native on the node.
 * Type-specific fields (image/icon/code/frame) sit flat here too, since the
 * library reads e.g. `data.src` directly for built-in image/icon nodes.
 */
export type DimNodeData = {
  /** Title (RichText, matching the backend `Resource.label`). Body → `node.content`.
   *  Read via `labelText()` — legacy local boards may hold a bare string. */
  label?: RichText
  /** Containment / subspace parent (recursive boards). */
  parentId?: Id | null
  pinned?: boolean
  listOrder?: number
  url?: string
  /** Optional dynamic metadata — user-defined columns + agent outputs. */
  props?: Record<string, DataProperty>
  meta: SyncMeta

  /**
   * Source-of-truth colors as picked (theme-independent). The display
   * `node.style.{bg,stroke,text}` is projected from these per theme mode;
   * keeping the canonical triplet here lets a theme flip re-project without
   * corrupting stored colors. Mirrors `NoteNodeData._storedColors`.
   */
  _storedColors?: { backgroundColor?: string; strokeColor?: string; textColor?: string }

  // type-specific (flat — read by the library for built-in types)
  src?: string //         image / icon source
  naturalW?: number //    image
  naturalH?: number //    image
  alt?: string //         image / icon
  language?: string //    code
  slideName?: string //   frame
  slideNumber?: number // frame
}


/** dim0 payload carried in a canvas-harness `edge.data`. */
export type DimEdgeData = {
  // NOTE: the edge label is `edge.content` (what the harness renders + the convert
  // layer round-trips to `Link.label`), NOT a `data.label`. A legacy `data.label`
  // written by an older link tool is migrated to `content` on load.
  parentId?: Id | null
  props?: Record<string, DataProperty>
  meta: SyncMeta

  /**
   * Source-of-truth edge colors as picked (theme-independent; no fill — edges
   * are stroke + label). `edge.style.{stroke,text}` is projected from these per
   * theme mode. Kept here so a theme flip re-projects without corrupting the
   * stored colors, and so persist round-trips the canonical (not dark-adapted)
   * value. Mirrors `DimNodeData._storedColors` / `LinkEdgeData._storedColors`.
   */
  _storedColors?: { strokeColor?: string; textColor?: string }
}


/** A dim0 node — a canvas-harness node with a typed `data` payload. */
export type DimNode = ChNode & { data?: DimNodeData }


/** A dim0 edge — a canvas-harness edge with a typed `data` payload. */
export type DimEdge = ChEdge & { data?: DimEdgeData }


/**
 * Shared, synced board content — the CRDT document. Excludes camera/selection
 * (those are per-device view state, not shared). Persisted as snapshot + oplog.
 */
export type BoardContent = {
  schemaVersion: SchemaVersion
  nodes: DimNode[]
  edges: DimEdge[]
  groups: Group[]
  frameOrder?: NodeId[]
}


/**
 * Normalize board content to the canonical label shape at the READ source (called
 * from `BoardPersistence.materialize`, so display hydrate, whole-board search, and
 * the enable-sync `capture()` all get migrated content — a legacy label isn't lost
 * when a local board is promoted to synced). Idempotent and churn-free: unchanged
 * nodes/edges keep their identity.
 *   - node `data.label`: coerce a legacy bare string → RichText.
 *   - edge label: the harness renders `edge.content`; migrate a legacy
 *     `data.label` (string OR RichText, from an older link tool) → `content` and
 *     strip the dead field. Existing `content` wins.
 */
export const normalizeBoardContent = (content: BoardContent): BoardContent => {
  const nodes = content.nodes.map((n) => {
    if (!n.data) return n
    const label = asRichLabel(n.data.label)
    return label === n.data.label ? n : { ...n, data: { ...n.data, label } }
  })
  const edges = content.edges.map((e) => {
    const data = e.data as (DimEdgeData & { label?: unknown }) | undefined
    // No legacy label → nothing to migrate; keep the edge as-is (identity, so a
    // label-less edge with content:"" isn't rewritten to undefined every load).
    if (!data || !("label" in data)) return e
    const migrated = e.content || labelText(data.label as string | { markdown?: string } | undefined) || undefined
    const rest = { ...data } as DimEdgeData & { label?: unknown }
    delete rest.label // drop the dead field (edge label lives in `content`)
    return { ...e, content: migrated, data: rest }
  })
  return { ...content, nodes, edges }
}


/** How a board is hosted. `local-only` = IndexedDB only, no account, no relay. */
export type BoardKind = "local-only" | "synced"


export type BoardRole = "owner" | "editor" | "viewer"


/**
 * Board metadata — server-authoritative (D1) for synced boards, plus a local
 * index entry for offline listing. NOT part of the synced CRDT content.
 */
export type BoardMeta = {
  id: Id
  title: string
  kind: BoardKind
  // Which collab client a `synced` board mounts. Absent ⇒ legacy `use-ws-collab`.
  // Set to `"v2"` on boards born from (or promoted into) the offline-first
  // coordinator. Ignored for `local-only` boards. Transient migration field:
  // removed once every synced board is v2 and the legacy client is retired.
  syncEngine?: "legacy" | "v2"
  ownerId?: Id
  acl?: Record<Id, BoardRole>
  visibility: "private" | "shared" | "public"
  thumbnail?: string
  // Derived semantic PURPOSE of the board (what it's about), 1-2 sentences, and
  // its drift baseline: the wall-clock and the oplog seq at the last derive.
  // Device-local (the seq is per-device); re-derived at turn end when the board
  // has drifted enough. Absent until the first derive.
  context?: string
  contextDerivedAt?: number
  contextDeriveSeq?: number
  createdAt: number
  updatedAt: number
  deletedAt?: number
}


/** Per-device view state. Never synced as content; persisted locally per board. */
export type BoardView = {
  camera: CameraState
  selection: (NodeId | EdgeId)[]
}
