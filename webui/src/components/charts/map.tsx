// React component for the <map> custom element — Canvas 2D on the shared harness.
//
// Lazily loads the world atlas (map-geo.ts), runs the pure projection helpers
// (map-projection.ts), then paints a choropleth + optional marker overlay to a
// `<canvas>` via drawMap on the shared canvas surface (DPR-crisp, theme-reactive).
// Canvas (not SVG) so the whole applet snapshots cleanly — SVG re-rasterizes inside
// snapDOM's foreignObject and hits WebKit font/positioning bugs (design §2). While the
// geometry chunk is in flight it shows a light placeholder; a load failure shows an
// inline message rather than throwing.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties } from "react"

import { useCanvasSurface } from "@/lib/canvas/use-canvas-surface"
import { useCaptureReady } from "@/lib/canvas/use-capture-ready"

import { drawMap, VIEW_H, VIEW_W } from "./map-draw"
import type { MapView } from "./map-draw"
import { loadWorld } from "./map-geo"
import type { WorldGeo } from "./map-geo"
import { buildFillResolver, buildProjection, projectMarkers } from "./map-projection"
import type { MapProps } from "./map-types"


/**
 * A DEFINITE CSS height for the wrapper, or `undefined` to size from the viewBox aspect.
 * Excludes non-positive numbers and indefinite strings (`""`, `"auto"`): a `height:100%`
 * canvas inside an indefinite box collapses to 0 and never draws. (Mirrors graph.tsx —
 * a follow-up can share it once both canvas ports land.)
 */
function definiteHeight(height: number | string | undefined): string | undefined {
  if (typeof height === "number") return height > 0 ? `${height}px` : undefined
  if (typeof height === "string") {
    const trimmed = height.trim()
    return trimmed === "" || trimmed === "auto" ? undefined : trimmed
  }
  return undefined
}


export function MapElement(props: MapProps) {
  const { height = 320 } = props
  const [geo, setGeo] = useState<WorldGeo | null>(null)
  const [failed, setFailed] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [rendered, setRendered] = useState(false)
  const renderedRef = useRef(false)

  useEffect(() => {
    let active = true
    loadWorld().then(
      (w) => active && setGeo(w),
      () => active && setFailed(true),
    )
    return () => {
      active = false
    }
  }, [])

  // Project the atlas + join the agent's data once per (geo, data, markers, color).
  // Regions carry their resolved CSS fill; markers are pre-projected to viewBox coords.
  //
  // Key on the RAW prop identities (props.data/markers/color), NOT destructured defaults:
  // `const { data = [] } = props` mints a fresh `[]` every render when the prop is
  // undefined (a marker-less or data-less map — both common), which would make `view` a
  // new object on every self-re-render (setGeo/setRendered) and spin useCanvasSurface +
  // the reset effect into a runaway rAF loop. The raw props are stable across the
  // component's own re-renders, so this recomputes only when the atlas or a real input
  // changes. Defaults are applied inside.
  const view = useMemo<MapView | null>(() => {
    if (!geo) return null
    const projection = buildProjection(geo.features, VIEW_W, VIEW_H)
    const fillFor = buildFillResolver(props.data ?? [], geo.resolve, props.color ?? "chart-1")
    return {
      projection,
      regions: geo.features.map((f) => ({ feature: f, fill: fillFor(String(f.id ?? "")) })),
      markers: projectMarkers(props.markers ?? [], projection),
    }
  }, [geo, props.data, props.markers, props.color])

  // A new view is not yet painted — reset capture-readiness so a re-projection can't
  // leave data-capture-ready stuck "true" over a cleared canvas. The draw re-flips it.
  useEffect(() => {
    renderedRef.current = false
    setRendered(false)
  }, [view])

  // Paint the map; flip `rendered` on the first draw that actually painted so the
  // snapshotter (data-capture-ready) never treats a blank canvas as finished content.
  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, size: { width: number; height: number }) => {
      if (!view) return
      const painted = drawMap(ctx, view, size)
      if (painted && !renderedRef.current) {
        renderedRef.current = true
        setRendered(true)
      }
    },
    [view],
  )
  useCanvasSurface(canvasRef, draw, [view])
  useCaptureReady(wrapRef, rendered)

  // The canvas needs a measurable CSS box: a definite author height, else the fixed
  // ~2:1 viewBox aspect.
  const explicitHeight = definiteHeight(height)
  const wrapStyle: CSSProperties = {
    width: "100%",
    ...(explicitHeight != null ? { height: explicitHeight } : { aspectRatio: `${VIEW_W} / ${VIEW_H}` }),
  }

  if (failed) {
    return (
      <div className="flex w-full items-center justify-center p-4 text-sm text-muted-foreground" style={{ height }}>
        Map failed to load.
      </div>
    )
  }

  if (!view) {
    return (
      <div className="flex w-full items-center justify-center p-4 text-sm text-muted-foreground" style={{ height }}>
        Loading map…
      </div>
    )
  }

  return (
    <div ref={wrapRef} style={wrapStyle}>
      <canvas ref={canvasRef} role="img" style={{ display: "block", width: "100%", height: "100%" }} />
    </div>
  )
}
