import type { NodeType as CanvasNodeType } from "@canvas-harness/core"
import type { NodeType as Dim0NodeType } from "@/features/board/types/style"


/**
 * Four Dim0 node types use different names than the canvas-harness
 * built-ins (`rectangle → rect`, `layered-rectangle → layered-rect`,
 * `layered-circle → layered-ellipse`, `slide → frame`). The rest are
 * either 1:1 with built-ins or custom defs that pass through unchanged.
 *
 * Keep the map in one place so the converters never have to remember
 * the rename — every other helper goes through these two functions.
 */


const DIM0_TO_CANVAS: Record<Dim0NodeType, CanvasNodeType> = {
  rectangle: "rect",
  ellipse: "ellipse",
  diamond: "diamond",
  "soft-diamond": "soft-diamond",
  tag: "tag",
  "layered-circle": "layered-ellipse",
  "layered-rectangle": "layered-rect",
  "layered-diamond": "layered-diamond",
  "thought-cloud": "thought-cloud",
  capsule: "capsule",
  text: "text",
  image: "image",
  icon: "icon",
  slide: "frame",
  // Custom defs registered in harness/node-types/* — pass through unchanged.
  folder: "folder",
  sheet: "sheet",
  "code-sandbox": "code-sandbox",
  widget: "widget",
  "mini-app": "mini-app",
  ink: "ink",
}


const CANVAS_TO_DIM0: Record<string, Dim0NodeType> = Object.fromEntries(
  Object.entries(DIM0_TO_CANVAS).map(([dim0, canvas]) => [canvas as string, dim0 as Dim0NodeType]),
)


/** Translate a Dim0 NodeType to the canvas-harness type string. */
export const dim0TypeToCanvas = (t: Dim0NodeType): CanvasNodeType => DIM0_TO_CANVAS[t]


/**
 * Translate a canvas-harness node type back to its Dim0 NodeType.
 * Falls through unrecognized values (custom types not in the table)
 * unchanged so unknown registrations survive a round-trip.
 */
export const canvasTypeToDim0 = (t: string): Dim0NodeType =>
  (CANVAS_TO_DIM0[t] ?? t) as Dim0NodeType
