import { generateUuid, uuidToNumber } from "@/lib/common"
import { createDefaultStyle, type NodeType, type Style } from "./style"
import type { BooleanProperty, IconProperty, ImageProperty, InkProperty, NumberProperty, PositionProperty, SizeProperty, URLProperty, TextProperty, KeywordProperty } from "@/features/newsfeed/types/properties"


/**
 * Interface for properties of a note.
 */
export interface NoteProperties {
  nodePosition: PositionProperty
  nodeSize: SizeProperty
  nodeZIndex: NumberProperty
  /**
   * @deprecated Not read by any view. Superseded by `iconData`. Kept for
   * wire compatibility with existing rows; do not write new values here.
   */
  emoji: IconProperty
  pinned: BooleanProperty
  listOrder: NumberProperty
  url: URLProperty
  imageUrl: ImageProperty
  iconData: IconProperty
  slideName?: TextProperty
  slideNumber?: NumberProperty
  programmingLanguage?: TextProperty
  mimeType?: TextProperty
  status?: KeywordProperty
  summary?: TextProperty
  inkData?: InkProperty
}


/**
 * Interface for content of a note.
 */
export interface RichText {
  markdown: string
}


/**
 * Interface for a note.
 */
export interface Note extends Record<string, unknown> {
  id: string
  type: "note" | "document"
  version: number

  createdAt?: string
  updatedAt?: string
  deletedAt?: string

  properties: NoteProperties

  label?: RichText
  content?: RichText

  graphUid: string
  parentId?: string
  style: Style

  minWidth?: number
  minHeight?: number

  roughSeed?: number
}


// IMPORTANT: keep these constants in sync with `get_default_note_size`
// in backend/topix/agents/notes/service.py. The frontend handles
// canvas-toolbar creates; the backend handles agent-side `write_note`
// creates. A drift between them means agent-created notes land at
// different sizes than user-created ones.
export const DEFAULT_RECTANGLE_NOTE_WIDTH = 320
export const DEFAULT_RECTANGLE_NOTE_HEIGHT = 180
export const DEFAULT_ELLIPSE_NOTE_WIDTH = 320
export const DEFAULT_ELLIPSE_NOTE_HEIGHT = 320
export const DEFAULT_DIAMOND_NOTE_WIDTH = 340
export const DEFAULT_DIAMOND_NOTE_HEIGHT = 340

export const DEFAULT_TEXT_NOTE_WIDTH = 150
export const DEFAULT_TEXT_NOTE_HEIGHT = 20

// Sheet is our "sticky note": a long-form rich-text doc that scrolls,
// so a square jot surface reads better than a wide document card.
// 440x440 holds ~50 chars/line — comfortable for reading, while the
// square footprint signals "note", not "page". Sheets don't auto-fit
// height (they scroll), so this is the size they keep.
// Keep DEFAULT_SHEET_* in sync with get_default_note_size in
// backend/topix/agents/notes/service.py.
export const DEFAULT_SHEET_WIDTH = 440
export const DEFAULT_SHEET_HEIGHT = 440
export const SHEET_MIN_WIDTH = 200
export const SHEET_MIN_HEIGHT = 120

export const DEFAULT_SLIDE_WIDTH = 960
export const DEFAULT_SLIDE_HEIGHT = 540

export const DEFAULT_FOLDER_WIDTH = 150
export const DEFAULT_FOLDER_HEIGHT = 150
// Code-sandbox: rectangle sized for code line-length (~75 chars/line at
// typical monospace, close to the 80-char convention). Like sheet, it's a
// scrolling fixed-surface node — exempt from content-fit sizing, so this
// is the size it keeps. Keep in sync with get_default_note_size in
// backend/topix/agents/notes/service.py.
export const DEFAULT_CODE_SANDBOX_WIDTH = 560
export const DEFAULT_CODE_SANDBOX_HEIGHT = 360
export const DEFAULT_WIDGET_WIDTH = 800
export const DEFAULT_WIDGET_HEIGHT = 500
// Mini-apps trend toward interactive dashboards (charts + controls, lists
// with KPI rows, multi-section step-throughs) — wider than the earlier
// "counter / stepper" assumption. Paired with the 1200px auto-grow cap in
// view.tsx, this width keeps a max-grown card at a usable ~1.67:1
// portrait ratio instead of a thin column. Auto-resize via mini-app:resize
// still shrinks/grows the height; width is set once at creation and the
// user can drag-resize from there.
export const DEFAULT_MINI_APP_WIDTH = 720
export const DEFAULT_MINI_APP_HEIGHT = 440


/**
 * Function to create default properties for a note.
 * @returns Default properties for a note.
 */
export const createDefaultNoteProperties = ({ type = 'rectangle' }: { type?: NodeType }): NoteProperties => {
  const defaultSize = type === 'sheet'
    ? { width: DEFAULT_SHEET_WIDTH, height: DEFAULT_SHEET_HEIGHT }
    : type === 'text'
    ? { width: DEFAULT_TEXT_NOTE_WIDTH, height: DEFAULT_TEXT_NOTE_HEIGHT }
    : type === 'slide'
    ? { width: DEFAULT_SLIDE_WIDTH, height: DEFAULT_SLIDE_HEIGHT }
    : type === 'folder'
    ? { width: DEFAULT_FOLDER_WIDTH, height: DEFAULT_FOLDER_HEIGHT }
    : type === 'code-sandbox'
    ? { width: DEFAULT_CODE_SANDBOX_WIDTH, height: DEFAULT_CODE_SANDBOX_HEIGHT }
    : type === 'widget'
    ? { width: DEFAULT_WIDGET_WIDTH, height: DEFAULT_WIDGET_HEIGHT }
    : type === 'mini-app'
    ? { width: DEFAULT_MINI_APP_WIDTH, height: DEFAULT_MINI_APP_HEIGHT }
    : type === 'ellipse' || type === 'layered-circle'
    ? { width: DEFAULT_ELLIPSE_NOTE_WIDTH, height: DEFAULT_ELLIPSE_NOTE_HEIGHT }
    : type === 'diamond' || type === 'soft-diamond' || type === 'layered-diamond'
    ? { width: DEFAULT_DIAMOND_NOTE_WIDTH, height: DEFAULT_DIAMOND_NOTE_HEIGHT }
    : { width: DEFAULT_RECTANGLE_NOTE_WIDTH, height: DEFAULT_RECTANGLE_NOTE_HEIGHT }

  return {
    nodePosition: {
      position: { x: 0, y: 0 },
      type: "position",
    },
    nodeSize: {
      size: defaultSize,
      type: "size",
    },
    nodeZIndex: {
      number: 0,
      type: "number",
    },
    emoji: {
      type: "icon",
      icon: { type: "emoji", emoji: "" },
    },
    pinned: {
      type: "boolean",
      boolean: false,
    },
    listOrder: {
      type: "number",
      number: 0,
    },
    url: { type: "url" },
    imageUrl: { type: "image" },
    iconData: { type: "icon" },
    slideName: { type: "text" },
    slideNumber: { type: "number" },
    programmingLanguage: { type: "text", text: "python" },
  }
}


/**
 * Function to create a default note.
 * @param boardId - The ID of the board to which the note belongs.
 * @returns A new note with default properties.
 */
export const createDefaultNote = ({
  boardId,
  nodeType = 'rectangle'
}: {
  boardId: string,
  nodeType?: NodeType
}): Note => {
  const id = generateUuid()
  const roughSeed = uuidToNumber(id)

  return {
    id: id,
    type: "note",
    version: 1,
    createdAt: new Date().toISOString(),
    graphUid: boardId,
    style: { ...createDefaultStyle({ type: nodeType }) },
    minWidth: nodeType === 'sheet'
      ? DEFAULT_SHEET_WIDTH
      : nodeType === 'text'
      ? DEFAULT_TEXT_NOTE_WIDTH
      : nodeType === 'slide'
      ? DEFAULT_SLIDE_WIDTH
      : nodeType === 'folder'
      ? DEFAULT_FOLDER_WIDTH
      : nodeType === 'code-sandbox'
      ? DEFAULT_CODE_SANDBOX_WIDTH
      : nodeType === 'widget'
      ? DEFAULT_WIDGET_WIDTH
      : nodeType === 'mini-app'
      ? DEFAULT_MINI_APP_WIDTH
      : nodeType === 'ellipse' || nodeType === 'layered-circle'
      ? DEFAULT_ELLIPSE_NOTE_WIDTH
      : nodeType === 'diamond' || nodeType === 'soft-diamond' || nodeType === 'layered-diamond'
      ? DEFAULT_DIAMOND_NOTE_WIDTH
      : DEFAULT_RECTANGLE_NOTE_WIDTH,
    minHeight: nodeType === 'sheet'
      ? DEFAULT_SHEET_HEIGHT
      : nodeType === 'text'
      ? DEFAULT_TEXT_NOTE_HEIGHT
      : nodeType === 'slide'
      ? DEFAULT_SLIDE_HEIGHT
      : nodeType === 'folder'
      ? DEFAULT_FOLDER_HEIGHT
      : nodeType === 'code-sandbox'
      ? DEFAULT_CODE_SANDBOX_HEIGHT
      : nodeType === 'widget'
      ? DEFAULT_WIDGET_HEIGHT
      : nodeType === 'mini-app'
      ? DEFAULT_MINI_APP_HEIGHT
      : nodeType === 'ellipse' || nodeType === 'layered-circle'
      ? DEFAULT_ELLIPSE_NOTE_HEIGHT
      : nodeType === 'diamond' || nodeType === 'soft-diamond' || nodeType === 'layered-diamond'
      ? DEFAULT_DIAMOND_NOTE_HEIGHT
      : DEFAULT_RECTANGLE_NOTE_HEIGHT,
    properties: createDefaultNoteProperties({ type: nodeType }),
    roughSeed
  }
}
