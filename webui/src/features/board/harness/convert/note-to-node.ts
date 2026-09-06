import { asGroupId, asNodeId } from "@canvas-harness/core"
import type { Node } from "@canvas-harness/core"
import type { Note, NoteProperties, RichText } from "@/features/board/types/note"
import { asRichLabel } from "@/features/board/model"
import type { Document } from "@/features/board/types/document"
import type { NodeType as Dim0NodeType } from "@/features/board/types/style"
import {
  adaptNodeColors,
  applyColorsToStyle,
  pickStoredColors,
  type StoredColors,
} from "../theme/color-adapter"
import { getBoardThemeMode } from "../theme/theme-mode-ref"
import { dim0TypeToCanvas } from "./node-type"
import { dim0StyleToCanvas } from "./style"


const DEG_TO_RAD = Math.PI / 180


/**
 * Custom node types where the lib's height autoFit must be off.
 *
 * autoFit measures `node.content` and forces `node.h` to fit on
 * resize-commit. For these types `node.content` is the full body
 * (sheet markdown, code sandbox source, widget HTML/JS) but the React
 * view only renders a preview — so autoFit would snap the node tall
 * enough for the whole body the user can't see, breaking height
 * resize. See migration plan §4.x.
 */
export const AUTOFIT_DISABLED_TYPES = new Set([
  "folder",
  "sheet",
  "code-sandbox",
  "widget",
  "mini-app",
  "document",
  "ink",
])


/**
 * Payload on `Node.data` that holds every Dim0 Note field which doesn't
 * lift onto a canvas-harness Node primitive. Round-trip integrity
 * depends on these being preserved.
 */
export type NoteNodeData = {
  noteType: "note" | "document"
  /**
   * The original Dim0 `note.style.type`. Preserved verbatim so we can
   * restore it on save — necessary because `node.type` may differ from
   * `style.type` for documents (which override node.type → "document"
   * while keeping a visual style.type underneath like "rectangle").
   */
  styleType: Dim0NodeType
  version: number
  createdAt?: string
  updatedAt?: string
  deletedAt?: string
  graphUid: string
  parentId?: string
  minWidth?: number
  minHeight?: number
  roughSeed?: number
  /** Title / display name. Used by breadcrumbs, sheet headers, folder names, list cards. */
  label?: RichText
  /** All Note properties except the ones lifted to Node primitives. */
  properties: Partial<NoteProperties>
  /**
   * Source-of-truth colors as the user picked them — these are what
   * the server stores. `node.style.{bg,stroke,text}` may carry adapted
   * variants in dark mode (see `theme/color-adapter.ts`). On save,
   * `nodeToNote` reads these instead of `node.style` so a theme toggle
   * never dirties or corrupts persisted colors.
   */
  _storedColors?: StoredColors
}


/** Convert a Dim0 Note (or Document) to a canvas-harness Node. */
export const noteToNode = (note: Note | Document): Node => {
  const pos = note.properties?.nodePosition?.position ?? { x: 0, y: 0 }
  const size = note.properties?.nodeSize?.size ?? { width: 320, height: 180 }
  const z = note.properties?.nodeZIndex?.number ?? 0

  const rest: Partial<NoteProperties> = { ...note.properties }
  delete (rest as Record<string, unknown>).nodePosition
  delete (rest as Record<string, unknown>).nodeSize
  delete (rest as Record<string, unknown>).nodeZIndex

  const data: NoteNodeData = {
    noteType: note.type,
    styleType: note.style.type,
    version: note.version,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    deletedAt: note.deletedAt,
    graphUid: note.graphUid,
    parentId: note.parentId,
    minWidth: note.minWidth,
    minHeight: note.minHeight,
    roughSeed: note.roughSeed,
    label: asRichLabel(note.label),
    properties: rest,
  }

  // Inline text on a shape lives in note.content.markdown — note.label is the
  // title (breadcrumbs / folder name / sheet header) and rides on data.label.
  // Older notes with text stored on label fall through to keep them visible.
  const body = note.content?.markdown ?? note.label?.markdown ?? ""

  // Documents get a distinct canvas type ("document") so they hit their
  // own paint dispatch + custom view. Everything else maps by style.type.
  const canvasType = note.type === "document"
    ? "document"
    : dim0TypeToCanvas(note.style.type)

  const baseStyle = dim0StyleToCanvas(note.style)
  if (AUTOFIT_DISABLED_TYPES.has(canvasType)) {
    baseStyle.autoFit = false
  }

  // Stash the original colors then project for the current theme mode.
  // Light mode: project is identity (display === stored). Dark mode:
  // style holds adapted variants while `_storedColors` keeps the truth.
  // Both branches funnel through `applyColorsToStyle` so derived fields
  // (`iconColor` mirroring `textColor`) get set in either mode — without
  // this funnel, light-mode icons would skip the mirror and render with
  // an undefined glyph color.
  const storedColors = pickStoredColors(baseStyle)
  const mode = getBoardThemeMode()
  const displayColors = mode === "dark" ? adaptNodeColors(storedColors, "dark") : storedColors
  const style = applyColorsToStyle(baseStyle, displayColors)
  data._storedColors = storedColors

  // Canvas-harness's image renderer reads `node.data.src` (see
  // ImageNodeData in core/types/node.ts), separate from the rest of
  // the round-tripped properties. Lift the image URL + dims onto
  // top-level data fields so paintImageNode sees them. nodeSize is
  // the post-downscale display size (already aspect-correct), so
  // reusing it for natural dims keeps resize aspect preservation
  // correct without stashing a second set of dims on the Note.
  const finalData: NoteNodeData & {
    src?: string
    naturalW?: number
    naturalH?: number
    alt?: string
  } = data
  if (canvasType === "image") {
    const url = note.properties?.imageUrl?.image?.url
    if (url) {
      finalData.src = url
      finalData.naturalW = size.width
      finalData.naturalH = size.height
      finalData.alt = note.label?.markdown
    }
  }

  return {
    id: asNodeId(note.id),
    type: canvasType,
    x: pos.x,
    y: pos.y,
    w: size.width,
    h: size.height,
    angle: (note.style.angle ?? 0) * DEG_TO_RAD,
    z,
    groups: (note.style.groupIds ?? []).map(asGroupId),
    content: body,
    style,
    data: finalData,
  }
}
