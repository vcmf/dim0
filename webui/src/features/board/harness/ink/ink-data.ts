import { readInkData, type Node } from "@canvas-harness/core"
import type { InkNodeFactoryInput } from "@canvas-harness/react"
import type { InkProperty } from "@/features/newsfeed/types/properties"
import type { NoteNodeData } from "../convert/note-to-node"


/** Store only the engine's portable geometry in the Note envelope. */
export const readInkProperty = (node: Node): InkProperty | undefined => {
  const ink = readInkData(node)
  if (!ink) return undefined
  return { ...ink, points: ink.points.map(([x, y, pressure]) => [x, y, pressure]) }
}


/** Stamp product scope and canonical colors in the engine's single add op. */
export const createDim0InkNode = (
  input: InkNodeFactoryInput,
  context: { boardId: string; parentId: string | null; color: string },
): Omit<Node, "z"> => {
  const { geometry } = input
  const inkData: InkProperty = {
    ...geometry.ink,
    points: geometry.ink.points.map(([x, y, pressure]) => [x, y, pressure]),
  }
  const data: NoteNodeData & { ink: typeof geometry.ink } = {
    ...input.data,
    ink: geometry.ink,
    noteType: "note",
    styleType: "ink",
    version: 1,
    createdAt: new Date().toISOString(),
    graphUid: context.boardId,
    parentId: context.parentId ?? undefined,
    properties: { inkData },
    _storedColors: { strokeColor: context.color, backgroundColor: "transparent" },
  }
  return {
    id: input.id,
    type: "ink",
    x: geometry.x,
    y: geometry.y,
    w: geometry.w,
    h: geometry.h,
    angle: 0,
    groups: [],
    style: { ...input.style, backgroundColor: "transparent", autoFit: false },
    data,
  }
}
