import { useCallback, type ReactNode } from "react"
import type { NodeId } from "@canvas-harness/core"
import { useCanvasStore } from "@canvas-harness/react"
import { AppletNodeView } from "./applet"
import { CodeSandboxView } from "./code-sandbox"
import { DocumentView } from "./document"
import { FolderView } from "./folder"
import { MiniAppView } from "./mini-app"
import { SheetView } from "./sheet"
import { WidgetView } from "./widget"
import { NodeErrorBoundary } from "../shared-views"


/**
 * Type → React view component map. Mounted directly inside `<Canvas
 * renderCustomNodeView>`. Subscribing per-id happens inside each view
 * via `useNode(id)` so live updates propagate without a re-render at
 * this router level (see migration plan §4.1 "Subscription gotcha").
 */
const VIEW_REGISTRY: Readonly<Record<string, (props: { id: NodeId }) => ReactNode>> = {
  folder: FolderView,
  document: DocumentView,
  widget: WidgetView,
  "mini-app": MiniAppView,
  applet: AppletNodeView,
  "code-sandbox": CodeSandboxView,
  sheet: SheetView,
}


/**
 * Hook that returns the `renderCustomNodeView` function to feed into
 * `<Canvas>`. Dispatches by `node.type`; falls through to `null` for
 * unknown / built-in types (those don't need a React view).
 */
export const useRenderCustomNodeView = (): ((id: NodeId) => ReactNode) => {
  const store = useCanvasStore()
  return useCallback(
    (id: NodeId): ReactNode => {
      const node = store.getNode(id)
      if (!node) return null
      const View = VIEW_REGISTRY[node.type]
      if (!View) return null
      // Per-node error boundary: one bad render shouldn't blank the
      // whole canvas. Keyed on id so a node that switches type (rare)
      // resets its error state rather than carrying it across.
      return (
        <NodeErrorBoundary key={id} nodeId={id} nodeType={node.type}>
          <View id={id} />
        </NodeErrorBoundary>
      )
    },
    [store],
  )
}
