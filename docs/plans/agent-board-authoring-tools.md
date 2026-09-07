# Brainstorm: richer board-authoring tools for the agent

Status: **discussion / not decided**. A living doc to think through giving the
browser agent real authorship over the board (position, style, structure),
instead of the current "content-only, layout imposed" tools.

Participants: dev04 + Claude. Add takes inline; mark decisions with **DECIDED:**.

---

## Decisions log

- **Placement = Option C (hybrid):** `position: "auto"` (default) | relational
  `{relativeTo, dir, gap?}` | explicit `{x, y}` escape hatch. (§3)
- **Collision handling is per-mode:** auto = global offset into free space;
  relational = local nudge along `dir`, stays near the anchor; explicit = none.
  Relational deliberately does **not** reuse auto's "shove to free space." (§3b)
- **Color = reuse the existing named palette:** a `FAMILIES` family-name enum
  resolved via `resolveFamilyShade`; v1 fixes shade at 200 + black text for
  contrast. No new color infra. (§5)
- **Dagre can't pin nodes** → no free anchor support. New-cluster-in-free-space
  is already solved (`arrangeCreatedNodes`); true interleaving would need
  ELK-interactive/cola (deferred to v2). (§4)
- **Tool descriptions are prompt real estate:** teach the three modes + the
  "prefer auto, override only with intent" default, tightly — no bloat, no full
  color-name list. Schema uses optional `near`/`at` (not a `position` union). (§9b)
- **Drawify skill: yes, and complementary to `learn_generate_diagram`** — diagram =
  structure + auto-layout (no styling); drawify = authored styled sketch using the
  new params. Scope crisply so routing doesn't collide. (§8b)
- **Edge curves already exist in the model** (`edgeControlPoint` → cubic controls);
  `link_notes` just doesn't set them. Expose a **relative bend**, not the raw world
  midpoint. Edge color/arrowheads are cheap follow-ons. (§5c)
- **Agent-authored subfolders:** flat `parentId` model + `folder` node type make it
  tractable, BUT **the store is the only sync-correct write path** (persistence +
  outbox both observe store `change`); `getBoardPersistenceRef()` alone is
  local-cache-only and **desyncs** — do not use it to write. (§6)
- **PREFERRED: a `navigate` / working-folder tool (like Claude Code's cwd).** The
  agent gets its own mutable working folder (`ctx.rootId`), decoupled from the user's
  view; `navigate` = `cd` + `ls` (its return refreshes context); writes are relative
  to it. Because the working folder is the *agent's* cursor (not the shared view),
  **there is no view to lock** — it supersedes the §6b lock. Commits us to the v2
  headless emit (sync via persistence + outbox, no scene), and delivers
  existing-folder writes + cross-layer arrange for free. (§6c)
- **Fallback only:** v1a = navigate the *shared* view + a self-healing lock (release
  via finally + deadman + user-cancel + reload; never persisted). Use only if we pick
  speed over the working-folder model. (§6b)
- **Decouple the agent from collab via content-level ports (§6d):** the agent runtime
  depends on `BoardReader` (getLayer/getNode/search) + `BoardMutator` (addNotes/
  addLinks/updateNodes/createFolder) — **domain verbs, no ops/seq/relay**. Collab
  hides behind `BoardMutator`: **one `submitLocalBatch` intake, two producers**
  (store scene for the current layer, headless for others), **one seq/rebase
  authority**. `store` shrinks to the user's-view projection; source of truth for the
  agent is board content (persistence). Uniform across local/synced/desktop.
  Introduce additively (wrap today's store path first). Needs an ADR-SYNC-001 update;
  rebase-with-headless-batches is the hard part.

Still open: `arrange` tool + strategies (§4/Q2), `parent_id` timing (§6/Q4),
context shape (§7/Q5), drawify-as-skill north star (§8/Q6).

---

## Related bugs (standalone — NOT plan steps)

Surfaced while designing this plan; fix independently, not as part of the roadmap:

- **Node `updatedAt` is split across two disjoint fields → the "Edited" stamp is
  broken.** `DimNodeData.meta.updatedAt` (number, canonical, written by the agent)
  vs `NoteNodeData.updatedAt` (string, read by every display: `sheet/view`,
  `list-view`; `node-footer` is dead). Writers and readers are on *different*
  fields, so: agent-created notes show **no** stamp; human-created notes are stuck
  on "Created"; body edits never bump it for anyone. Not a sync issue (`meta` is
  "display only, never merge ordering"), so blast radius is small (3 reader sites +
  edit handlers; sync/search/sort/persist all independent). Fix: unify on the
  number (`meta`), derive the display string from it, bump `meta` on every live
  edit (incl. `patchNote`'s content-only branch), with a legacy-string fallback and
  keep the wire string at the legacy-backend convert boundary until G5. Same split
  exists on `DimEdgeData`. *(PR1 faithfully reproduced the agent-side gap and stays
  behavior-neutral; this fix is separate.)*
- Filed GitHub issues (out of plan): **#251** (Cargo.lock release version drift),
  **#252** (staged mindmap drains into wrong layer on a hydration/navigation race).

---

## 1. Where we are today (grounded in `webui/src/features/agent/engine/tools.ts`)

The agent's active build tools (`agentBuildTools`, wired in `use-local-submit-prompt.ts`):

| Tool | Params today | Placement | Style |
|---|---|---|---|
| `write_note` | `content, label?, note_type?, note_id?` | born at `beneathBorderOrigin`; multi-note turn re-laid by `arrangeCreatedNodes` | `randomNoteColors()` → `_storedColors` |
| `edit_note` | `note_id, field, old, new, replace_all?` | — | — |
| `link_notes` | `source_id, target_id, label?` | edge attaches at node centers | default link style |
| `get_note` | `note_id` | — | — |

Two hard facts that shape everything below:

- **Placement is implicit.** The model has *no* positional control. It writes
  notes; the post-turn layout (mindmap / dagre, then "translate beneath existing
  content") decides where they land. Good for zero-effort tidiness, bad when the
  model has spatial intent.
- **Style is random.** `randomNoteColors()` picks the palette; the model can't
  choose. Color's source of truth is `_storedColors` on `DimNodeData`, **not**
  `node.style` (the theme adapter overwrites style). Any color param must write
  `_storedColors`.

**Drawify is the opposite pole.** The backend `/tools/drawify` authors explicit
`x/y/w/h`, background, border, roundness per node; the frontend applies it
verbatim (`storeMindMap({ preserveStyle: true, layout: false })`). That full
authorship is *why drawify output feels richer* — it's the one path where a model
actually composes the picture.

**Context is content-only.** `buildContextTextFromNodes` emits
`<SelectedNote> NoteId / NoteType / Content </SelectedNote>`. The model never
sees where anything *is*, how big it is, or what color — so it couldn't place
things relative to existing content even if the tools allowed it.

> The gap in one line: **we ask the model to think in prose, then a layout
> algorithm guesses the picture. Drawify lets a model think in pictures. We want
> the everyday tools closer to drawify — without losing auto-layout's
> zero-effort tidiness.**

---

## 2. The vision (dev04's framing)

Give the agent "enough power to do whatever it wants":

1. More params on create/edit/link: `parent_id` (default null = root),
   `coords` (default `"auto"` = auto-layout), `background_color`, `border_color`.
2. Decide how to apply auto-layout to a *specific* node/cluster — maybe
   `auto_layout` becomes its own tool.
3. Feed **position** (and, we think, size/color) into the agent's context, so it
   has visual awareness, not just text.

Agreed on the direction. The rest of this doc is about *the right abstraction*,
because the naive version has traps.

---

## 3. The central design decision: raw coords vs. spatial intent

This is the one to get right; everything else follows.

**Option A — raw `x/y` (the drawify shape).** Model emits absolute coords.
- Pro: maximally expressive; unifies with drawify.
- Con: an LLM has **no sense of the canvas frame** — no idea of extents, current
  camera, or how big a node renders. Absolute coords from a general chat model
  will collide, drift off-screen, and overlap existing content. Drawify only
  works because it's a *specialized* diagram model spending its whole budget on
  layout, with output normalized/scaled afterward. Our everyday agent won't have
  that budget mid-conversation.

**Option B — relational / semantic placement.** Model expresses *intent*, the
engine computes coords. E.g. `place: { relativeTo: nodeId, dir: "right"|"below"|…, gap? }`,
or `group: "clusterName"`, or a per-cluster `layout: "tree"|"grid"|"free"`.
- Pro: matches how the model actually reasons ("put the counterexample to the
  right of the claim"); near-impossible to produce off-screen/overlapping junk;
  the engine still owns collision-free coordinates.
- Con: a new vocabulary to design + implement; less raw power than free coords.

**DECIDED: Option C — hybrid.** (dev04 + Claude)
- Default `position: "auto"` → today's deferred layout (keep the zero-effort win).
- `position: { relativeTo, dir, gap? }` → relational intent (Option B) for the
  common "place this near that" case.
- `position: { x, y }` → raw escape hatch (Option A) for when the model *does*
  have exact coords (drawify-style flows, or "recreate this diagram").

> **Why (rationale for the decision):** raw x/y as the *primary* interface would
> very likely make everyday output *worse* than auto-layout, not better — the
> model overlaps things. The reason drawify looks good is not "raw coords," it's
> "a model that reasoned hard about a whole layout." Relational placement gives
> the everyday agent that quality more safely than a number pad — while explicit
> x/y stays available for the genuine drawify-style "recreate this exact diagram"
> case.

---

## 3b. Collision handling differs per mode (dev04's question — important)

> "Auto-layout moves nodes with an offset so they avoid existing nodes — will
> relational do the same thing?"

**No — and it must not.** The three modes need *three different* collision
behaviors, because they express different intents:

| Mode | Collision behavior | Why |
|---|---|---|
| `auto` | **Global offset** — lay out the whole new cluster, then translate it into free space (beneath existing content). Today's `arrangeCreatedNodes` behavior. | The model has *no* spatial intent; "somewhere tidy and out of the way" is exactly right. |
| relational `{relativeTo, dir, gap}` | **Local nudge** — place at `anchor edge + gap` in `dir`; if that AABB overlaps an existing node, step further **along `dir`** (by occupied extent + gap) until the slot is free. | The intent *is* "next to A." Shoving it to free space (the auto offset) would **destroy the intent** — B would end up nowhere near A. So it avoids overlap, but *locally, in the requested direction*, staying near the anchor. |
| explicit `{x, y}` | **None** — place verbatim. | The model asked for exact coords (drawify-style). Respect them; overlap is the model's call. |

So relational *does* avoid overlap, just via a fundamentally different mechanism
(local, direction-preserving) than auto's global shove. This is the crux of why
the modes can't share one placement routine.

**Consequence for mixed turns:** a relational node is effectively *pinned* (it
belongs next to its anchor). If it's connected to `auto` siblings, the auto layout
must flow around it → the pinned-aware layout problem from §4. v1 keeps them
separate (relational places single nodes; auto handles whole new clusters), per
the "all-auto or all-explicit per connected group" rule.

---

## 4. `auto_layout`: default behavior AND a tool

Your question — "how to apply auto-layout to only a specific node/cluster" — I
think the answer is *both*, and they're not in conflict:

- **Keep the post-turn default.** Newly-created `position: "auto"` nodes still get
  arranged after the turn (today's `arrangeCreatedNodes`). Zero model effort;
  the common case stays effortless.
- **Add an explicit `arrange` / `auto_layout` tool** for on-demand tidying:
  `arrange({ node_ids?: string[], root_id?: string, strategy?: "tree"|"grid"|"flow" })`.
  - Targets a selection, an explicit id list, or a whole layer/subtree.
  - This is the clean answer to "layout a specific cluster": the model calls it
    with those ids.
  - Bonus: it shows up as a visible step (aligns with the skill-visibility work) —
    the user *sees* "arranged 6 notes."

> **My take:** a tool is the right home for *selective/explicit* layout;
> a default post-turn pass is the right home for *zero-effort* layout. Ship both.
> The layout primitives already exist (`autoLayout`, `layoutBidirectional` in
> `arrange-created-nodes.ts`) — the tool is mostly plumbing over them.

The genuinely hard part: **mixed turns** — some nodes pinned (explicit/relational),
some `auto`. Auto-layout must treat pinned nodes as *fixed obstacles* and flow the
auto ones around them, or they collide. That's constraint-aware layout, a step up
from "dagre the whole set."

**Does dagre give us anchors for free? No.** Our layout is vanilla `@dagrejs/dagre`
(`lib/graph/dagre.ts`) — Sugiyama layered layout that assigns *all* coordinates
from rank/order. There is no "hold this node at (x,y)" constraint; it can't pin.
So dagre does not solve the mixed/anchored case. What we *do* already have:
- **New-cluster-in-free-space is solved** — `arrangeCreatedNodes` lays out the new
  nodes and translates the whole cluster into empty space beneath existing content
  (the fix we just shipped). So "add an auto cluster to a board that already has
  pinned content" already avoids overlap, as long as the new nodes form their own
  group.
- **True interleaving** (auto nodes that must thread *among* specific pinned nodes)
  needs a different engine: **ELK** (`elkjs`, has an `interactive`/fixed-position
  mode that respects given coords) or **cola.js** (constraint solver with fixed
  nodes). That's a dependency + engine swap — real work.

Proposal: **v1 = per connected group it's all-auto or all-explicit** (the
free-space translate already covers this); **v2 = pinned-aware layout via
ELK-interactive/cola** only if we find we actually need interleaving.

---

## 5. Style params (the easy, high-value win)

`background_color?` and `border_color?` on `write_note` (and an
`edit_note`/`restyle` path for existing notes).

- Write to **`_storedColors`** (source of truth), then let the canonical style +
  theme adapter derive `node.style`. Writing `node.style` directly is the classic
  bug — it gets overwritten.
- **Palette vs hex:** prefer a **named palette** (the app's tailwind shades the UI
  color picker already uses) so agent output stays visually coherent with
  human-picked colors; allow raw hex as a fallback. A named enum is also far
  easier for the model to use well than free hex.
- Low risk, immediately makes output feel authored. **Good first PR**, independent
  of the placement debate.

**DECIDED: reuse the existing named palette — it's already correct.** Reviewed
`lib/colors/tailwind.ts`:
- `FAMILIES` — the curated named set the UI picker uses: `transparent`, `white`,
  `black`, plus ~23 Tailwind families (`slate…orange`), each already keyed for the
  picker.
- `TAILWIND_HEX` is the **paper-adapted (warm-theme) palette** (built from
  `ORIGINAL_TAILWIND_HEX` via `adaptTailwindColor`), and `resolveFamilyShade(family,
  shade)` returns the adapted hex. `paletteForShade(shade)` returns `{name, hex}[]`.
- `_storedColors` (`StoredColors = {backgroundColor, strokeColor, textColor}`) stores
  **hex**; the picker and `randomNoteColors()` both go through
  `resolveFamilyShade`. Dark mode is derived automatically on theme flip
  (`adaptNodeColors`). So the naming→hex→stored→theme pipeline is centralized and
  correct — we just feed a name into the front of it.

So the model-facing param is a **family-name enum from `FAMILIES`**, resolved via
`resolveFamilyShade(family, DEFAULT_SHADE)` into `_storedColors` — exactly what the
picker does.

**Contrast caveat:** today notes are shade **200 + black text** (`randomNoteColors`),
which guarantees legible text. If we let the model pick arbitrary shades, black text
breaks on deep shades. So **v1: expose family only, keep shade fixed at 200 + black
text**; a later version can allow shade with luminance-derived text color.

---

## 5c. Enriching `link_notes` (curve + style)

**The data model already supports edge curves — the tool just doesn't use it.**
- `Link.properties.edgeControlPoint.position` is a single **world-coord midpoint**
  the curve passes through at t=0.5 (`types/link.ts`).
- `linkToEdge` runs `midpointToCubicControls(srcWorld, midpoint, tgtWorld)` → the
  harness `Edge.control: [c1, c2]` (cubic pair). Persistence round-trips it via
  the reverse convert. So rendering + storage are done.
- But the agent's `linkNotes` (`engine/tools.ts`) sets **no** control point — it
  attaches center→center with `pathStyle: "bezier"`, so edges are default/straight.
  Also `edgeControlPoint.position` is absent, `label` → `edge.content`, style is
  `canonicalEdge()`.

**So enabling curves is a small tool change** — but the exposed param must **not**
be the raw world midpoint (same LLM-coordinates trap as §3). Expose a **relative
bend** instead:
- `curve?: number` — signed perpendicular offset from the straight midpoint
  (+ one side, − the other; 0/omitted = straight). Or a tiny enum
  `bend: "straight"|"left"|"right"` (+ optional amount).
- Engine computes: `straightMid = (srcCenter + tgtCenter)/2`; `worldMid =
  straightMid + unitPerpendicular · amount`; then the existing
  `midpointToCubicControls` → `Edge.control`. Default straight.

Why the agent wants it: **route around a node/other edges**, and **hand-drawn
curved connectors** for the drawify skill (§8b). Same philosophy as placement —
express intent (bend left/right, how much), engine computes coords.

**Other link enrichments worth the same treatment (later):** edge
`color` (→ `_storedColors`, reuse §5 palette), and arrowhead ends (the
`LinkStyle` already carries `source/target_arrowhead`; drawify already sets them).
Endpoint attachment control (which side of the node the edge leaves) is a bigger
one — defer.

Description-wording note (§9b): `curve` gets one tight line — *"Bend the link to
avoid crossings; omit for a straight line."* — not a coordinate lecture.

---

## 6. `parent_id` — the agent authors into subfolders (re-assessed)

dev04's vision: the agent **creates a subfolder and populates it** — scaffolds a
structured sub-board on its own. After reviewing the model, this is *more
tractable than I first flagged*, because the data model is already built for it.

**What already exists (the easy part):**
- A layer is flat and id-based: `filterContentByLayer` = "nodes where
  `parentId === rootId`" (`model/layer.ts`). No nesting math.
- `folder` is a first-class **node type** (`node-types/folder/def.ts`); entering it
  sets `root_id = folder.id`; its children carry `parentId = folder.id`.
- Creating a note with any `parentId` stamps it correctly — `parentId` is just data.

**The correctness constraint (dev04's catch): the store is the only sync-correct
write path.** Both local persistence and server sync observe the store's local-batch
`change` event — `BoardPersistence.attach` = `store.subscribe("change", record)` →
IndexedDB; `board-sync`'s **outbox** records the same batches and pumps them to the
relay. So `store.addNode` → persisted **and** synced. A direct
`getBoardPersistenceRef()` write hits IndexedDB **only** — it bypasses the outbox
(no server sync) *and* the scene, so on a synced board it **desyncs local from
server/peers**. (My earlier "persistence-first via `getBoardPersistenceRef()`" was
wrong — that's local-cache-only.) "Persistence-first" must mean **local replica +
server**, which only a store local batch (or a proper headless emit) achieves.

**The tension:** to sync, a write must be a store local batch — but the store *is*
the current-layer scene, so it also renders there. Two resolutions:

- **v1 — make the target the current layer.** `create_folder` (current layer, normal
  store write → synced + rendered) → **navigate in** (`root_id = folder.id`, *await*
  the re-projection `ready`) → `write_note`/`link_notes` into the now-empty subfolder
  **as the current layer** (proven path: synced ✓, rendered right ✓,
  `arrangeCreatedNodes` runs on the subfolder's own store ✓) → navigate back out.
  Reuses only the correct path — no reproject flash, no headless emit.
- **v2 — headless sync-correct emit / off-screen store.** Feed batches to
  persistence **and** the outbox without the visible scene, so the agent authors
  into a folder *without moving the view*. Bigger — must respect the oplog seq
  authority in `board-sync`.

**`arrangeCreatedNodes` stays safe under v1** *because* it always runs on the current
layer, which v1 has made the target. dev04's worry is right in general: it's coupled
to `store.getAllNodes()` (current layer only) and its position writes must also be
sync-correct — so true cross-layer arrange needs v2's emit too. v1 dodges this by
never arranging a non-current layer.

### 6b. The v1 lock — and why it can't get stuck

Moving the viewed layer mid-turn means the user must not navigate/edit underneath
it. That needs a lock — and a lock you can't guarantee-release is worse than the
problem. Design it as a **soft, in-memory, self-healing** lock with **four
independent release paths**, so "stuck forever" is effectively impossible:

1. **`finally` release** — the turn releases on any return / throw / abort.
2. **Deadman timeout** — the lock carries an expiry; an expired lock reads as
   released (heartbeat-renew for genuinely long turns). Survives a missed `finally`.
3. **User cancel** — the existing agent cancel/abort force-releases (guaranteed
   human escape hatch).
4. **Reload clears it** — the lock is a store flag, **never persisted**, so a refresh
   always frees it (can never be stuck across sessions).

Scope + hygiene:
- Block only user **navigation + structural edits** during the window — not
  pan/zoom/read. Show an "organizing…" indicator so the view-hop is explained.
- **Restore the user's original layer on release** (capture `rootId` at lock time),
  so disorientation is bounded to the turn.
- It's a **local** lock — it does *not* and *cannot* lock peers (they sync via the
  relay); concurrent peer edits are handled by the normal rebase.
- The window spans `navigate(folder) → await ready → writes → arrange → navigate(back)
  → release`; the writes must await the folder projection (`ready`) or they'd land
  in the old layer.

**Two sub-cases, different difficulty:**
- **Create-and-populate a NEW folder in one turn** (dev04's exact scenario): v1 above.
  Needs no board-structure context — `create_folder` returns the id mid-turn.
- **Write into a PRE-EXISTING folder:** needs the folder tree in context (§7) to
  target one. Pairs naturally with v2 (author without hopping the view).

**Proposed shape:**
- `create_folder(label, parent_id?)` → `{ folder_id }`.
- `write_note` / `link_notes` gain `parent_id?` (default `ctx.rootId`).
- v1 routing: to write into another layer, acquire the lock → navigate there → write
  via the store (synced + arranged) → navigate back → release.
- Receipt: reuse the **note-citation card** — "created N notes in *Folder X*" with a
  jump (`root_id` + `center`).

> **Revised take:** v1 (navigate-into-target + a self-healing local lock) reuses the
> proven, sync-correct write+arrange path and is bounded; the lock's four release
> paths make "stuck forever" effectively impossible. v2 (headless emit) removes the
> view-hop and lock entirely *and* unlocks cross-layer arrange — pursue it if
> view-hopping proves too disruptive. **Do NOT** use `getBoardPersistenceRef()` as a
> write path — it's local-cache-only and desyncs.

---

## 6c. Preferred: a `navigate` / working-folder tool (dev04) — like Claude Code's cwd

Reframe the whole thing around an **agent working folder**, exactly like Claude
Code's working directory:

- The agent has a **working folder** = a mutable `ctx.rootId`, initialized to the
  user's current layer.
- `navigate(target)` sets it (`folder_id` | `"root"` | `"up"`) and **returns the
  folder's contents** — its `cd` + `ls`. That return is what refreshes the agent's
  context (§7): **the working folder is the unit of BOTH write-scope and
  read-scope**, one concept governing both.
- `create_folder` returns a new id → the agent `navigate`s into it.
- `write_note` / `link_notes` / `search` / `get_note` operate **relative to the
  working folder** (like editing files relative to cwd), so per-call `parent_id`
  becomes an optional *absolute-path override*, not the primary mechanism.

**Why this beats v1a's implicit hop + lock:** CC's `cd` moves the *agent's* cwd; it
doesn't hijack your editor. The faithful analog makes the working folder the
**agent's** cursor, **decoupled from the user's on-screen layer** — so there is **no
shared mutable view to lock.** The entire §6b lock exists only because v1a moved the
shared view; the working-folder model removes the need for it.

**What it commits us to:** writes now target a layer that isn't the visible scene,
so they must use the **v2 headless sync-correct emit** (persistence + outbox, no
scene render). The `navigate`/working-folder tool is the clean *API*; v2 is the
*plumbing* beneath it. Trade: more sync work up front (respect the oplog seq
authority), but in return — no lock, no view-hop, and write-into-existing-folder
and cross-layer arrange all come **for free** (they're just "navigate there").

**Engine change:** `ctx.rootId` becomes **mutable mid-turn** (navigate sets it), and
context/search re-scope when it changes. A bounded, clean change to the tool loop.

**View + receipts:** don't move the user's view. On finish, surface a receipt
("worked in *Folder X* — N notes") with a jump (`root_id`+`center`) — the user steps
in themselves if they want, CC-style.

> **DECIDED direction:** the working-folder model **supersedes** §6b's lock as the
> preferred path. The lock stays documented as the fallback *only if* we deliberately
> pick v1a for speed. This also simplifies §5c/§3 mentally: everything the agent
> creates lands in "the working folder," and the folder tree in context (§7) is the
> filesystem it navigates.

---

## 6d. Runtime context & decoupling the agent from collab (the key abstraction)

### The runtime context today (`ToolContext`, `engine/types.ts:82`)

| Field | What | Scope |
|---|---|---|
| `store` | live canvas store = user's current-layer scene; **also the sync-op source** | current layer |
| `rootId` | current folder layer; stamped as `parentId` on create | current layer |
| `boardId` | the board (memory writes bind to it) | board |
| `search` | full-text index, rebuilt per turn | **whole board** |
| `boardNotes` | id→node map from persistence | **whole board** |
| `memory` | durable agent memory | board + global |
| `confirmTool` | off-board-tool gate | run |
| `registry` | in the type, **not passed** in the live run | — |

Real run wires 7 of 8 (`use-local-submit-prompt.ts:369`); transforms wire a lean
`{store, rootId, search}`. Run-level (not in ctx): `system, userMessage, history,
tools, llm`. **Gaps for the working-folder model:** no whole-board *edges* map
(parallel to `boardNotes`), and no sync-correct *write* handle (writes go through
`store`).

### The coupling smell

The agent writes by calling `store.addNode/updateNode/addEdge`. The store's
`change` event fans out to persistence (IndexedDB) **and** the sync outbox
(→ relay, with oplog seq + rebase). So a tool that just wants to "add a note to
layer X" is transitively wired into **collab conflict-resolution machinery** it
should know nothing about. That's why cross-layer / headless writes felt scary —
they drag in ops, seq, and rebase.

**This coupling is incidental, not essential.** The agent's real needs are only:
*read board content* and *write board content* — at the domain level (notes, links,
layers, positions), never at the op level.

### The abstraction: content-level ports, collab behind them

Give the agent runtime two **content-level ports**, and nothing else:

- **`BoardReader`** — `getLayer(rootId) → {nodes, edges}`, `getNode(id)`,
  `search(query)`. (We already have most of it: `boardNotes` + `search`; add
  whole-board `boardEdges`.)
- **`BoardMutator`** — `addNotes(layer, notes)`, `addLinks(layer, links)`,
  `updateNodes(updates)` (positions from arrange), `createFolder(layer, label)→id`.
  Domain verbs; **no `Op`, no batch, no seq** in the signature.

Collab becomes an **implementation detail behind `BoardMutator`**:

```
agent tools ─► BoardMutator (content verbs) ─► one local-batch intake ─► { local persistence, sync outbox }
                                     ▲                                              │
                                     └── routes by layer:                          └─ seq / rebase / relay
                                         • target == current view  → via the store (renders too)
                                         • target == other layer   → headless (no scene)
```

The load-bearing idea: **one local-batch intake, two producers, one seq authority.**
`board-sync` already has the "record + enqueue a local batch" pipeline that the
store `change` feeds. Expose it as an explicit `submitLocalBatch(batch)`:
- the **store subscription** becomes just *one* caller (current-layer writes — still
  render, because they go through the scene);
- the **headless mutator** is *another* caller (other-layer writes — skip the scene);
- both share the **same** oplog seq + rebase authority, so nothing desyncs. The
  headless path must *reuse* this intake, never a parallel injection — that's the
  one hard integration point (unacked-batch replay must include headless batches).

### What this buys

- **The agent runtime depends on `BoardReader`/`BoardMutator` only** — zero
  dependency on ops/seq/relay. It can't desync or corrupt, because every write goes
  through the single sync-correct intake.
- **Uniform across local / synced / desktop** — same agent code; only the port impl
  differs (local = persistence + no-op relay; synced = + outbox/relay). No
  `if (local)` branching in tools.
- **The store's role shrinks to what it should be:** the *user's current-layer
  projection* (render + human editing + the current-layer producer). It stops being
  "where the agent's data lives." Source of truth for the agent is board content
  (persistence), read via `BoardReader`.
- **The working-folder model (§6c) falls out for free:** `navigate` sets the working
  layer; `BoardReader` reads it for context; `BoardMutator` writes to it; the
  current-vs-other routing is internal and invisible to the agent.

### `ctx` impact

- Replace "agent writes via `ctx.store`" with **`ctx.board: BoardMutator`** +
  reads via **`BoardReader`** (`boardNotes`/`boardEdges`/`search` become its
  backing).
- `ctx.store` stays, but only as the *user's-view* store (rendering, and the
  current-layer producer inside the Mutator) — tools shouldn't call it to write.
- `ctx.rootId` → the mutable **working folder** (§6c).

### History: two axes, and how the Mutator preserves both

"History" is **two distinct features** backed by two different substrates:

| | **Live undo/redo** | **Durable history / revert-to-snapshot** |
|---|---|---|
| Lives in | the **store** (in-memory) | **persistence**: snapshot + **oplog** |
| Fed by | local store batches (remote batches skip it) | `record` (local batches) + `recordRemote` (relay) |
| Scope | the **current scene**, layer-local | **whole board**, all layers |
| Lifetime | ephemeral — `clearHistory` on layer switch, gone on reload | durable across sessions |

Today both are fed by the same event: a store local batch lands on the undo stack
**and** is `record`ed to the oplog. So agent writes are currently undoable *and*
durable.

Under the Mutator, this is preserved **as long as routing respects the axes:**
- **Current-layer write → via the store** → on the undo stack **and** the oplog (the
  common case; today's behavior unchanged — ctrl-z still undoes the agent's visible
  work).
- **Headless / other-layer write → `submitLocalBatch`** → recorded to the oplog
  (durable ✓, synced ✓, **revert-to-snapshot sees it** ✓) but **not** on the current
  store's undo stack — which is correct: there's no scene to undo it in, and when you
  later navigate into that layer it projects fresh with `clearHistory` (empty stack),
  exactly like prior-session content.

So: **undo/redo is inherently a current-scene concept; revert/snapshot is the
whole-board durable one.** The Mutator must keep current-layer writes on the store
path (don't route them headless, or they'd silently lose undo), and headless writes
are durable-only by design. Two design notes worth deciding:
- **Group an agent turn into one undo entry?** Today a multi-note turn = many batches
  = many ctrl-z steps. The Mutator could wrap a turn's current-layer writes in one
  undo batch. Nice-to-have, orthogonal.
- **Revert-to-snapshot UI — VERIFIED: none today.** The snapshot+oplog substrate is
  purely internal (persistence load/`compact`, collab welcome snapshot); there is no
  user-facing revert/version-history. So it's a *latent* capability, and **the only
  history feature the Mutator must preserve is live undo/redo** (current-layer writes
  → store path). If a revert UI is ever built on the oplog, headless writes are
  already included — free.

### Caveats (honest)

- Touches the sync spine (`harness/sync`, `persist/local`) → warrants an
  **ADR-SYNC-001 update**. The `submitLocalBatch` intake + headless producer must get
  **rebase** right (replay unacked local batches — store *and* headless — on top of
  remote ops). This is the real work; the port surface is the easy part.
- Scope creep risk: this is a refactor of a load-bearing path. Sequence it so the
  port is introduced *additively* (wrap today's store-write path as the first
  `BoardMutator` impl, agent unchanged), then add the headless producer, then the
  working folder — each shippable on its own.

---

## 7. Context enrichment (the retrieval side)

Agreed: explicit/relational placement is impossible if the model can't *see* the
board. But "dump x/y for every node" is the naive version and has costs (tokens,
and LLMs reason poorly over long coord lists).

Proposal — a compact **spatial layer** on top of today's content context:

- Per selected/nearby note: add `pos: (x,y)`, `size: (w,h)`, and `color` to the
  `<SelectedNote>` block. Cheap, high-signal for the *focused* nodes.
- For the *rest* of the board: a **board map summary** rather than per-node coords
  — e.g. cluster bounding boxes + relative layout ("cluster A top-left, cluster B
  to its right"), so the model gets the gestalt without a wall of numbers.
- Keep it under the existing `MAX_MESSAGE_CONTEXT_CHARS` budget.

> **My take:** position-in-context is a prerequisite for *any* placement smarts,
> so it should land alongside (or before) placement params — otherwise the model
> is placing blind. But favor a *summary* over raw coordinate dumps.

---

## 8. North star: one authoring surface, drawify as a skill

If `write_note`/`link_notes`/`arrange` get expressive enough (relational + style +
explicit escape hatch), **drawify stops needing to be a separate backend
endpoint** — it becomes a *skill* (progressive-disclosure prompt, like
`learn_generate_mini_app`) that instructs the model to author an explicit diagram
with the same general tools. One surface, less special-casing, and the browser
agent gets drawify-quality output offline (drawify is currently backend-only).

Not a v1 goal, but it's the direction that makes the abstraction "right": every
richer param we add should move us toward *the everyday tools can do what drawify
does*, not toward a second bespoke path.

### 8b. Drawify skill vs. the existing `learn_generate_diagram` skill

Checked `prompts/skills/diagram.md` (101 lines). **They're complementary, not
redundant** — different *intent*, same underlying tools:

| | `learn_generate_diagram` (exists) | drawify skill (proposed) |
|---|---|---|
| Goal | **Structure carries meaning** — a clean linked-note graph | **Compose a picture** — a hand-drawn styled sketch |
| Layout | Delegated to **auto-layout** (parallel `write_note` + `link_notes`, no coords) | **Authored** — relational/explicit placement |
| Style | None — shapes are *semantic* (rectangle/layered-circle/ellipse/diamond) | **Visual** — colors, curved connectors, deliberate placement |
| Reads well as | Mindmap / taxonomy / schema / flowchart | Freeform whiteboard diagram |

So the diagram skill deliberately uses **no** color/position/curve — it trusts
structure + auto-layout. The drawify skill is precisely the one that *exercises*
the new authorship params (§3 placement, §5 color, §5c curve). They'd be selected
for different requests.

**Decision leaning:** yes to a drawify skill, but scope the two crisply so their
routing doesn't collide — diagram = "let structure + auto-layout do the work";
drawify = "hand-compose a styled sketch." The diagram skill's semantic-shape
vocabulary is a good precedent; drawify adds the styling/placement vocabulary on
top of the same `write_note`/`link_notes`.

---

## 9. Phasing + estimates

Ordered by dependency. **LOC = rough net new/changed TypeScript incl. tests, ±50%**
(a sizing signal, not a commitment); excludes this doc and prompt `.md` text.
Complexity reflects *risk/subtlety*, not just size.

| # | Step | Complexity | ~LOC | Depends on | Ships alone? |
|---|---|---|---|---|---|
| S1 | **`BoardMutator` port + `StoreMutator` wrap** (§9c) — decouple tools from `store`, behavior-neutral | Low–Med (mechanical, touches all tools) | ~250 (mostly *moved*) | — | ✅ |
| S2 | **Color params** (§5) — `background_color`/`border_color` via `FAMILIES` enum → `_storedColors` | Low | ~80 | S1 (cleaner) | ✅ |
| S3 | **Link `curve` bend + edge color** (§5c) — relative bend → `midpointToCubicControls` | Low–Med (geometry) | ~100 | S1 | ✅ |
| S4 | **Context enrichment + `BoardReader`** (§7) — `boardEdges`, pos/size/color on focused nodes, board-map summary | Med | ~250 | S1 | ✅ (valuable alone) |
| S5 | **Relational placement + per-mode collision** (§3/§3b) — `near`/`at`, local-nudge vs global-offset | Med–High (collision correctness) | ~250 | S4 | ✅ |
| S6 | **`arrange` tool** (§4) — selective/subtree layout over existing primitives | Med | ~150 | S1 | ✅ |
| S7 | **Headless sync-correct emit** (§6d) — `submitLocalBatch` intake, headless producer, rebase-with-two-producers | **High** (sync spine; ADR-SYNC update) | ~400 + heavy tests | S1 | ⚠️ infra (no user-visible change alone) |
| S8 | **`navigate` / working folder** (§6c) — mutable `rootId`, context re-scope, receipts | Med | ~200 | S7, S4 | ✅ |
| S9 | **`create_folder` + `parent_id`** (§6) — agent authors subfolders, lazy per-layer arrange | Med | ~200 | S7, S8 | ✅ |
| S10 | **Pinned-aware layout** (§4) — ELK-interactive / cola for mixed auto+explicit | **High** (new dep + engine) | ~400 | S5 | only-if-needed |
| S11 | **Drawify-as-skill** (§8b) — skill prompt over the enriched tools; maybe retire the backend endpoint | Low–Med (mostly prompt) | ~100 + prompt | S2,S3,S5 | ✅ |

**Fast, self-contained wins (no dependency on the hard sync work):** S1 → S2 → S3,
then S4. These bank real value (authored colors, curved links, spatial context)
while S7 (the high-risk headless emit) is designed carefully.

**The hard spine:** S7 is the gate for subfolders/working-folder/cross-layer arrange
(S8, S9) — it's the one genuinely risky piece (rebase with two producers), so treat
it as its own milestone with its own review + ADR-SYNC-001 update. Everything after it
is Med at most.

**Rough total** to "everyday tools do what drawify does" (S1–S6, S11, skipping the
subfolder spine): **~1.1k LOC**. Add the subfolder spine (S7–S9): **~+0.8k**. S10 only
if interleaving is actually needed.

---

## 9b. Tool-description wording (drafts)

**Principle:** the tool + param `description`s are compiled into the tool schema,
which is part of the prompt the model reads **every turn**. So they must (a) teach
the three placement modes and the "prefer auto" default, (b) be high-signal, and
(c) NOT bloat — no enumerating all ~23 color names, no restating collision math.
Teach the *intent and the default*, let the model infer the rest.

**Schema shape (LLM-friendly):** avoid a polymorphic `position` union (models
handle it poorly). Use two optional fields — omit both = auto:
- `near?: { node_id, dir: "above"|"below"|"left"|"right", gap?: number }`
- `at?: { x: number, y: number }`

**Draft descriptions (tight):**

- `write_note` (tool): *"Create a note, or fully rewrite one when note_id is
  given. New notes are auto-placed tidily below existing content — only set
  `near`/`at` when you have a specific spot in mind."*
- `near`: *"Place next to an existing note, e.g. a contrast note to the right of a
  claim. Nudged to avoid overlap, staying in that direction. Prefer this over
  exact coordinates."*
- `at`: *"Exact canvas coordinates — advanced/rare. Placed verbatim with NO
  overlap avoidance; omit unless recreating a precise diagram."*
- `background_color` / `border_color`: *"Color by Tailwind family name (e.g.
  amber, sky, rose, slate). Omit for an automatic color."* — name the *scheme* +
  a few examples, not the full list.
- `arrange` (tool, if we add it): *"Tidy the layout of the given notes (or a
  whole folder) into a clean tree/grid/flow. Use after creating or editing notes
  that ended up cluttered."*

The load-bearing sentence in each: **"auto is the default, only override with
intent."** Without it the model over-positions and output gets worse — the exact
failure mode §3 warns about.

---

## 9d. PR grouping

**Recommended: 9 PRs** (+1 conditional S10). Grouping rules: (a) the behavior-neutral
refactor ships alone so "all tests green" *is* the proof; (b) the one high-risk sync
piece ships alone with its own ADR + review; (c) independent enrichments are separate,
small, parallelizable; (d) each PR = one logical change (repo rule).

| PR | Steps | Title | Depends on | Parallel with |
|---|---|---|---|---|
| 1 | S1 | `feat: BoardMutator port + StoreMutator wrap` (behavior-neutral) | — | — |
| 2 | S2 + S3 | `feat: authoring style params (note colors + link curve)` | PR1 | 3,4,5,7 |
| 3 | S4 | `feat: spatial context + BoardReader (boardEdges, board-map)` | PR1 | 2,5,7 |
| 4 | S6 | `feat: arrange tool (selective/subtree layout)` | PR1 | 2,3,7 |
| 5 | S5 | `feat: relational placement + per-mode collision` | PR3 (S4) | 4,7 |
| 6 | S7 | `refactor(sync): headless op emit + submitLocalBatch` (+ ADR-SYNC update) | PR1 | 2–5 |
| 7 | S8 | `feat: navigate / agent working folder` | PR6, PR3 | — |
| 8 | S9 | `feat: create_folder + parent_id authoring` | PR7 | — |
| 9 | S11 | `feat(prompts): drawify skill over enriched tools` | PR2, PR5 | — |
| (10) | S10 | `feat(layout): pinned-aware layout (ELK/cola)` — **only if interleaving is needed** | PR5 | — |

**Parallelism:** PR1 is the gate. Once it lands, **PRs 2, 3, 4, and 6 can all proceed
in parallel** (each depends only on S1) — 6 (the risky sync work) develops alongside
the safe enrichments instead of blocking them. PR5 waits on PR3; PRs 7→8 stack on the
sync milestone; PR9 (drawify skill) waits on the params it exercises.

**If you prefer strict one-feature-per-PR:** split PR2 into color and curve → **10
PRs**. **If you want fewer:** merge PR7+PR8 (working folder + subfolder authoring, both
post-sync) → **8 PRs**. I'd keep them split — the sync milestone (PR6) is where risk
concentrates; everything around it should stay small.

**Suggested merge order:** 1 → (2,3,4 in any order) → 5 → 6 → 7 → 8 → 9. Rebase the
downstream stack after each squash-merge (the `git rebase --onto` flow we've used).

---

## 9c. Step 1 implementation plan — the additive `BoardMutator` wrap

Goal: introduce the port with **zero behavior change.** The agent still writes to the
current layer via the store (undo + persist + sync intact). Pure decoupling — tools
stop touching `store` directly for writes; they call `ctx.board`.

1. **Define the interface** (`engine/board-mutator.ts`), domain verbs, **async-typed**
   so the future headless impl needs no caller re-churn:
   ```ts
   export interface BoardMutator {
     createNote(spec: NoteSpec): Promise<{ id: string }>
     rewriteNote(id: string, spec: NoteSpec): Promise<{ id: string }>  // write_note(note_id)
     patchNote(id: string, patch: { content?: string; label?: string }): Promise<void> // edit/update
     createLink(spec: LinkSpec): Promise<{ id: string }>
     // later: updatePositions(updates), parentId routing, curve, colors
   }
   // NoteSpec = { content; label?; type?; parentId?; position?; colors? }
   // position/colors optional now (default beneathBorderOrigin + randomNoteColors).
   ```
2. **Implement `StoreMutator(store, rootId)`** — move the "how a note/link is born"
   logic currently **inline in the tools** (`noteGeometry`, `randomNoteColors`,
   `canonicalNodeStyle`, `meta()`, `parentId = rootId`, mini-app validation) into ONE
   place, then `store.addNode/updateNode/addEdge` exactly as today. Board bytes: identical.
3. **Thin the tools.** `write_note`/`edit_note`/`create_note`/`link_notes` become
   arg-parse → `ctx.board.*`. `edit_note`'s find/replace stays in the tool (it computes
   the new field value, then calls `patchNote`); the mini-app validation stays a guard.
4. **Wire `ctx.board`** where ctx is built (`use-local-submit-prompt.ts:369`,
   `use-local-transform.ts`): `board: new StoreMutator(store, rootId)`. Keep `ctx.store`
   for reads; writes go through `ctx.board`.
5. **Tests.** `engine/tools.test.ts` builds `ctx = {store, rootId, search}` and asserts
   `store.getNode(...)` after `tool.run`. Add `board: new StoreMutator(...)` via one
   shared helper; assertions are unchanged (StoreMutator writes the same store). **All
   existing tool tests staying green IS the proof of "no behavior change."**

**Explicitly OUT of step 1:** `arrangeCreatedNodes` + the mindmap drain (harness
post-processing — migrate to `updatePositions` later); the headless producer +
`submitLocalBatch`; `parent_id` routing; `navigate`/working folder;
`position`/`color`/`curve` params. Step 1 is *only* "route the agent tools' writes
through a port."

**Why this order:** after step 1 the agent runtime depends on `BoardMutator`, not the
store. Every later capability (headless writes, working folder, cross-layer arrange,
color/curve) becomes "add a `BoardMutator` impl/method" behind the port the agent
already uses. One self-contained, behavior-neutral PR.

---

## 10. Open questions to settle together

1. ~~Raw x/y first-class, or relational + auto with x/y as escape hatch?~~ **DECIDED: Option C** (§3).
2. **`arrange` as a tool** — yes? And which strategies (`tree`/`grid`/`flow`)? (§4)
3. ~~Color: named palette, hex, or both?~~ **DECIDED: reuse existing `FAMILIES` name enum, fixed shade 200 + black text for v1** (§5).
4. **Agent subfolders — working-folder model (§6c) is the chosen direction.** Remaining call: commit to the **v2 headless emit** (the plumbing it needs) now, or ship the v1a lock-based stopgap first for speed? *(leaning: go straight to v2/working-folder — v1a's lock is avoidable and v2 is needed for existing-folder writes + cross-layer arrange anyway.)*
5. **Context: per-node coords vs. board-map summary vs. both?** (§7)
6. **Is "drawify becomes a skill" a goal we design toward, or do we keep it separate?** (§8)

Still open: **2, 4, 5, 6.**
