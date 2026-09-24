import { AppletIcon, CodeFileIcon, FolderIcon, NotepadIcon, type AppIconComponent } from "@/components/icons"
import type { BoardContentKind } from "../api/list-board-contents"


/**
 * Default icon per sidebar-tree kind (a user-picked icon overrides it). Shared by
 * the sidebar tree and the breadcrumb; typed exhaustively so a new
 * `BOARD_CONTENT_KINDS` entry can't ship without one.
 */
export const BOARD_CONTENT_KIND_ICONS: Record<BoardContentKind, AppIconComponent> = {
  folder: FolderIcon,
  sheet: NotepadIcon,
  "code-sandbox": CodeFileIcon,
  applet: AppletIcon,
}
