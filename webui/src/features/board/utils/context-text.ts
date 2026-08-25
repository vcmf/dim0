import type { NoteNode } from "../types/flow"
import { labelText } from "@/features/board/model"

type NoteLike = {
  id?: string
  // Canonical shape is RichText; a legacy local board may hold a bare string.
  label?: { markdown?: string } | string
  content?: { markdown?: string }
  properties?: {
    summary?: { text?: string }
    // Spatial info (from the Dim0 Note) — gives the agent where/how big the
    // selected note is, so it can reason about layout.
    nodePosition?: { position?: { x?: number; y?: number } }
    nodeSize?: { size?: { width?: number; height?: number } }
  }
  style?: { type?: string }
}

/**
 * Normalize an optional string value for text extraction.
 */
const trimOrEmpty = (value?: string) => (value ?? "").trim()

/**
 * Pick the most useful plain-text content for a node.
 */
const buildPlainNodeText = (node: NoteNode) => {
  const data = node.data as NoteLike | undefined
  const label = trimOrEmpty(labelText(data?.label))
  const content = trimOrEmpty(data?.content?.markdown)
  const summary = trimOrEmpty(data?.properties?.summary?.text)

  if (label && content && label !== content) {
    return `Title: ${label}\nContent: ${content}`
  }
  if (label) return label
  if (summary) return summary
  if (content) return content
  return ""
}

/**
 * Build a structured note block with ids and note types for agent context.
 */
const buildStructuredNoteBlock = (node: NoteNode) => {
  const data = node.data as NoteLike | undefined
  const noteId = trimOrEmpty(data?.id || node.id)
  const noteType = trimOrEmpty(data?.style?.type)
  const plainText = buildPlainNodeText(node)
  const pos = data?.properties?.nodePosition?.position
  const size = data?.properties?.nodeSize?.size
  const hasPos = pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)
  const hasSize = size && Number.isFinite(size.width) && Number.isFinite(size.height)
  const lines = [
    "<SelectedNote>",
    noteId ? `NoteId: ${noteId}` : "",
    noteType ? `NoteType: ${noteType}` : "",
    hasPos ? `Pos: (${Math.round(pos!.x!)}, ${Math.round(pos!.y!)})` : "",
    hasSize ? `Size: ${Math.round(size!.width!)}x${Math.round(size!.height!)}` : "",
  ]

  if (plainText.startsWith("Title: ")) {
    lines.push(...plainText.split("\n"))
  } else if (plainText) {
    lines.push(`Content: ${plainText}`)
  }

  lines.push("</SelectedNote>")
  return lines.filter(Boolean).join("\n")
}

/**
 * Build a structured context payload from a node list.
 * Each selected note is represented as its own compact tagged block.
 */
export const buildContextTextFromNodes = (
  nodes: NoteNode[],
  options: { skipPrefix?: boolean } = {}
) => {
  const { skipPrefix = false } = options
  const blocks = nodes
    .filter((node) => (node.data as { kind?: string } | undefined)?.kind !== "point")
    .map((node) => (skipPrefix ? buildPlainNodeText(node) : buildStructuredNoteBlock(node)))
    .filter((text) => text.length > 0)

  if (blocks.length === 0) return ""
  return blocks.join("\n\n")
}
