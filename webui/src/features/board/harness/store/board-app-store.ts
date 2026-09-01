import { create } from "zustand"
import {
  type BoardBackgroundTexture,
  clearBoardBackground as persistClearBoardBackground,
  clearBoardBackgroundTexture as persistClearBoardBackgroundTexture,
  getBoardBackground,
  getBoardBackgroundTexture,
  setBoardBackground as persistSetBoardBackground,
  setBoardBackgroundTexture as persistSetBoardBackgroundTexture,
} from "@/features/board/utils/board-background"


export type NodeSurfaceKind = "sheet" | "code-sandbox" | "widget" | "mini-app"


/**
 * Tracks which floating chrome dialog/menu is open. Lives on the app
 * store so the keyboard handler (which doesn't sit inside the toolbar)
 * can toggle them via hotkeys (S → shapes menu, G → icons, I → images).
 */
export type ChromeDialog =
  | "shape-menu"
  | "icon-search"
  | "image-search"
  | "document-upload"
  | "notes-search"


/**
 * Router callbacks injected by a host hook so the store can push URL
 * changes when surfaces open/close without importing the router (would
 * create a cycle through the screen components). Mirrors prod's
 * `setBoardNavigate` pattern in graph-store.ts.
 */
// The host hook (synced vs local) owns URL construction — it knows the route
// family (`/boards/$id/*` vs `/local/$boardId/*`) and param names — so the store
// stays route-agnostic and only forwards the surface kind + ids.
type SurfaceNavigateOpen = (kind: NodeSurfaceKind, boardId: string, nodeId: string) => void
type SurfaceNavigateClose = (boardId: string) => void
let _navigateOpen: SurfaceNavigateOpen | null = null
let _navigateClose: SurfaceNavigateClose | null = null
export const setNodeSurfaceNavigator = (
  open: SurfaceNavigateOpen,
  close: SurfaceNavigateClose,
): void => {
  _navigateOpen = open
  _navigateClose = close
}


export type OpenNodeSurface = {
  nodeId: string
  kind: NodeSurfaceKind
}


/**
 * App-level state for the board feature. Owns everything the
 * canvas-harness store doesn't — page-level UI toggles, surface
 * panels, folder navigation, board metadata, background theming.
 *
 * Scene state (nodes / edges / camera / selection / interaction /
 * history) lives in the canvas-harness store; do not mirror it here.
 */
export type BoardAppState = {
  // Scope — which board the canvas is currently showing.
  boardId: string | null
  rootId: string | null

  // Board-level metadata (display only — not in scene history).
  boardLabel: string
  boardVisibility: "private" | "public" | null
  canEdit: boolean
  /**
   * The signed-in user's role on the loaded board. `null` means the
   * user has no explicit row in `graph_user` (e.g. public-visibility
   * browse). The Share button is gated on `boardRole === "owner"`.
   */
  boardRole: "owner" | "member" | "viewer" | null
  isLoading: boolean

  // Active canvas tool. `'select'` is default; the top-bar swaps it and the
  // keyboard hook responds to V / H / F shortcuts. canvas-harness accepts any
  // string — built-ins use lib-defined names, customs can use their own.
  tool: string

  /**
   * Which top-level surface is mounted. `"board"` is the canvas-harness
   * Canvas; `"files"` and `"list"` are alternate read-mostly views of
   * the document-like nodes on the current scope.
   */
  viewMode: "board" | "files" | "list"

  // UI toggles.
  viewSlides: boolean
  presentationMode: boolean
  /** Right-side slides Sheet visibility. */
  slidesPanelOpen: boolean
  /** Full chat surface (CopilotSheet) visibility. */
  chatSheetOpen: boolean
  /**
   * Frame id currently focused by the slides panel / present mode.
   * Mirrors prod's `activeSlideId`. `null` when no slide is active.
   */
  activeSlideId: string | null

  // Folder navigation (per-board depth, reset on scope change).
  currentFolderDepth: number
  maxFolderDepth: number

  // Background (persisted per-board to localStorage).
  boardBackground: string | null
  boardBackgroundTexture: BoardBackgroundTexture | null

  // Modal surface for sheet / code-sandbox / widget nodes.
  activeNodeSurface: OpenNodeSurface | null
  /**
   * Imperative rename for the currently open surface, registered by the active
   * panel (which owns the note's store / off-scene / REST write path). The
   * unified breadcrumb edits the open leaf through this so it doesn't spin up a
   * second, competing store for the same node. `null` when no surface is open.
   */
  activeSurfaceRename: ((title: string) => void) | null
  /**
   * Live title of the open surface, registered by the active panel. Lets the
   * breadcrumb show the leaf title for a surface that isn't in the on-device list
   * yet (a synced sub-page loaded via REST). `null` when no surface is open.
   */
  activeSurfaceLabel: string | null

  // Which floating chrome dialog/menu is open (one at a time).
  chromeDialog: ChromeDialog | null
}


export type BoardAppActions = {
  /** Set boardId + rootId and reset per-board state (depth, surface, background). */
  setBoardScope: (scope: { boardId?: string | null; rootId?: string | null }) => void

  setBoardLabel: (label: string) => void
  setBoardVisibility: (visibility: BoardAppState["boardVisibility"]) => void
  setCanEdit: (canEdit: boolean) => void
  setBoardRole: (role: BoardAppState["boardRole"]) => void
  setIsLoading: (loading: boolean) => void

  setTool: (tool: string) => void

  setViewMode: (mode: BoardAppState["viewMode"]) => void
  setViewSlides: (enabled: boolean) => void
  setPresentationMode: (enabled: boolean) => void
  setSlidesPanelOpen: (open: boolean) => void
  setActiveSlideId: (id: string | null) => void
  setChatSheetOpen: (open: boolean) => void

  setCurrentFolderDepth: (depth: number) => void
  setMaxFolderDepth: (depth: number) => void

  setBoardBackground: (color: string | null) => void
  setBoardBackgroundTexture: (texture: BoardBackgroundTexture | null) => void

  openNodeSurface: (nodeId: string, kind: NodeSurfaceKind) => void
  closeNodeSurface: () => void
  setActiveSurfaceRename: (rename: ((title: string) => void) | null) => void
  setActiveSurfaceLabel: (label: string | null) => void

  setChromeDialog: (dialog: ChromeDialog | null) => void
}


const initialState: BoardAppState = {
  boardId: null,
  rootId: null,
  boardLabel: "",
  boardVisibility: null,
  canEdit: true,
  boardRole: null,
  isLoading: false,
  tool: "select",
  viewMode: "board",
  viewSlides: true,
  presentationMode: false,
  slidesPanelOpen: false,
  activeSlideId: null,
  chatSheetOpen: false,
  currentFolderDepth: -1,
  maxFolderDepth: 0,
  boardBackground: null,
  boardBackgroundTexture: null,
  activeNodeSurface: null,
  activeSurfaceRename: null,
  activeSurfaceLabel: null,
  chromeDialog: null,
}


export const useBoardAppStore = create<BoardAppState & BoardAppActions>((set, get) => ({
  ...initialState,

  setBoardScope: ({ boardId = null, rootId = null }) =>
    set({
      boardId,
      rootId,
      boardLabel: "",
      boardVisibility: null,
      canEdit: true,
      boardRole: null,
      isLoading: false,
      tool: "select",
      viewMode: "board",
      currentFolderDepth: -1,
      maxFolderDepth: 0,
      presentationMode: false,
      slidesPanelOpen: false,
      activeSlideId: null,
      chatSheetOpen: false,
      activeNodeSurface: null,
      activeSurfaceRename: null,
      activeSurfaceLabel: null,
      chromeDialog: null,
      boardBackground: boardId ? getBoardBackground(boardId) : null,
      boardBackgroundTexture: boardId ? getBoardBackgroundTexture(boardId) : null,
    }),

  setBoardLabel: (label) => set({ boardLabel: label }),
  setBoardVisibility: (visibility) => set({ boardVisibility: visibility }),
  setCanEdit: (canEdit) => set({ canEdit }),
  setBoardRole: (role) => set({ boardRole: role }),
  setIsLoading: (loading) => set({ isLoading: loading }),

  setTool: (tool) => set({ tool }),

  setViewMode: (mode) => set({ viewMode: mode }),
  setViewSlides: (enabled) => set({ viewSlides: enabled }),
  setPresentationMode: (enabled) => set({ presentationMode: enabled }),
  setSlidesPanelOpen: (open) => set({ slidesPanelOpen: open }),
  setActiveSlideId: (id) => set({ activeSlideId: id }),
  setChatSheetOpen: (open) => set({ chatSheetOpen: open }),

  setCurrentFolderDepth: (depth) => set({ currentFolderDepth: Math.max(-1, Math.floor(depth)) }),
  setMaxFolderDepth: (depth) => set({ maxFolderDepth: Math.max(0, Math.floor(depth)) }),

  setBoardBackground: (color) =>
    set((state) => {
      const id = state.boardId ?? undefined
      if (color === null) persistClearBoardBackground(id)
      else persistSetBoardBackground(id, color)
      return { boardBackground: color }
    }),

  setBoardBackgroundTexture: (texture) =>
    set((state) => {
      const id = state.boardId ?? undefined
      if (texture === null) persistClearBoardBackgroundTexture(id)
      else persistSetBoardBackgroundTexture(id, texture)
      return { boardBackgroundTexture: texture }
    }),

  openNodeSurface: (nodeId, kind) => {
    // Drop the outgoing surface's rename hook; the incoming panel registers its
    // own on mount. Until then the breadcrumb safely falls back to an off-scene
    // rename for the new leaf.
    set({
      activeNodeSurface: { nodeId, kind },
      activeSurfaceRename: null,
      activeSurfaceLabel: null,
    })
    const boardId = get().boardId
    if (!boardId || !_navigateOpen) return
    _navigateOpen(kind, boardId, nodeId)
  },
  closeNodeSurface: () => {
    set({ activeNodeSurface: null, activeSurfaceRename: null, activeSurfaceLabel: null })
    const boardId = get().boardId
    if (!boardId || !_navigateClose) return
    _navigateClose(boardId)
  },
  setActiveSurfaceRename: (rename) => set({ activeSurfaceRename: rename }),
  setActiveSurfaceLabel: (label) => set({ activeSurfaceLabel: label }),

  setChromeDialog: (dialog) => set({ chromeDialog: dialog }),
}))
