import { asNodeId, worldToNodeLocal } from "@canvas-harness/core"
import type { Node, Vec2 } from "@canvas-harness/core"
import { getStroke } from "perfect-freehand"
import type { InkProperty } from "@/features/newsfeed/types/properties"
import type { NoteNodeData } from "../convert/note-to-node"


export type InkSample = {
  x: number
  y: number
  pressure: number
}


/** Fill sparse browser samples so fast Pencil motion stays visually continuous. */
export const interpolateInkSamples = (
  from: InkSample,
  to: InkSample,
  maxSpacing: number,
): InkSample[] => {
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  const steps = Math.min(64, Math.max(1, Math.ceil(distance / Math.max(0.1, maxSpacing))))
  const result: InkSample[] = []
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps
    result.push({
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      pressure: from.pressure + (to.pressure - from.pressure) * t,
    })
  }
  return result
}


type InkProperties = Partial<NoteNodeData["properties"]> & {
  ink_data?: InkProperty
}


const MIN_NODE_SIZE = 1


/** Trace a closed outline with midpoint quadratic curves instead of visible segments. */
export const traceSmoothInkOutline = (
  ctx: CanvasRenderingContext2D,
  points: ReadonlyArray<readonly [number, number]>,
): void => {
  if (points.length === 0) return
  if (points.length < 3) {
    ctx.moveTo(points[0][0], points[0][1])
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i][0], points[i][1])
    return
  }

  const firstMidpoint: [number, number] = [
    (points[0][0] + points[1][0]) / 2,
    (points[0][1] + points[1][1]) / 2,
  ]
  ctx.moveTo(firstMidpoint[0], firstMidpoint[1])

  for (let i = 1; i <= points.length; i += 1) {
    const control = points[i % points.length]
    const next = points[(i + 1) % points.length]
    ctx.quadraticCurveTo(
      control[0],
      control[1],
      (control[0] + next[0]) / 2,
      (control[1] + next[1]) / 2,
    )
  }
  ctx.closePath()
}


/** Produce a pressure-aware polygon for one freehand stroke. */
export const buildInkOutline = (
  samples: ReadonlyArray<InkSample>,
  size: number,
): Array<[number, number]> => {
  if (samples.length === 0) return []
  return getStroke(
    samples.map((point) => [point.x, point.y, point.pressure]),
    {
      size,
      thinning: 0.68,
      smoothing: 0.58,
      streamline: 0.42,
      simulatePressure: false,
      last: true,
    },
  ).map(([x, y]) => [x, y])
}


/** Read ink data from both REST camelCase and relay snake_case payloads. */
export const readInkProperty = (node: Node): InkProperty | null => {
  const data = (node.data ?? {}) as Partial<NoteNodeData>
  const properties = (data.properties ?? {}) as InkProperties
  const raw = properties.inkData ?? properties.ink_data
  if (!raw || raw.type !== "ink" || !Array.isArray(raw.outline)) return null

  const relayRaw = raw as InkProperty & {
    intrinsic_width?: number
    intrinsic_height?: number
  }
  const intrinsicWidth = relayRaw.intrinsicWidth ?? relayRaw.intrinsic_width
  const intrinsicHeight = relayRaw.intrinsicHeight ?? relayRaw.intrinsic_height
  if (!Number.isFinite(intrinsicWidth) || !Number.isFinite(intrinsicHeight)) return null

  return {
    ...raw,
    intrinsicWidth,
    intrinsicHeight,
  }
}


/** Convert a completed world-space trace into one persisted canvas node. */
export const createInkNode = ({
  id,
  boardId,
  parentId,
  color,
  displayColor = color,
  size,
  samples,
}: {
  id: string
  boardId: string
  parentId: string | null
  color: string
  displayColor?: string
  size: number
  samples: ReadonlyArray<InkSample>
}): (Omit<Node, "z"> & { z?: number }) | null => {
  const outline = buildInkOutline(samples, size)
  if (outline.length === 0) return null

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const [x, y] of outline) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }

  const intrinsicWidth = Math.max(MIN_NODE_SIZE, maxX - minX)
  const intrinsicHeight = Math.max(MIN_NODE_SIZE, maxY - minY)
  const inkData: InkProperty = {
    type: "ink",
    version: 1,
    size,
    points: samples.map(({ x, y, pressure }) => [x - minX, y - minY, pressure]),
    outline: outline.map(([x, y]) => [x - minX, y - minY]),
    intrinsicWidth,
    intrinsicHeight,
  }
  const now = new Date().toISOString()
  const data: NoteNodeData = {
    noteType: "note",
    styleType: "ink",
    version: 1,
    createdAt: now,
    graphUid: boardId,
    parentId: parentId ?? undefined,
    properties: { inkData },
    _storedColors: { strokeColor: color },
  }

  return {
    id: asNodeId(id),
    type: "ink",
    x: minX,
    y: minY,
    w: intrinsicWidth,
    h: intrinsicHeight,
    angle: 0,
    groups: [],
    style: {
      strokeColor: displayColor,
      backgroundColor: "transparent",
      opacity: 100,
      autoFit: false,
    },
    data,
  }
}


/** Paint a committed ink node on the canvas-harness Canvas2D path. */
export const drawInkNode = (ctx: CanvasRenderingContext2D, node: Node): void => {
  const ink = readInkProperty(node)
  if (!ink || ink.outline.length === 0) return

  const scaleX = node.w / Math.max(MIN_NODE_SIZE, ink.intrinsicWidth)
  const scaleY = node.h / Math.max(MIN_NODE_SIZE, ink.intrinsicHeight)
  ctx.save()
  ctx.scale(scaleX, scaleY)
  ctx.fillStyle = node.style?.strokeColor ?? "#1f2937"
  ctx.globalAlpha = Math.max(0, Math.min(1, (node.style?.opacity ?? 100) / 100))
  ctx.beginPath()
  traceSmoothInkOutline(ctx, ink.outline)
  ctx.fill()
  ctx.restore()
}


const distanceToSegment = (p: Vec2, a: Vec2, b: Vec2): number => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}


/** Precise-enough centerline hit test used by selection and whole-stroke erasing. */
export const hitTestInkLocal = (node: Node, localPoint: Vec2, extraRadius = 0): boolean => {
  const ink = readInkProperty(node)
  if (!ink || ink.points.length === 0 || node.w <= 0 || node.h <= 0) return false
  if (
    localPoint.x < -extraRadius ||
    localPoint.y < -extraRadius ||
    localPoint.x > node.w + extraRadius ||
    localPoint.y > node.h + extraRadius
  ) return false

  const scaleX = node.w / Math.max(MIN_NODE_SIZE, ink.intrinsicWidth)
  const scaleY = node.h / Math.max(MIN_NODE_SIZE, ink.intrinsicHeight)
  const intrinsicPoint = {
    x: localPoint.x / scaleX,
    y: localPoint.y / scaleY,
  }
  const intrinsicExtra = extraRadius / Math.max(MIN_NODE_SIZE, Math.min(scaleX, scaleY))
  const radius = ink.size / 2 + intrinsicExtra + 2
  if (ink.points.length === 1) {
    return Math.hypot(intrinsicPoint.x - ink.points[0][0], intrinsicPoint.y - ink.points[0][1]) <= radius
  }

  for (let i = 1; i < ink.points.length; i += 1) {
    const a = { x: ink.points[i - 1][0], y: ink.points[i - 1][1] }
    const b = { x: ink.points[i][0], y: ink.points[i][1] }
    if (distanceToSegment(intrinsicPoint, a, b) <= radius) return true
  }
  return false
}


/** Hit-test one world point against a rotated/scaled ink node. */
export const hitTestInkWorld = (node: Node, worldPoint: Vec2, extraRadius = 0): boolean =>
  hitTestInkLocal(node, worldToNodeLocal(worldPoint, node), extraRadius)
