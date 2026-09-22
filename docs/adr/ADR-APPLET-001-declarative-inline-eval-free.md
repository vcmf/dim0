# ADR-APPLET-001: Applets are declarative, inline-rendered, eval-free widgets (the interpreter is the sandbox)

**Status:** Accepted · 2026-09-13
**Applies to:** `webui/src/features/applet/**`, `webui/src/features/board/harness/node-types/applet/**`, `webui/src/features/agent/engine/tools.ts` (`write_note`), `webui/src/features/agent/engine/skills.ts`, `webui/src/features/agent/prompts/skills/applet.md`
**Verify:** `cd webui && npm run type-check && npx vitest run src/features/applet && npx eslint src/features/applet`

## Decision

An **applet** is the creatable interactive-widget node type. It replaces the
mini-app's authoring path. Five load-bearing MUSTs:

1. **Declarative source, not arbitrary React.** An applet is a single
   `<Widget state data derived persist>…</Widget>` written in a *restricted
   declarative JSX*: structure over a **fixed component registry** (Card family,
   Button, Chart/Graph/Map, Table + a whitelisted HTML-intrinsic set), values as a
   strict **JS-expression subset**, and behavior as a **closed 5-verb action
   vocabulary** (`set`/`toggle`/`append`/`toast`/`batch`) in event handlers only.
   No `import`, no hooks, no closures-as-handlers.

2. **Compiled client-side, rendered inline, NO `eval`.** Source → §6 tree via
   `acorn` (author-time, offline-capable) → rendered inline as React. There is
   **no iframe and no `eval`/`new Function` anywhere on the applet path.** The
   **bounded interpreter** (`features/applet/interpreter/`) — deny-by-default node
   allowlist, prototype-escape denial (`safeGet`, blocked `__proto__`/`prototype`/
   `constructor`), whitelisted calls, op/depth/size budgets — **is the security
   boundary that replaces the iframe sandbox**, guarded by a permanent red-team
   suite. The only bare-name helper beyond `Number`/`String`/`Boolean` is `cn`
   (pure); global/helper names are reserved and cannot be scope keys.

3. **Source is board content; live state is local-first.** The JSX **source is
   canonical** on `note.content.markdown` and syncs as normal board content
   (server-persisted, cross-device, shared). The compiled tree is a **derived
   cache**. **Live widget state is local-first, per-user, and opt-in via
   `persist`** — persisted through the `StorageEngine` port (IndexedDB / rusqlite),
   keyed by node id, **not** collab-broadcast and **not** sent to the backend today
   (see ADR-SYNC-001 for board content; §5.4 of the design doc for the split).

4. **Legacy `mini-app` is frozen — no migration.** Existing mini-app nodes still
   render and rewrite (their type is preserved), but **no new mini-app can be
   created** — the toolbar offers Applet, `write_note` rejects `note_type:"mini-app"`
   on create, and the agent skill/prompt point at applets. The two node types
   coexist by *type*; nothing converts.

5. **Author-time validation is the same allowlist as runtime.** `write_note`
   validates `note_type:"applet"` via `validateApplet` (acorn + the §8/§9 grammar),
   returning `line:col` so the agent self-corrects in the same turn. The validator
   mirrors the interpreter's allowlist; the residual gaps (value-method-by-receiver-
   type, scope-aware identifier resolution) are documented and backstopped by the
   runtime.

## Why

- **App Store shippability (the headline driver).** No runtime code generation
  means no collision with App Store Review Guideline **2.5.2** ("may not download,
  install, or execute code which introduces or changes features"). The mini-app's
  `sucrase → new Function` required CSP `'unsafe-eval'`; the applet path needs
  none.
- **Offline / local-first / standalone.** Client-side parse + local-first state
  work with no server — required for the standalone Tauri build, which has no
  backend (see the standalone-app plan, ADR-DESKTOP-002).
- **Performance.** Inline React reuses the host bundle (React, recharts, the chart
  primitives) instead of a ~5 MB self-contained iframe per widget; N applets are N
  light React subtrees, not N browsing contexts.
- **Authorability.** A prior YAML-DSL attempt failed because the model couldn't
  author it. This format reads like React (JSX + JS expressions), is validated at
  author-time, and — in a live dry-run — a fresh model authored 8/8 novel applets
  (counter, todo, tip calc, temp converter, poll+chart, quiz, dashboard, table)
  that all compiled first-try.

## Consequences / deferred

- **App-Store legacy placeholder is deferred** until an actual App Store build
  exists. There is no store-build flag today (desktop is notarized Tauri, gated
  only by `isTauri()`). When an iOS/App Store target lands, the legacy mini-app's
  `eval` render MUST be gated off on that build (a static placeholder), since only
  the applet path is 2.5.2-clean.
- **The bundle-size win is not yet realized.** The ~5 MB mini-app runtime is kept
  (render-only) for legacy nodes; it's removed only after legacy usage decays.
- **The inline-recharts-on-main-thread perf assumption is unprofiled.** LOD gating
  (React only above a zoom threshold; a canvas placeholder below) + per-widget
  error boundary bound the common case; a busy-board profile is a follow-up.
- **Cross-device / cross-user state sync** is a future add via the existing
  backend `/mini-app-state` endpoints, if per-device local state proves
  insufficient.
- **The expand surface is read-only (Phase 5).** The node's green traffic-light
  opens an inspect surface (larger Preview + the canonical JSX Source, non-editable
  + downloadable) so an author can see what an on-canvas error came from. **Editing
  the source in-place with live re-validation is a follow-up** — it needs an edit
  buffer, `validateApplet`-on-save with inline `line:col` errors, and a resolution
  of the two-writer race between the panel and the on-canvas node's live state.
- **The agent's feedback loop is compile-only.** `write_note` validates applets via
  `validateApplet` (parse + grammar allowlist) but does NOT run the tree, so runtime
  interpreter errors (e.g. iterating a non-array) reach the user's error boundary
  without ever reaching the agent. A **render smoke-test** — a headless interpret
  pass over the tree with the declared initial state, its message folded into the
  existing `write_note` result (no new tool) — is the planned close of this loop.
- **Smaller open calls:** per-component prop-validation strictness; `persist`
  granularity (whole-state vs per-key); and auto-grow height (fixed-size + internal
  scroll for now).

## Rejected alternatives

- **Keep arbitrary-React mini-apps.** Maximum flexibility, but requires `eval` of
  downloaded code → not App-Store-shippable, and a heavy per-widget iframe.
- **A bespoke YAML/DSL.** Tried before; the model authored it poorly. Reusing the
  JS-expression subset the model already knows is what makes authorability work.
- **Store the compiled tree as canonical.** Rejected: the JSX source is
  human-readable and agent-editable, and the tree is cheaply re-derivable.
