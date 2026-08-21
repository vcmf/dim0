/**
 * The URL search-param patch that jumps to a note on its board: open the note's
 * folder/layer (`root_id`) and center + select the node (`center`, consumed by
 * `useCenterFromUrl`). Shared by the notes search dialog and the agent's
 * note-citation card so the jump contract lives in exactly one place.
 */
export const centerNoteSearch =
  (parentId: string | null, noteId: string) =>
  (prev: Record<string, unknown>): Record<string, unknown> => ({
    ...prev,
    root_id: parentId ?? undefined,
    center: noteId,
  })
