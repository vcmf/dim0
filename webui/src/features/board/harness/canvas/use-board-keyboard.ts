import { useEffect } from "react"
import type { CanvasStore } from "@canvas-harness/core"
import { isTypingTarget } from "@/lib/dom/is-typing-target"
import { useBoardAppStore } from "../store/board-app-store"


/**
 * Whether the event originated from a focused button-like control.
 * Space "clicks" a focused button by default, which collides with
 * hold-Space-to-pan: after clicking e.g. the sidebar trigger, every
 * Space press meant for panning would re-fire that button. We suppress
 * Space's default activation only for these targets.
 */
const isButtonTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  return target.closest("button, [role='button']") !== null
}


/** Single-key shortcuts that map straight to a tool-mode swap. */
const TOOL_SHORTCUTS: Record<string, string> = {
  p: "pan",
  h: "pan",
  v: "select",
  a: "arrow",
  t: "text",
  n: "sheet",
  r: "rect",
  o: "ellipse",
  d: "diamond",
  y: "code-sandbox",
}


/**
 * Focused-overlay selector: store-less Radix overlays (dropdown / context menu,
 * dialog, alert, and popper-based Select / combobox / listbox / popover). Escape
 * focused inside one should close the overlay, not reset the tool.
 * `[data-radix-popper-content-wrapper]` is the generic wrapper Radix renders
 * around all popper content.
 */
const OVERLAY_ROLE_SELECTOR =
  "[role='menu'],[role='dialog'],[role='alertdialog'],[role='listbox'],[data-radix-popper-content-wrapper]"


/** Board-app state the Escape decision reads (a testable subset of the store). */
export type EscapeAppState = {
  viewMode: string
  chromeDialog: unknown
  activeNodeSurface: unknown
  presentationMode: boolean
  chatSheetOpen: boolean
  tool: string
}


/** Outcome of an Escape press on the board. */
export type EscapeDecision = "no-op" | "defer-to-overlay" | "switch-to-select"


/**
 * Decide what a board Escape press does — pure, so the branch logic is unit-
 * tested without a DOM / React mount. The caller supplies the two DOM-derived
 * facts: `isTyping` (focus in input/textarea/contentEditable) and
 * `insideOverlayDom` (focus inside a store-less Radix overlay).
 *   - "switch-to-select" — consume: put an active create tool away. The caller
 *     also aborts the in-progress draft + stopPropagation so the selection is
 *     kept (canvas-harness couples abort + deselect into its own Escape).
 *   - "defer-to-overlay" — an overlay owns this Escape; leave the tool alone.
 *   - "no-op" — not Escape, modified, typing, off the board canvas, or the tool
 *     is already `select` (the library handles the 2nd-press deselect).
 */
export const decideBoardEscape = (
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  app: EscapeAppState,
  ctx: { isTyping: boolean; insideOverlayDom: boolean },
): EscapeDecision => {
  if (e.key !== "Escape") return "no-op"
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return "no-op"
  if (ctx.isTyping) return "no-op"
  // The tool only exists on the board canvas — no-op in files / list views.
  if (app.viewMode !== "board") return "no-op"
  // Store-tracked overlays own the Escape (their own handlers close them).
  // `chatSheetOpen` needs the explicit flag: the CopilotSheet is non-modal, so
  // focus stays on the canvas and the `insideOverlayDom` DOM check misses it.
  if (app.chromeDialog || app.activeNodeSurface || app.presentationMode || app.chatSheetOpen)
    return "defer-to-overlay"
  if (ctx.insideOverlayDom) return "defer-to-overlay"
  // Tool already `select` → fall through so the library handles the deselect.
  if (app.tool !== "select") return "switch-to-select"
  return "no-op"
}


/**
 * Global keyboard bindings for the canvas-harness board. Mirrors
 * prod's `use-board-shortcuts` keymap so muscle memory carries over:
 *
 *  - Cmd/Ctrl+Z / Shift+Z / Cmd+Y → undo / redo
 *  - P / H                        → pan tool
 *  - V                            → select tool
 *  - A                            → connector (arrow)
 *  - T                            → text tool
 *  - N                            → sheet tool
 *  - R / O / D                    → rect / ellipse / diamond tool
 *  - Y                            → code-sandbox tool
 *  - S                            → open Shapes menu
 *  - M                            → toggle Slides panel
 *  - G                            → open Icons search dialog
 *  - I                            → open Images search dialog
 *  - Escape                       → put the active create tool away (→ select),
 *                                   then deselect on a 2nd press (overlays win)
 *
 * Skipped when focus is in an input / textarea / contentEditable so
 * inline editing keeps the native shortcuts. canvas-harness already
 * wires Cmd+C/X/V/[]/]} internally — see Canvas.tsx.
 */
export const useBoardKeyboard = (store: CanvasStore): void => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target)) return

      // Reserve Space for hold-to-pan: stop a focused button from
      // re-firing its click on each Space press (e.g. the sidebar
      // trigger after it's been clicked). The lib's pan handler reads
      // its own keydown listener, so this doesn't affect panning.
      if (e.code === "Space" && isButtonTarget(e.target)) {
        e.preventDefault()
        return
      }

      const meta = e.metaKey || e.ctrlKey

      if (meta && (e.key === "z" || e.key === "Z")) {
        e.preventDefault()
        if (e.shiftKey) store.redo()
        else store.undo()
        return
      }
      if (meta && (e.key === "y" || e.key === "Y")) {
        e.preventDefault()
        store.redo()
        return
      }
      if (meta && (e.key === "k" || e.key === "K")) {
        e.preventDefault()
        const app = useBoardAppStore.getState()
        app.setChromeDialog(app.chromeDialog === "notes-search" ? null : "notes-search")
        return
      }

      if (meta || e.altKey || e.shiftKey) return

      const key = e.key.toLowerCase()
      const app = useBoardAppStore.getState()

      const tool = TOOL_SHORTCUTS[key]
      if (tool) {
        e.preventDefault()
        app.setTool(tool)
        return
      }

      if (key === "s") {
        e.preventDefault()
        app.setChromeDialog(app.chromeDialog === "shape-menu" ? null : "shape-menu")
        return
      }
      if (key === "g") {
        e.preventDefault()
        app.setChromeDialog("icon-search")
        return
      }
      if (key === "i") {
        e.preventDefault()
        app.setChromeDialog("image-search")
        return
      }
      if (key === "m") {
        e.preventDefault()
        app.setSlidesPanelOpen(!app.slidesPanelOpen)
      }
    }

    // Escape implements the tldraw/excalidraw two-step cancel (see
    // `decideBoardEscape`). Registered in the CAPTURE phase on purpose: it reads
    // the store-tracked overlay flags, which must be read BEFORE the same Escape
    // is consumed by a handler that clears them — Radix dialogs/menus close on a
    // document-capture handler, and the presentation / node-surface handlers are
    // window bubble listeners; a bubble-phase read would race all of them.
    const onEscape = (e: KeyboardEvent): void => {
      const target = e.target
      const insideOverlayDom =
        target instanceof HTMLElement && target.closest(OVERLAY_ROLE_SELECTOR) !== null
      const app = useBoardAppStore.getState()
      const decision = decideBoardEscape(e, app, {
        isTyping: isTypingTarget(target),
        insideOverlayDom,
      })
      if (decision !== "switch-to-select") return
      // Consume: put the create tool away. canvas-harness couples abort + deselect
      // into its own (bubble-phase) Escape, so we abort the draft ourselves and
      // stopPropagation to suppress the lib's deselect — keeping the selection.
      app.setTool("select")
      store.resetInteractionState()
      e.stopPropagation()
    }

    window.addEventListener("keydown", onKey)
    window.addEventListener("keydown", onEscape, true)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("keydown", onEscape, true)
    }
  }, [store])
}
