import { codeSandboxDef } from "./code-sandbox"
import { documentDef } from "./document"
import { folderDef } from "./folder"
import { miniAppDef } from "./mini-app"
import { inkDef } from "./ink"
import { sheetDef } from "./sheet"
import { widgetDef } from "./widget"
import type { BoardNodeTypeDef } from "../store/create-board-store"


/**
 * Array of all custom node defs registered with the board's
 * canvas-harness store. Pass directly to `createBoardStore({ nodeTypes })`.
 */
export const boardNodeTypes: ReadonlyArray<BoardNodeTypeDef> = [
  folderDef,
  documentDef,
  widgetDef,
  miniAppDef,
  codeSandboxDef,
  sheetDef,
  inkDef,
]


export { codeSandboxDef, CodeSandboxView } from "./code-sandbox"
export { documentDef, DocumentView } from "./document"
export { folderDef, FolderView } from "./folder"
export { miniAppDef, MiniAppView } from "./mini-app"
export { inkDef } from "./ink"
export { sheetDef, SheetView } from "./sheet"
export { widgetDef, WidgetView } from "./widget"
export { useRenderCustomNodeView } from "./render-view"
