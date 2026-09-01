# Unified board breadcrumb (persistent location bar)

## Problem
Two independent breadcrumbs exist and duplicate each other:

1. **Top-left canvas pill** — `local/local-folder-breadcrumb.tsx` (local boards only,
   only inside a folder). Root is the literal string `"Board"` — ignores the real
   board name (`boardLabel`). No leaf editing.
2. **Sheet panel breadcrumb** — `components/sheet/sheet-breadcrumb.tsx`, mounted in
   `sheet-panel.tsx`. Ancestor chain starts at the top-level note, so **the board
   name never appears**. Current note is a non-editable trailing span, and the leaf
   title is *also* the big editable H1 in the panel body → title lives in two places.

Root cause a board-level breadcrumb can't just "stay visible": when a surface opens,
`host.tsx` drops a full-screen backdrop at `z-[54]` with `backdrop-blur`, over the
top-left pill (`z-50`). So the board-level breadcrumb is blurred + non-interactive
whenever a sheet is open. That backdrop is why the panel grew its own breadcrumb.

Nesting model: opening a sub-sheet **replaces** `activeNodeSurface` (no stack in
state — `board-app-store.ts:239`). Depth is conveyed only by the breadcrumb chain
(+ decorative `SheetStackBackground` ghost cards). So the breadcrumb is the single
source of "where am I".

## Update — the breadcrumb IS the board title

Refinement after first review: the bar replaces the board-title element entirely.
It is always shown (including at the root), the root label is the real board name
(registry title for a local board, whose `graph.label` is empty; `graph.label` for
a synced one), and the trailing crumb is inline-editable at every level:

- **At the root**, the editable leaf is the board itself → renames the board
  (registry `renameBoard` for local; synced has no manual rename endpoint, so it's
  display-only there).
- **In a folder / sheet**, the leaf is that node → renames it (live store /
  registered surface hook / one-shot off-scene, as below).

Styling is chromeless (no border / shadow / background) so it reads as a title, not
a widget. An edit that starts on one target is abandoned if navigation changes the
target before it commits.

## Direction A — one persistent location bar
A single `<BoardBreadcrumb>`, mounted **once** in the canvas chrome, promoted **above
the backdrop** (`z-[60]`), that always reflects the *deepest* context:

- `[Board name] › … › [Leaf ✎]`
- Root = real `boardLabel` (fallback `"Board"`), truncated.
- Middle = collapsed to a single `…` (dropdown of the full chain) when ≥2 non-root
  segments; omitted when the leaf is a direct child.
- Leaf = current context, **always inline-editable** (click / pencil → input),
  truncated. This is the *only* home for the leaf title.
- Always crisp + interactive; the panel stops rendering its own breadcrumb and its
  big H1 title.

### Leaf resolution
`leafId = activeNodeSurface?.nodeId ?? rootId ?? null`. When null (board root, nothing
open) the bar is hidden (parity with today). Walking `parentId` from the surface leaf
already includes any folder ancestors, so we always walk from the single deepest node.

### Data source (reactive, no new load path)
`useLocalBoardContents(boardId)` already returns a flat `BoardContentItem[]`
(`{id,label,kind,parentId,iconData}`) for every surface node across all levels, and is
invalidated on every surface-relevant edit (create/rename/re-icon/move/delete) by
`useSidebarContentsSync`. Reads the on-device replica, so it works for **both** local
and synced boards (offline-first). Build segments with a pure
`buildNodePath(items, leafId)` (walk `parentId`, cycle-safe) → `CrumbSegment[]`
(`{id, kind, label, icon}`). Labels stay live because the query re-reads on invalidation.

Fallback: leaf not in the list (e.g. a mini-app, which `SURFACE_KINDS` excludes, or a
synced board not yet materialized) → show board name only. Documented limitation.

### Interactions
- **Root (board)** → `closeNodeSurface()` + navigate clearing `root_id`.
- **`…` dropdown item**:
  - folder → `closeNodeSurface()` + navigate `root_id = id`.
  - sheet / code-sandbox / widget → `openNodeSurface(id, kind)`.
- **Leaf** → non-navigable, click-to-edit (rename).

Route branches on `local`: `LocalBoardUrl` vs `/boards/$id` (mirror the two existing
breadcrumbs). `openNodeSurface` already drives the URL via the registered navigator.

### Leaf rename (the tricky part)
The open surface (if any) already owns a store (live / off-scene / REST) in the panel.
To avoid a second competing store writing the same node:

- Add `activeSurfaceRename: ((title: string) => void) | null` (+ setter) to
  `board-app-store`. `SheetPanel` registers its existing `persistTitle` on mount,
  clears on unmount. Reset on scope change / `closeNodeSurface`.
- Bar commit:
  - `leafId === activeNodeSurface?.nodeId && activeSurfaceRename` → call it (panel's
    own store handles the write; its `useNode`/`off.node` re-read keeps the panel live;
    `persistTitle` already patches `localBoardContents` optimistically).
  - else (folder leaf — never on the current scene, never the active surface) →
    `renameNoteOffScene(liveStore, boardId, leafId, title)`: a **one-shot** reuse of
    `openOffSceneNoteStore` (open store → `store.updateNode({data.label})` → flush →
    dispose). The store's change wiring records to the oplog + `submitLocalBatch(
    {scene:false})` + invalidates `localBoardContents` — the correct sync-safe path.
    No competing store (no panel open for a folder), so no staleness.
- Bar also applies `applyTitleUpdateToBoardContents` optimistically on commit for
  instant feedback (both paths).

Assumption to verify in review: `store.updateNode(id, {content})` emits a
field-level op (does not re-emit `label`), so an open panel's now-stale label can't
clobber the rename on a subsequent content edit. (Existing panel code already relies on
distinct field patches for label vs content.)

## File plan

### New
- `components/breadcrumb/build-node-path.ts` — pure `buildNodePath(items, leafId)` +
  `CrumbSegment` type. Cycle-safe. Unit-tested.
- `components/breadcrumb/build-node-path.test.ts`.
- `components/breadcrumb/board-breadcrumb.tsx` — the bar (root + `…` dropdown + editable
  leaf), `z-[60]`, hidden while presenting and when `leafId` is null.

### Modify
- `harness/canvas/harness-canvas.tsx` — mount `<BoardBreadcrumb local={!canCollab} />`
  in `HarnessCanvasInner` (guarded by `!presenting`).
- `local/local-board-screen.tsx` — drop `LocalFolderBreadcrumb` import + usage.
- `chrome/node-surface-host/sheet-panel.tsx` — remove `SheetBreadcrumb`, the H1 title
  button/input + `titleEditing`/`titleDraft`/`titleInputRef` + effects; register
  `persistTitle` as `activeSurfaceRename`. Keep icon control, content, download/close,
  `noteLabel` (download filename), `SheetStackBackground`.
- `harness/store/board-app-store.ts` — add `activeSurfaceRename` + setter; clear it in
  `setBoardScope` and `closeNodeSurface`.
- `chrome/node-surface-host/use-off-scene-note.ts` — export `renameNoteOffScene`.

### Delete (dead after the above)
- `local/local-folder-breadcrumb.tsx`
- `components/sheet/sheet-breadcrumb.tsx`
- `components/sheet/resolve-crumb.ts` + `resolve-crumb.test.ts`
  (`resolveCrumb` is used only by `SheetBreadcrumb`).

`buildLayerPath` stays — still used by `notes-search.ts`.

## Out of scope / follow-ups
- mini-app leaf (excluded from `SURFACE_KINDS`) → board-name-only fallback.
- Miller-columns nesting (Direction D) — larger rewrite, later.

## Verify
`npm run check-all` + `npm run test:run`, then `/code-review high`.
