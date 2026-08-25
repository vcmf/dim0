/**
 * BoardMutator — the agent's content-level write port (S1 of the board-authoring
 * plan). Tools express intent in domain verbs (createNote / rewriteNote /
 * patchNote / createLink); the *implementation* owns how that reaches the board.
 *
 * `StoreMutator` is the current impl: it writes through the live canvas `store`
 * exactly as the tools did inline before this port existed — so a write still
 * flows through the same undo + persistence + sync pipeline as a human edit, with
 * identical bytes. This is a pure decoupling: later impls (e.g. a headless,
 * off-screen, cross-layer writer) can satisfy the same interface without the tool
 * code changing.
 */
import { asEdgeId, asNodeId } from "@canvas-harness/core"
import type { CanvasStore, Node } from "@canvas-harness/core"
import type { DimEdgeData, DimNodeData } from "@/features/board/model"
import { FAMILIES, pickRandomColorOfShade, resolveFamilyShade, toBaseHex } from "@/features/board/lib/colors/tailwind"
import { hexToRgb } from "@/features/board/utils/color"
import { AUTOFIT_DISABLED_TYPES } from "@/features/board/harness/convert/note-to-node"
import { dim0LinkStyleToCanvas, dim0StyleToCanvas } from "@/features/board/harness/convert/style"
import {
  adaptEdgeColors,
  adaptNodeColors,
  applyColorsToEdgeStyle,
  applyColorsToStyle,
  pickStoredEdgeColors,
  type StoredColors,
  type StoredEdgeColors,
} from "@/features/board/harness/theme/color-adapter"
import { getBoardThemeMode } from "@/features/board/harness/theme/theme-mode-ref"
import { createDefaultLinkStyle, createDefaultStyle } from "@/features/board/types/style"
import { beneathBorderOrigin } from "@/features/board/harness/agent/beneath-border"
import { estimateNoteSize } from "./note-size"


/** Which side of an anchor note to place a new note on. */
export type NearDir = "above" | "below" | "left" | "right"


/** A note to create or fully rewrite. `type` is the prompt-level note_type. */
export type NoteSpec = {
  id?: string
  content: string
  label?: string
  type?: string
  /** Explicit position (the raw escape hatch); omitted → auto/near. Pins the note. */
  x?: number
  y?: number
  /**
   * Relational placement next to an existing note (preferred over raw x/y): the
   * new note is placed on `dir` side of `nodeId`, `gap` px away, nudged along
   * `dir` to avoid overlap. Pins the note (excluded from post-turn auto-arrange).
   */
  near?: { nodeId: string; dir: NearDir; gap?: number }
  /** Optional fill / border by color NAME (a `FAMILIES` id); omitted → random fill. */
  colors?: { background?: string; border?: string }
}


/** A directed link between two existing notes. */
export type LinkSpec = {
  sourceId: string
  targetId: string
  label?: string
}


/**
 * Content-level board write port. Domain verbs only — no ops, batches, or seq in
 * the signature; the impl decides how the write reaches persistence + sync.
 */
export interface BoardMutator {
  /** `placed` = pinned at an explicit/relational position (exclude from arrange). */
  createNote(spec: NoteSpec): Promise<{ id: string; created: true; placed: boolean }>
  rewriteNote(id: string, spec: NoteSpec): Promise<{ id: string; created: boolean }>
  patchNote(id: string, patch: { content?: string; label?: string }): Promise<void>
  createLink(spec: LinkSpec): Promise<{ id: string }>
}


// ---- construction helpers (moved verbatim from tools.ts) -------------------

/**
 * A random Tailwind-200 fill per note (mirrors the backend's
 * `random.choice(TAILWIND_200_ADAPTED)`). Stored as `_storedColors` so the theme
 * hooks project the display style for the current mode.
 */
const randomNoteColors = (): StoredColors => ({
  backgroundColor: pickRandomColorOfShade(200)?.hex ?? "#dbeafe",
  strokeColor: "#00000000",
  textColor: "#000000",
})


// Note fill shade per type. Rectangles use 200 (the default note look); sheets
// honor only a LIGHT tint (their view gates on shade-100), so agent-set sheet
// colors resolve there. Types not listed use the rectangle default.
const NOTE_SHADE = 200
const SHADE_BY_TYPE: Record<string, number> = { sheet: 100 }
const shadeForType = (nodeType: string): number => SHADE_BY_TYPE[nodeType] ?? NOTE_SHADE


/**
 * Resolve a color NAME (a `FAMILIES` id — a Tailwind family, or the specials
 * white / black / transparent) to a paper-adapted hex at the given shade. `null`
 * for an unknown name, so the caller can fall back to a default.
 */
const resolveColorName = (name: string, shade: number): string | null => {
  const fam = FAMILIES.find((f) => f.id === name)
  if (!fam) return null
  if (fam.transparent) return "#00000000"
  if (fam.fixedHex) return fam.fixedHex
  return fam.family ? resolveFamilyShade(fam.family, shade) : null
}


/**
 * Legible text color for a fill: white on a dark background, black otherwise.
 * A transparent fill (`#RRGGBB00`) sits on the light board → black.
 */
const textColorFor = (bgHex: string | undefined): string => {
  if (!bgHex || /^#[0-9a-fA-F]{6}00$/.test(bgHex)) return "#000000"
  const base = toBaseHex(bgHex)
  if (!base) return "#000000"
  const { r, g, b } = hexToRgb(base)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 140 ? "#ffffff" : "#000000"
}


/**
 * Build a note's stored colors from optional family-name choices, at the shade
 * the note type honors. Falls back to a random fill (the default look); text is
 * derived from the fill for contrast. Unresolvable names are ignored (fall back),
 * never throw.
 */
const resolveNoteColors = (colors: NoteSpec["colors"], nodeType: string): StoredColors => {
  const shade = shadeForType(nodeType)
  const random = randomNoteColors()
  const bg = colors?.background ? resolveColorName(colors.background, shade) : null
  const border = colors?.border ? resolveColorName(colors.border, shade) : null
  const backgroundColor = bg ?? random.backgroundColor
  return {
    backgroundColor,
    strokeColor: border ?? random.strokeColor,
    textColor: textColorFor(backgroundColor),
  }
}


// Custom (non-rect) types whose view paints a background from the node style, so
// an agent-set color should be projected onto `style` (not just stored).
const COLORABLE_CUSTOM_TYPES = new Set(["sheet"])


// Gap (px) between a relationally-placed note and its anchor when not specified.
const NEAR_GAP = 48


type Box = { x: number; y: number; w: number; h: number }
type XYWH = { x: number; y: number; w: number; h: number }


/** AABB overlap test. */
const overlapsBox = (a: Box, n: XYWH): boolean =>
  a.x < n.x + n.w && a.x + a.w > n.x && a.y < n.y + n.h && a.y + a.h > n.y


/** Initial box for a note placed on `dir` side of `anchor`, centered on the
 *  perpendicular axis, `gap` px away. */
const adjacentBox = (anchor: XYWH, dir: NearDir, gap: number, w: number, h: number): Box => {
  const cx = anchor.x + anchor.w / 2
  const cy = anchor.y + anchor.h / 2
  switch (dir) {
    case "right": return { x: anchor.x + anchor.w + gap, y: cy - h / 2, w, h }
    case "left": return { x: anchor.x - gap - w, y: cy - h / 2, w, h }
    case "below": return { x: cx - w / 2, y: anchor.y + anchor.h + gap, w, h }
    case "above": return { x: cx - w / 2, y: anchor.y - gap - h, w, h }
  }
}


/** Push `box` just past the given blockers along `dir` (+ gap) — the local nudge
 *  that keeps a relational placement collision-free without leaving the direction. */
const pushPast = (box: Box, dir: NearDir, hits: XYWH[], gap: number): Box => {
  switch (dir) {
    case "right": return { ...box, x: Math.max(...hits.map((n) => n.x + n.w)) + gap }
    case "left": return { ...box, x: Math.min(...hits.map((n) => n.x)) - gap - box.w }
    case "below": return { ...box, y: Math.max(...hits.map((n) => n.y + n.h)) + gap }
    case "above": return { ...box, y: Math.min(...hits.map((n) => n.y)) - gap - box.h }
  }
}


/**
 * Whether a color request actually affects this node type — and thus should be
 * applied. Rectangles honor fill + border; sheets honor only a background tint
 * (no border in their view), so a border-only request on a sheet is a no-op and
 * must NOT trigger a (random) fill; other types ignore color entirely.
 */
const colorTargets = (nodeType: string, colors: NoteSpec["colors"]): boolean => {
  if (nodeType === "rect") return !!(colors?.background || colors?.border)
  if (COLORABLE_CUSTOM_TYPES.has(nodeType)) return !!colors?.background
  return false
}


/**
 * Recolor an EXISTING note: override only the channels the caller named,
 * preserving the note's other stored colors (and its text unless the fill
 * changed). Unlike `resolveNoteColors` (create), this never randomizes an
 * unspecified channel.
 */
const mergeNoteColors = (existing: StoredColors | undefined, colors: NoteSpec["colors"], nodeType: string): StoredColors => {
  const shade = shadeForType(nodeType)
  const base = existing ?? randomNoteColors()
  const bg = colors?.background ? resolveColorName(colors.background, shade) : null
  const border = colors?.border ? resolveColorName(colors.border, shade) : null
  const backgroundColor = bg ?? base.backgroundColor
  return {
    backgroundColor,
    strokeColor: border ?? base.strokeColor,
    textColor: bg ? textColorFor(backgroundColor) : (base.textColor ?? textColorFor(backgroundColor)),
  }
}


// Default box size per canvas node type (mirrors backend get_default_note_size).
const DEFAULT_SIZE: Record<string, { w: number; h: number }> = {
  rect: { w: 320, h: 180 },
  ellipse: { w: 320, h: 320 },
  diamond: { w: 340, h: 340 },
  sheet: { w: 440, h: 440 },
  "mini-app": { w: 720, h: 440 },
  widget: { w: 480, h: 320 },
  "code-sandbox": { w: 560, h: 360 },
}


/** Content-fit size for a note, falling back to the type's default box. */
const noteGeometry = (nodeType: string, content: string): { w: number; h: number } => {
  const base = DEFAULT_SIZE[nodeType] ?? { w: 320, h: 180 }
  const fitted = estimateNoteSize(nodeType, base.w, content)
  return fitted ? { w: fitted.width, h: fitted.height } : base
}


/** Fresh SyncMeta stamp for a created/updated entity. */
const meta = (): DimNodeData["meta"] => {
  const t = Date.now()
  return { v: 1, createdAt: t, updatedAt: t }
}


/**
 * Canonical canvas style for a live-created rectangle — mirrors the convert layer
 * so a freshly inserted node renders identically to its reloaded / peer-synced form.
 */
const canonicalNodeStyle = (colors: StoredColors) => {
  const base = dim0StyleToCanvas(createDefaultStyle({ type: "rectangle" }))
  const mode = getBoardThemeMode()
  const display = mode === "dark" ? adaptNodeColors(colors, "dark") : colors
  return applyColorsToStyle(base, display)
}


/** Canonical edge `style` (theme-adapted) + the light-space `_storedColors`. */
const canonicalEdge = (): { style: ReturnType<typeof dim0LinkStyleToCanvas>; storedColors: StoredEdgeColors } => {
  const base = dim0LinkStyleToCanvas(createDefaultLinkStyle())
  const storedColors = pickStoredEdgeColors(base)
  const mode = getBoardThemeMode()
  const style = mode === "light" ? base : applyColorsToEdgeStyle(base, adaptEdgeColors(storedColors, mode))
  return { style, storedColors }
}


// Map a prompt-level note_type to a canvas node type. Unknown → rectangle.
const NODE_TYPE: Record<string, string> = {
  rectangle: "rect",
  rect: "rect",
  sheet: "sheet",
  "mini-app": "mini-app",
  widget: "widget",
  "code-sandbox": "code-sandbox",
}
const toNodeType = (t: string): string => NODE_TYPE[t] ?? "rect"


// ---- StoreMutator: writes through the live store (today's behavior) ---------

/**
 * Writes through the live canvas store — the current-layer producer. Reproduces
 * the exact node/edge construction the tools did inline, so behavior is identical
 * (same undo + persistence + sync pipeline).
 */
export class StoreMutator implements BoardMutator {
  private readonly store: CanvasStore
  private readonly rootId: string | null

  constructor(store: CanvasStore, rootId: string | null) {
    this.store = store
    this.rootId = rootId
  }

  async createNote(spec: NoteSpec): Promise<{ id: string; created: true; placed: boolean }> {
    const nodeType = toNodeType(spec.type ?? "")
    const autoFitStyle = AUTOFIT_DISABLED_TYPES.has(nodeType) ? { autoFit: false } : undefined
    const storedColors = resolveNoteColors(spec.colors, nodeType)
    const { w, h } = noteGeometry(nodeType, spec.content)
    const { x, y, placed } = this.placeNote(spec, w, h)
    // Plain rectangles are painted by the lib from `style`. A colorable custom
    // type (sheet) whose FILL was explicitly set gets it projected onto `style`
    // so its own view honors it; other custom types paint via their own view and
    // only need autoFit disabled at birth.
    const style: Record<string, unknown> | undefined =
      nodeType === "rect"
        ? { ...canonicalNodeStyle(storedColors), ...(autoFitStyle ?? {}) }
        : colorTargets(nodeType, spec.colors)
          ? this.colorStyle(nodeType, storedColors, {}, autoFitStyle)
          : autoFitStyle
    const id = asNodeId(spec.id || this.store.generateId())
    this.store.batch(() => {
      this.store.addNode({
        id,
        type: nodeType,
        x,
        y,
        w,
        h,
        angle: 0,
        groups: [],
        content: spec.content,
        ...(style ? { style } : {}),
        data: {
          label: { markdown: spec.label ?? "" },
          parentId: this.rootId ?? undefined,
          meta: meta(),
          _storedColors: storedColors,
        } satisfies DimNodeData,
      })
    })
    return { id: String(id), created: true, placed }
  }

  /**
   * Resolve a new note's position and whether it is *pinned* (placed at an
   * explicit/relational spot → excluded from the post-turn auto-arrange):
   *  - `near` → relational: adjacent to the anchor, nudged along `dir` to avoid
   *    overlap (falls back to auto if the anchor is gone).
   *  - explicit `x`+`y` → verbatim, no collision avoidance.
   *  - neither → auto: beneath the current board border (arranged after the turn).
   */
  private placeNote(spec: NoteSpec, w: number, h: number): { x: number; y: number; placed: boolean } {
    if (spec.near) {
      const p = this.nearPosition(spec.near, w, h)
      if (p) return { ...p, placed: true }
    }
    if (spec.x !== undefined && spec.y !== undefined) return { x: spec.x, y: spec.y, placed: true }
    const origin = beneathBorderOrigin(this.store)
    return { x: origin.x, y: origin.y, placed: false }
  }

  /** Relational anchor placement + local overlap nudge; null if the anchor is gone. */
  private nearPosition(near: NonNullable<NoteSpec["near"]>, w: number, h: number): { x: number; y: number } | null {
    const anchor = this.store.getNode(asNodeId(near.nodeId))
    if (!anchor) return null
    const gap = near.gap ?? NEAR_GAP
    const others = this.store.getAllNodes().filter((n) => n.id !== anchor.id)
    let box = adjacentBox(anchor, near.dir, gap, w, h)
    // Step past overlaps ALONG dir (bounded) so the note lands where asked, clear.
    for (let i = 0; i < 64; i += 1) {
      const hits = others.filter((n) => overlapsBox(box, n))
      if (hits.length === 0) break
      box = pushPast(box, near.dir, hits, gap)
    }
    return { x: box.x, y: box.y }
  }

  /**
   * Project stored colors onto a style for a colorable type (rect / sheet),
   * theme-adapted. `baseStyle` is the style to fold the colors into (the
   * canonical rect base on create, the existing node style on recolor).
   */
  private colorStyle(nodeType: string, storedColors: StoredColors, baseStyle: Record<string, unknown>, autoFitStyle?: { autoFit: boolean }): Record<string, unknown> {
    const mode = getBoardThemeMode()
    const display = mode === "dark" ? adaptNodeColors(storedColors, "dark") : storedColors
    if (nodeType === "rect") return { ...applyColorsToStyle(baseStyle, display), ...(autoFitStyle ?? {}) }
    return applyColorsToStyle({ ...baseStyle, ...(autoFitStyle ?? {}) }, display) // colorable custom (sheet)
  }

  async rewriteNote(id: string, spec: NoteSpec): Promise<{ id: string; created: boolean }> {
    const nid = asNodeId(id)
    const node = this.store.getNode(nid)
    // No such node → treat as a create with this id (mirrors write_note fallthrough).
    if (!node) return this.createNote({ ...spec, id })
    // Preserve the existing type when the caller didn't ask to change it — a bare
    // body rewrite must NOT silently convert a sheet / mini-app into a rectangle.
    const nodeType = spec.type ? toNodeType(spec.type) : node.type
    const autoFitStyle = AUTOFIT_DISABLED_TYPES.has(nodeType) ? { autoFit: false } : undefined
    const prev = node.data as DimNodeData | undefined

    const data: DimNodeData = {
      ...prev,
      label: spec.label ? { markdown: spec.label } : (prev?.label ?? { markdown: "" }),
      meta: meta(),
    } as DimNodeData
    // Default: keep the existing style (+ autoFit for custom types). Recolor only
    // the channels the caller named (merge, don't randomize the rest), and only
    // for a type/channel that actually honors it.
    let style: Record<string, unknown> | undefined = autoFitStyle ? { ...(node.style ?? {}), ...autoFitStyle } : undefined
    if (colorTargets(nodeType, spec.colors)) {
      const storedColors = mergeNoteColors(prev?._storedColors, spec.colors, nodeType)
      data._storedColors = storedColors
      style = this.colorStyle(nodeType, storedColors, node.style ?? {}, autoFitStyle)
    }

    this.store.batch(() =>
      this.store.updateNode(nid, {
        type: nodeType,
        content: spec.content,
        data,
        ...(style ? { style } : {}),
      }),
    )
    return { id: String(nid), created: false }
  }

  async patchNote(id: string, patch: { content?: string; label?: string }): Promise<void> {
    const nid = asNodeId(id)
    const node = this.store.getNode(nid)
    if (!node) return
    const prev = node.data as DimNodeData | undefined
    const next: Partial<Node> = {}
    if (patch.content !== undefined) next.content = patch.content
    if (patch.label !== undefined) next.data = { ...prev, label: { markdown: patch.label }, meta: meta() }
    this.store.batch(() => this.store.updateNode(nid, next))
  }

  async createLink(spec: LinkSpec): Promise<{ id: string }> {
    const id = asEdgeId(this.store.generateId())
    const src = asNodeId(spec.sourceId)
    const tgt = asNodeId(spec.targetId)
    // Attach at each node's CENTER (local frame from top-left); canvas-harness
    // auto-clips the center→center line to each node's border.
    const center = (nodeId: typeof src): { x: number; y: number } => {
      const node = this.store.getNode(nodeId)
      return node ? { x: node.w / 2, y: node.h / 2 } : { x: 0, y: 0 }
    }
    const { style, storedColors } = canonicalEdge()
    this.store.batch(() => {
      this.store.addEdge({
        id,
        source: { nodeId: src, localOffset: center(src) },
        target: { nodeId: tgt, localOffset: center(tgt) },
        pathStyle: "bezier",
        groups: [],
        style,
        data: {
          label: spec.label || undefined,
          parentId: this.rootId ?? undefined,
          meta: meta(),
          _storedColors: storedColors,
        } satisfies DimEdgeData,
      })
    })
    return { id: String(id) }
  }
}
