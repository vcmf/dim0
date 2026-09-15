import { memo, useEffect } from "react"
import { useCanvasStore } from "@canvas-harness/react"
import { useBoardAppStore } from "../../store/board-app-store"
import { AppletPanel } from "./applet-panel"
import { CodeSandboxPanel } from "./code-sandbox-panel"
import { MiniAppPanel } from "./mini-app-panel"
import { SheetPanel } from "./sheet-panel"
import { WidgetPanel } from "./widget-panel"


/**
 * Mounts the currently active rich-node surface once at board level —
 * port of dim0's NodeSurfaceHost. Reads `activeNodeSurface` from
 * board-app-store and renders the matching panel; closing dispatches
 * back to the store. Click on the backdrop closes.
 */
export const NodeSurfaceHost = memo(function NodeSurfaceHost() {
  const activeNodeSurface = useBoardAppStore((s) => s.activeNodeSurface)
  const closeNodeSurface = useBoardAppStore((s) => s.closeNodeSurface)
  const store = useCanvasStore()

  // Auto-close canvas-bound surfaces if their underlying node was removed
  // (e.g. via undo while the surface is open). Sheets may be sub-pages
  // that don't live on the canvas — those gate their own existence.
  useEffect(() => {
    if (!activeNodeSurface) return
    if (activeNodeSurface.kind === "sheet") return
    const node = store.getNode(activeNodeSurface.nodeId as never)
    if (!node) closeNodeSurface()
  }, [activeNodeSurface, store, closeNodeSurface])

  // Esc closes the surface (mirrors prod's affordance).
  useEffect(() => {
    if (!activeNodeSurface) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault()
        closeNodeSurface()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [activeNodeSurface, closeNodeSurface])

  if (!activeNodeSurface) return null

  const backdrop = (
    <div
      className="absolute inset-0 z-[54] bg-background/50 backdrop-blur-sm"
      onClick={closeNodeSurface}
      aria-hidden="true"
    />
  )

  return (
    <>
      {backdrop}
      {activeNodeSurface.kind === "sheet" ? (
        <SheetPanel
          nodeId={activeNodeSurface.nodeId}
          onClose={closeNodeSurface}
        />
      ) : activeNodeSurface.kind === "code-sandbox" ? (
        <CodeSandboxPanel
          nodeId={activeNodeSurface.nodeId}
          onClose={closeNodeSurface}
        />
      ) : activeNodeSurface.kind === "mini-app" ? (
        <MiniAppPanel
          nodeId={activeNodeSurface.nodeId}
          onClose={closeNodeSurface}
        />
      ) : activeNodeSurface.kind === "applet" ? (
        <AppletPanel
          nodeId={activeNodeSurface.nodeId}
          onClose={closeNodeSurface}
        />
      ) : (
        <WidgetPanel
          nodeId={activeNodeSurface.nodeId}
          onClose={closeNodeSurface}
        />
      )}
    </>
  )
})
