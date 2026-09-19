// React component for the <graph> custom element — Canvas 2D on the shared harness.
//
// Thin layer: runs the pure layout (graph-layout.ts), then paints it to a `<canvas>`
// via drawGraph on the shared canvas surface (DPR-crisp, theme-reactive). Canvas (not
// SVG) so the whole applet snapshots cleanly — SVG re-rasterizes inside snapDOM's
// foreignObject and hits WebKit font/positioning bugs (design §2). All shape/color/
// position decisions live in the layout or come from the agent; this file just wires
// layout → canvas and reports capture-readiness.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties } from "react"

import { useCanvasSurface } from "@/lib/canvas/use-canvas-surface"
import { useCaptureReady } from "@/lib/canvas/use-capture-ready"

import { definiteHeight, drawGraph, parseViewBox } from "./graph-draw"
import { layoutGraph } from "./graph-layout"
import type { GraphProps } from "./graph-types"


// Fallback CSS height when neither an explicit height nor a usable viewBox aspect is
// available (a degenerate graph) — the canvas still needs a measurable box.
const FALLBACK_HEIGHT = 300


export function GraphElement(props: GraphProps) {
  const graph = useMemo(() => layoutGraph(props), [props])
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [rendered, setRendered] = useState(false)
  const renderedRef = useRef(false)

  // A new graph is not yet painted — reset capture-readiness so a valid→degenerate
  // transition (canvas cleared, new draw no-ops) can't leave data-capture-ready stuck
  // "true" over a blank canvas. The draw below re-flips it once a paint actually lands.
  useEffect(() => {
    renderedRef.current = false
    setRendered(false)
  }, [graph])

  // Paint the graph; flip `rendered` on the first draw that actually painted (drawGraph
  // returns false on a degenerate/zero-size no-op) so the snapshotter (data-capture-
  // ready) never treats a blank canvas as finished content.
  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, size: { width: number; height: number }) => {
      const painted = drawGraph(ctx, graph, size)
      if (painted && !renderedRef.current) {
        renderedRef.current = true
        setRendered(true)
      }
    },
    [graph],
  )
  useCanvasSurface(canvasRef, draw, [graph])
  useCaptureReady(wrapRef, rendered)

  // The canvas needs a measurable CSS box. Prefer a definite author height; else derive
  // the box from the viewBox aspect (replicating SVG's height:auto); else fall back.
  const vb = useMemo(() => parseViewBox(graph.viewBox), [graph])
  const explicitHeight = definiteHeight(props.height)
  const wrapStyle: CSSProperties = {
    width: "100%",
    ...(explicitHeight != null
      ? { height: explicitHeight }
      : vb
        ? { aspectRatio: `${vb.width} / ${vb.height}` }
        : { height: FALLBACK_HEIGHT }),
  }

  return (
    <div ref={wrapRef} style={wrapStyle}>
      <canvas ref={canvasRef} role="img" style={{ display: "block", width: "100%", height: "100%" }} />
    </div>
  )
}
