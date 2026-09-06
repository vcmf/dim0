import { defineNode } from "@canvas-harness/core"
import { drawInkNode, hitTestInkLocal } from "../../ink/ink-geometry"


/** Canvas-only freehand node: fast paint path with pressure-aware hit testing. */
export const inkDef = defineNode({
  type: "ink",
  renderCanvas: drawInkNode,
  drawPlaceholder: drawInkNode,
  hitTest: (node, point) => hitTestInkLocal(node, point),
  lod: { minZoomForPlaceholder: 0.02 },
})
