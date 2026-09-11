# Applet — implementation plan

> Build sequence for the `applet` node type. Design + spec:
> [`applet-design.md`](./applet-design.md) (§ refs below point there).
>
> **Status:** ready to build — all load-bearing specs settled. Participants:
> dev04 + Claude. Mark progress inline; promote durable decisions to an ADR
> (`ADR-APPLET-001`) as phases land.

## Shape of the work

An applet = agent-authored JSX (a restricted, declarative subset) → parsed
client-side by acorn → a serialized tree → rendered **inline** by a bounded
interpreter (no iframe, no `eval`). Ships as a **new node type** (`applet`);
legacy `mini-app` is frozen (render-only, no new creation) → zero migration.

Everything new lives under **`webui/src/features/applet/`** (plus a board
node-type and shared components). Nothing touches the legacy `mini-app` runtime
except to gate creation off.

**Build order is risk-first:** the interpreter's safety (§5.1) is the whole ball
game, so Phase 0 proves it in isolation before any board wiring exists. Ship the
whole feature behind a `dim0_applet` flag (mirrors `dim0_local_agent_on_synced`)
for canary rollout.

---

## Phase 0 — The interpreter core + red-team suite (gating)

The trust boundary. Pure functions, no React, no board — so it can be hammered in
isolation. **Nothing else starts until the red-team suite is green.**

**Deliverables** (`webui/src/features/applet/interpreter/`):
- `eval-expr.ts` — the ESTree-subset evaluator (§8.3): a `switch` over node
  `type`, `safeGet` for member access (§8.4), call dispatch against the method /
  global whitelist (§8.5), arrow binding for HOF methods (§8.6).
- `bind-pattern.ts` — recursive destructuring-param binder (§8.6), reusing
  `safeGet` + escape-key denial.
- `run-action.ts` — action executor over an immer draft (§6.4, §9): the 5 verbs +
  guarded-action form.
- `budgets.ts` — op / depth / array-length / string-length caps (§8.8).

**Tests (the deliverable that matters most):**
- `eval-expr.test.ts` — every allowed node type, operator, whitelisted call.
- `redteam.test.ts` — the escape/DoS fixtures: `constructor` / `__proto__` /
  `prototype` access, `[].constructor.constructor("…")()`, prototype pollution via
  destructuring keys, computed-key escapes, unbounded loops, deep nesting, giant
  strings. **Each must be rejected or bounded.**

**Acceptance:** 100% of red-team fixtures neutralized; budgets provably terminate;
zero access to any host global. This suite is the audit that replaces the iframe —
it's a permanent CI gate, not a one-off.

---

## Phase 1 — The transformer (author-time: JSX → tree)

Turns the agent's source into the §6 tree, and is the source of the same-turn
validation errors (§8.9). Runs client-side (§14.1), pure.

**Deliverables** (`webui/src/features/applet/compile/`):
- `parse.ts` — acorn + acorn-jsx wrapper (spans kept for error line/col).
- `transform.ts` — ESTree → §6 tree: validate against the allowlist, compile
  `.map`→`list` and ternary/`&&`→`cond`, split literal `props` from `bind`,
  handlers→action-AST, strip spans from expr subtrees.
- `validate.ts` — `validateApplet(source): {ok} | {error, line, col}` with the
  precise messages from §8.9 (unknown component/ref/verb, node outside grammar,
  dynamic path, etc.). Supersedes the role of `features/mini-app/validate.ts`.

**Tests:** golden `source → tree` for the 6 dry-run widgets (design §-dry-run);
error-message tests for each rejection class.

**Acceptance:** the 6 widgets compile to the expected trees; every malformed input
yields an actionable `line:col` error.

**Depends on:** Phase 0 (the tree it emits is Phase 0's input contract) + the
registry stub (Phase 2's `registry.ts`, which can be a stub list here).

---

## Phase 2 — Registry, renderer, node type, create-gate

Makes an applet a real board citizen.

**Deliverables:**
- `webui/src/features/applet/registry.ts` — single source of truth (§7):
  components (`Card*`, `Button`, `Chart`, `Graph`, `Map`, **`Table`**) + prop
  schemas, the intrinsic + attribute allowlists, the action verbs, and the prompt
  signatures. (Patterned on the old `mini-app-runtime/scope.ts`.)
- `webui/src/components/charts/` (or `ui/`) — build the new **`<Table>`** (§7),
  shared host↔applet like the existing chart primitives.
- `webui/src/features/applet/renderer.tsx` — `<AppletRenderer source>`:
  parse→tree (memoized cache keyed by source), interpret→React, **per-widget error
  boundary** (§5.3), **containment wrapper** `contain: layout paint; isolation:
  isolate` (§5.2), and persist wiring — hydrate `state` + debounced auto-save when
  `persist` (§9.3).
- `webui/src/features/board/harness/node-types/applet/` — `def.ts` + `view.tsx`
  (mirror `node-types/mini-app/`); register in `board-mutator.ts` (type map +
  default size) and the node-type index.
- **Persist store** — reuse the `mini_app_state` mechanism for `applet` state (or a
  parallel `applet_state`); fix the by-board cascade gap noted in the roadmap while
  here.
- **Create-gate (freeze legacy, §13):** register `note_type:"applet"` in
  `engine/tools.ts` + `board-mutator.ts`; **remove** `mini-app` from the create
  path; keep the legacy `node-types/mini-app` view **render-only** (lazy-load the
  old runtime; on store builds render the §13 placeholder instead of the eval
  path); swap the UI create menu Mini-app→Applet.

**Acceptance:** an applet node renders inline; state persists across reloads; theme
flows without a relay; legacy mini-apps still render on web (placeholder on store
builds); users can no longer create a mini-app.

**Depends on:** Phases 0 + 1.

---

## Phase 3 — Agent surface + real-model authorability test

**Deliverables:**
- `webui/src/features/agent/prompts/skills/applet.md` — the skill (design §10):
  positive-framed palette, the manifest **generated from `registry.ts`**, ported
  worked examples in the new grammar, the same-turn self-correction contract.
- `learn_generate_applet` in `engine/skills.ts`; **remove** `learn_generate_mini_app`.
- Wire `validateApplet` into the `write_note` path for `note_type:"applet"`
  (replaces the `validateMiniAppSource` branch in `engine/tools.ts`).

**Then — the real test of the whole premise (design §3):** prompt a live model with
the skill and have it author ~10 target widgets (counter, todo+filter, quiz,
dashboard, stepper, sortable table, flashcards, poll, calculator, timeline).
Measure first-try validity + self-correction on failure.

**Acceptance:** the model authors the targets cleanly; failures surface actionable
validator errors it recovers from in-turn. **If the model stumbles, fix the grammar/
prompt here — cheap now, expensive after launch.**

**Depends on:** Phase 2.

---

## Phase 4 — Hardening, measurement, ADR

- **Perf** — measure bundle delta + board memory with N applets on one board;
  validate the one open assumption (inline recharts on the main thread, design §5).
- **App Store** — confirm the applet path needs no `unsafe-eval`; verify the legacy
  store-build placeholder; the applet CSP closes FE-F5.
- **Finalize the deferred smalls** — prop-validation strictness (§14.4), `persist`
  granularity (§14.10).
- **Backend** — decide `compile.py`'s fate: client-side parse likely makes the
  server validator redundant → retire, or keep as a thin online double-check.
- **ADR-APPLET-001** — promote the durable decisions (new type + frozen legacy,
  inline/no-eval, JSX-canonical, interpreter-as-boundary).

---

## Cross-cutting

- **Feature flag** `dim0_applet` — gate creation + the node type for canary; flip
  on after soak (mirrors the agent-runtime rollout).
- **CI** — the Phase 0 red-team suite + Phase 1 golden tests are permanent gates.
- **v1 scope** — declarative applets only. Escape-hatch Path C (arbitrary code,
  design §11) and regex (§8.3) are explicitly **out**.
- **Alignment** — applets are frontend-only, reinforcing the north-star browser
  agent (compute on the user's machine); the agent authors them through the same
  `write_note` surface, adjacent to `agent-board-authoring-tools.md`.

## Sequencing at a glance

```
Phase 0 (interpreter + red-team) ──▶ Phase 1 (transformer) ──▶ Phase 2 (node type)
                                                                      │
                                          Phase 3 (skill + model test)◀┘
                                                                      │
                                                        Phase 4 (harden + ADR)
```

Phase 0 is the long pole and the gate; 1–2 are mechanical once it holds; 3 is where
we learn if the premise is true; 4 is launch-readiness.
