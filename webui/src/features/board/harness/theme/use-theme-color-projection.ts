import { useEffect, useRef } from "react"
import {
  type CanvasStore,
  type Edge,
  type EdgeId,
  type Node,
  type NodeId,
  type Op,
} from "@canvas-harness/core"
import { useTheme } from "@/components/theme-provider"
import { makeBatch } from "@/features/board/harness/make-batch"
import type { LinkEdgeData } from "../convert/link-to-edge"
import type { NoteNodeData } from "../convert/note-to-node"
import {
  adaptEdgeColors,
  adaptNodeColors,
  applyColorsToEdgeStyle,
  applyColorsToStyle,
  type StoredColors,
  type StoredEdgeColors,
} from "./color-adapter"


/**
 * Watches `resolvedTheme` and re-projects every node + edge's display
 * colors when the mode flips. The stored colors live on
 * `node.data._storedColors` / `edge.data._storedColors` — those never
 * change; we just rewrite `node.style.{bg,stroke,text}` for the new
 * mode.
 *
 * Emitted as a single `remote`-origin batch:
 *   - `remote` ⇒ the debounced save loop skips it (no server write)
 *   - one batch ⇒ one renderer redraw
 *
 * Skipped on the very first run for a given store (a no-op mode change
 * shouldn't churn). Skipped while hydration is in flight — the
 * converter has already projected freshly-loaded nodes for the right
 * mode, no second pass needed.
 */
export const useThemeColorProjection = (
  store: CanvasStore,
  ready: boolean,
): void => {
  const { resolvedTheme } = useTheme()
  const prevModeRef = useRef<typeof resolvedTheme | null>(null)

  useEffect(() => {
    if (!ready) {
      prevModeRef.current = resolvedTheme
      return
    }
    const prev = prevModeRef.current
    prevModeRef.current = resolvedTheme
    if (prev === null || prev === resolvedTheme) return

    const ops: Op[] = []

    for (const node of store.getAllNodes()) {
      const data = node.data as Partial<NoteNodeData> | undefined
      // An ink stroke without canonical `_storedColors` (a pre-fix stroke, or one
      // synced live from an older client) has only its display color to fall back
      // on — re-projecting that would corrupt it. Skip it; ink WITH `_storedColors`
      // projects normally like any node.
      if (node.type === "ink" && !data?._storedColors) continue
      const stored: StoredColors = data?._storedColors ?? {
        backgroundColor: node.style?.backgroundColor,
        strokeColor: node.style?.strokeColor,
        textColor: node.style?.textColor,
      }
      const adapted =
        resolvedTheme === "dark"
          ? adaptNodeColors(stored, "dark")
          : stored
      const nextStyle = applyColorsToStyle(node.style ?? {}, adapted)

      const nextData: NoteNodeData = {
        ...(data as NoteNodeData),
        _storedColors: stored,
      }

      ops.push({
        type: "node.update",
        id: node.id as NodeId,
        patch: { style: nextStyle, data: nextData } as Partial<Node>,
        prev: node,
      })
    }

    for (const edge of store.getAllEdges()) {
      const data = edge.data as Partial<LinkEdgeData> | undefined
      const stored: StoredEdgeColors = data?._storedColors ?? {
        strokeColor: edge.style?.strokeColor,
        textColor: edge.style?.textColor,
      }
      const adapted =
        resolvedTheme === "dark"
          ? adaptEdgeColors(stored, "dark")
          : stored
      const nextStyle = applyColorsToEdgeStyle(edge.style ?? {}, adapted)

      const nextData: LinkEdgeData = {
        ...(data as LinkEdgeData),
        _storedColors: stored,
      }

      ops.push({
        type: "edge.update",
        id: edge.id as EdgeId,
        patch: { style: nextStyle, data: nextData } as Partial<Edge>,
        prev: edge,
      })
    }

    if (ops.length === 0) return

    store.applyBatch(makeBatch(store, "remote", ops))
  }, [store, ready, resolvedTheme])
}
