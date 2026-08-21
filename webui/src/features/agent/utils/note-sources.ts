/**
 * Note-citation helpers — pure, render-time, non-mutating. Sources are derived
 * from what `search_notes` / `get_note` actually surfaced this turn (keyed by the
 * node's `noteId`), NOT parsed from the answer — so a citation always points at a
 * real hit. Unlike documents, note TITLES aren't unique per board, so we key on
 * id and don't linkify title mentions (that ambiguity is left to a later phase).
 */
import type { AgentResponse } from "../types/stream"
import { isToolCallStep } from "../types/stream"


/** A cited board note: its node id, label, folder (`parentId`) + board for
 *  navigation, and the snippets the agent saw. */
export type NoteSource = { noteId: string; graphUid: string; label: string; parentId: string | null; snippets: string[] }


/**
 * Collect the distinct notes `search_notes` / `get_note` surfaced across an
 * answer's steps, in first-seen order, keyed by `noteId` so same-title notes
 * never merge. Grounded by construction — only ids the tools actually returned.
 */
export const extractNoteSources = (answer: AgentResponse): NoteSource[] => {
  const byId = new Map<string, NoteSource>()
  for (const step of answer.steps) {
    if (!isToolCallStep(step) || typeof step.output === "string" || step.output.type !== "note_search") {
      continue
    }
    for (const ref of step.output.references) {
      if (!ref.noteId) continue
      const snippet = ref.snippet.trim()
      const existing = byId.get(ref.noteId)
      if (existing) {
        if (snippet && !existing.snippets.includes(snippet)) existing.snippets.push(snippet)
      } else {
        byId.set(ref.noteId, {
          noteId: ref.noteId,
          graphUid: ref.graphUid,
          label: ref.label,
          parentId: ref.parentId,
          snippets: snippet ? [snippet] : [],
        })
      }
    }
  }
  return [...byId.values()]
}
