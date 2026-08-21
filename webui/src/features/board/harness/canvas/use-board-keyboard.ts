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
 *  - Escape                       → return to select tool (unless an overlay owns it)
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

    // Escape returns the canvas to the `select` tool (matches tldraw/excalidraw),
    // so a create tool (rect / note / arrow / …) isn't left stuck after one shape.
    // Registered in the CAPTURE phase on purpose: it must read overlay state
    // BEFORE the same Escape is consumed by a handler that clears it — Radix
    // dialogs/menus close on a document-level capture handler (clearing
    // `chromeDialog`), and the presentation / node-surface handlers are window
    // bubble listeners that clear their own flags. Reading in bubble phase would
    // race all of them. When an overlay owns the Escape we defer to its close and
    // leave the tool untouched; canvas-harness's own Escape handler still clears
    // the selection + aborts an in-progress drag / marquee / draft edge.
    //
    // "Is an overlay open?" is a hand-maintained enumeration (store flags below +
    // the focused-overlay DOM guard). A shared open-overlay signal would be less
    // fragile — new overlays must remember to opt in here — but that's a broader
    // refactor; this list covers every dismissable the board mounts today.
    const onEscape = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      if (isTypingTarget(e.target)) return
      const app = useBoardAppStore.getState()
      // The tool only exists on the board canvas — no-op in files / list views.
      if (app.viewMode !== "board") return
      // Overlays whose open-state lives in the store own the Escape; their own
      // handlers close them, so don't also steal the tool switch. `chatSheetOpen`
      // needs the explicit flag because the CopilotSheet is non-modal — focus
      // stays on the canvas, so the focused-overlay DOM guard below misses it.
      if (
        app.chromeDialog ||
        app.activeNodeSurface ||
        app.presentationMode ||
        app.chatSheetOpen
      )
        return
      // Store-less Radix overlays (view menu, context menu, delete-confirm alert)
      // keep open-state locally — skip when the Escape is focused inside one.
      const target = e.target
      if (
        target instanceof HTMLElement &&
        target.closest("[role='menu'],[role='dialog'],[role='alertdialog']")
      )
        return
      if (app.tool !== "select") app.setTool("select")
    }

    window.addEventListener("keydown", onKey)
    window.addEventListener("keydown", onEscape, true)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("keydown", onEscape, true)
    }
  }, [store])
}
