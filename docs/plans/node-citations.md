# Node citations — surface the board nodes the agent finds

`search_notes` / `get_note` feed the model but never surface the found notes as clickable references in
chat — so the user can't jump to a node the agent reasoned over. This wires note search into the
citation pipeline we already built for `doc_search`, grounded by the discipline Claude Code uses for
`file_path:line` citations.

## The gap (grounded)

`toOutput` (`agent/local/agent-event-to-step.ts`) has no branch for `search_notes`/`get_note`, so they
fall through to `JSON.stringify(result)`. The node ids in the raw result (`{id,title,content}`,
`engine/tools.ts` searchNotes) are flattened into a string and never reach a citation surface —
`extractDocSources`/`SourcesView`/`linkifyDocTitles` only see `doc_search`/`web_search`.

## What already exists to reuse

- **`doc_search` is the exact template.** `DocSearchOutput { references: DocRef[] }` →
  `DocSourcesView` (`components/chat/doc-sources-view.tsx`) renders a card whose **"Find on board"**
  button navigates `?center=<docId>` (`useCenterFromUrl`, `harness/canvas/use-center-from-url.ts` —
  selects + centers the node, then strips the param). `extractDocSources` collects references from the
  turn's steps; `linkifyDocTitles` rewrites exact title mentions into in-page jump links.
- **The cross-folder navigation primitive.** `NotesSearchDialog.jump`
  (`board/local/notes-search-dialog.tsx`) = `navigate({ search: { root_id: parentId, center: id } })` —
  opens the note's **layer** (`root_id`) AND centers it (`center`). Whole-board search now surfaces
  notes in other folders, so a note citation MUST set `root_id`, not just `center`.
- **Types already in the union.** `GetNoteOutput` / `MemorySearchOutput` exist in `ToolOutput`
  (`types/tool-outputs.ts`, from the legacy server path) — reuse/extend rather than invent.

## The Claude Code discipline to copy (from the leak analysis)

- **Model-full / user-receipt (dual-channel):** the model gets full note bodies; the user sees a
  compact, expandable "Found N notes" card. (CC: Read/Grep show `Found N files`, model gets the body.)
- **Cite an index you were handed, don't invent one:** keep the node **id in the structured result**
  the model sees, so a citation is copied, not guessed. (CC line-numbers Read output so `file:line` is
  copy-not-guess.)
- **Citation = resolvable token + a surface that resolves it**, plain-text safe otherwise.
- **Retrieval ledger (anti-hallucination):** only cite/linkify node ids the agent actually surfaced
  this run. (CC's `readFileState` gates "edit a file you haven't read.")

## Design

Give note search the `doc_search` treatment; two surfaces, both keyed by **node id** (unambiguous —
unlike note *titles*, which aren't unique per board, so we do NOT title-match the way `doc_search`
can):

1. **A note-sources card** (primary). `search_notes`/`get_note` emit a structured
   `NoteSearchOutput { references: { noteId, graphUid, label, snippet, parentId }[] }`. A
   `NoteSourcesView` (mirror `DocSourcesView`) renders "Found N notes" → title cards, each with a jump
   that navigates `{ root_id: parentId, center: noteId }` (cross-folder-aware). Grounded by
   construction: the card is built from the tool's real results, so nothing is hallucinated.
2. **Inline note→node links (optional, later).** A `linkifyNoteTitles` (mirror `linkifyDocTitles`) +
   a `#note-` href branch in `MarkdownLink` that navigates instead of scrolling. Gated on a **retrieval
   ledger** (ids surfaced this run) AND on the title being unique this run, since note titles collide.

`recall_memory` is a **separate surface** — its ids are memory records, not board nodes, so its
citations link to the memory viewer, not `?center=`. Out of scope here.

## Phases (one PR each)

- **P0 — fix the dead nav param (independent, tiny).** The existing create/edit note cards and
  `MarkdownLink` write `center_around`, which has **zero consumers** — the param `useCenterFromUrl`
  reads is `center`. Change the 3 writers (`tool-step-row.tsx`, `note-widget-preview.tsx`,
  `markdown-link.tsx`) to `center` (+ `root_id` where the parent layer is known). This alone makes
  note-card "Open on board" actually work today.
- **P1 — note-sources card.** `NoteSearchOutput` type + `search_notes`/`get_note` branch in `toOutput`
  (mirror the `doc_search` branch) + `extractNoteSources` + `NoteSourcesView`. The node's `parentId`
  for `root_id` comes from the store node's `data.parentId` (or `toSearchRows` in `search/notes-search.ts`,
  which already computes it). This is the main win: found notes become clickable, cross-folder-aware.
- **P2 — grounding + inline links (optional).** Retrieval ledger on `ToolContext`; `linkifyNoteTitles`
  for unique-title notes; `#note-` scheme in `MarkdownLink`. Also add the CC-style prompt rule (cite a
  note by a stable token) and freshness caveat.

## Tests

- `toOutput`: `search_notes`/`get_note` produce `NoteSearchOutput` with node ids + parentId (not a JSON
  string).
- `extractNoteSources`: dedupes by noteId across a turn's steps.
- `NoteSourcesView`: "Find on board" navigates `{ root_id, center }` (cross-folder).
- P0 regression: the note-card link uses `center` (the consumed param), so navigation actually fires.

## Estimate

P0 ~20 LoC. P1 ~150 impl + ~80 test (mostly mirroring `doc_search`). P2 ~120 + tests. Complexity Low–Med
— the pipeline exists; this is wiring note search into it, with node-id (not title) as the citation key.
