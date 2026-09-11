# Applet — declarative, eval-free, App-Store-shippable widgets (design/spec)

> Build sequence lives in [`applet-implementation.md`](./applet-implementation.md);
> this doc is the design + spec.
>
> **Status:** design settled. The model to build the new `applet` node type.
> Participants: dev04 + Claude. Add takes inline; mark settled points with
> **DECIDED:** and unsettled ones with **OPEN:**.
>
> Ships the declarative system as a **NEW node type, `applet`**, NOT by changing
> `mini-app`. The old `mini-app` type is **frozen**:
> it still renders, but users can no longer create one — so there is **no
> migration** (§13). Promote durable decisions to an ADR (`docs/adr/`) when they
> harden.

## 1. Objective

Turn mini-apps from *"agent writes arbitrary React, the iframe `eval`s it"* into a
**declarative, interpreted** format that:

1. **Ships through the iOS + macOS App Store** — no runtime code generation, so no
   collision with App Store Review Guideline **2.5.2** (an app "may not download,
   install, or execute code which introduces or changes features"). This is the
   headline driver.
2. **Keeps the interactivity that mini-apps actually use** — counters, todos,
   steppers, quizzes, filters, flashcards — without reinventing a programming
   language.
3. **Stays easy for the model to author** — the failure mode of the previous
   YAML-DSL attempt. The authoring surface must look like what the model already
   knows (JSX + JS expressions), inventing as little new grammar as possible.
4. **Is a net performance gain.** Dropping runtime code-gen lets us drop the
   iframe and its **second 5.4 MB bundle + duplicate React** entirely (§5): many
   mini-apps on a board become light React subtrees instead of many iframe
   documents. The revamp is *faster*, not just safer.

Non-goal: preserving *arbitrary* computation (physics sims, canvas games). That's
the escape hatch (§11), not the main path.

## 2. What exists today (the path we replace)

- **Format:** the agent writes a JSX source string with a top-level `Widget`/`App`;
  stored on `note.content` via `write_note(note_type="mini-app", content=<JSX>)`
  (`engine/tools.ts:193`). The tool is unchanged by this revamp.
- **Author-time validation:** `validateMiniAppSource` (`features/mini-app/validate.ts`)
  — sucrase transpile + a regex that a `Widget`/`App` is declared. Mirrored server
  side in `backend/topix/mini_app/compile.py` (Node subprocess, validate-only).
- **Runtime:** a separate Vite build (`vite.mini-app.config.ts`, `viteSingleFile`)
  emits a **5.4 MB** self-contained `/mini-app/index.html`. Loaded into an
  opaque-origin sandboxed iframe (`sandbox="allow-scripts"`); host ↔ iframe over
  postMessage (`features/mini-app/mount.tsx`, `runtime-target.ts`).
- **Compile+run:** inside the iframe, `compile.ts` does `sucrase → new Function(...)`
  and injects a curated scope (`mini-app-runtime/scope.ts`) — `React`, hooks,
  `Card*`/`Button`, `Chart`/`Graph`/`Map`, `cn`, `host`.
- **Prompt:** `prompts/skills/mini-app.md`, delivered as the *output* of the
  `learn_generate_mini_app` skill tool (`engine/skills.ts:29`), progressive-disclosure.
- **The 2.5.2 problem:** the whole path hinges on `new Function` over
  agent-authored source → requires CSP `script-src 'self' 'unsafe-eval'`. That is
  the thing the store forbids.

## 3. The core model — three layers, one invented

**DECIDED:** invent as little language as possible. Reuse the model's native
fluency (JSX structure, JS expressions); only invent the one thing that can't be
safely reused (event behavior). A widget is three layers:

1. **Structure — plain JSX over a fixed component registry.** No invention. The
   model writes `<Card>`, `<Chart>`, `<Button>` as today.
2. **Values — pure JS *expressions*.** `{count}`, `{items.length}`,
   `{done ? "✓" : "○"}`. Side-effect-free, evaluated by a bounded interpreter over
   a **pre-parsed AST** — never `eval`. The model already writes these perfectly.
3. **Behavior — a small closed set of action verbs**, the *only* invented
   vocabulary: `set`, `toggle`, `append`, `toast`, `batch` (§9). 5 words to learn.

State lives in a `state` prop on the root; the rest is React the model already
knows. A counter:

```jsx
<Widget state={{ count: 0 }}>
  <Card>
    <CardTitle>Counter</CardTitle>
    <div className="text-3xl font-bold">{count}</div>
    <Button onClick={set("count", count - 1)}>–</Button>
    <Button onClick={set("count", count + 1)}>+</Button>
  </Card>
</Widget>
```

`{count}` / `count - 1` = pure expressions (safe-eval). `set(...)` = closed action
verb. No arbitrary code, no `new Function`, no `unsafe-eval`.

**Why this beats the YAML-DSL attempt on both failure modes:**

- *Interactivity isn't lost* — the interactive widgets mini-apps use are a small,
  patterned space (`state → view(state) → action mutates state`, the Elm/Redux
  shape). state + expressions + verbs captures all of them.
- *The language stays simple* — via **progressive disclosure**: ~80% of mini-apps
  (charts, dashboards, diagrams, explainers) are pure static composition over
  literal data and touch **zero** of the interactivity layer. Complexity scales
  with the widget, not the format.

## 4. Pipeline — parse once, interpret everywhere

```
AUTHOR TIME (once per widget; pure JS, runs offline — no backend needed):
  agent JSX ──acorn + acorn-jsx──▶ ESTree AST
                                    │ walk once; whitelist-validate against
                                    │ the component + action + expression grammar
                                    ▼
                            serialized tree (JSON): elements + expr-ASTs + action-ASTs

DEVICE / RUNTIME (every open — ZERO parser, ZERO eval):
  JSON tree ──▶ ~200-line interpreter: tree-walk render (registered components)
               + bounded expression evaluator → renders Chart/Graph/Map/Card/…
```

**DECIDED (tech):** `acorn` (8.15) + `acorn-jsx` (5.3) are **already installed**,
pure-JS, ~50 KB gzipped runtime, emit a standard **ESTree** AST — one parse yields
structure (`JSXElement`), values (`BinaryExpression`, `Identifier`, …) and actions
(`CallExpression`) together. Because it's pure JS it runs in the webview **offline**
(critical for the standalone Tauri app, which has no backend). `@swc/core` is
faster but a 27 MB native binary → build/server only, wrong for the webview.

- **Device gets lighter:** no sucrase, no `new Function`. Ships JSON + a tiny
  interpreter + the existing chart primitives (recharts is already a dep). See §5
  for the bigger structural win (dropping the iframe entirely).
- **2.5.2 posture:** the device interprets a *bounded expression grammar*
  (arithmetic, property access, ternary, whitelisted calls) over a fixed AST —
  the spreadsheet-formula / template-engine category, not `eval` of arbitrary
  programs. Right side of 2.5.2, but a **judgment call to state explicitly**;
  §5.1 (the bounded interpreter) is what makes it defensible.

**OPEN:** where the author-time parse runs. Options: (a) host app at author/save
time; (b) reuse the backend Node validator (`compile.py`) online. Leaning **(a)**
so it's uniform online + offline. Either way the parser is **never** in the sandbox.

## 5. Render target — drop the iframe, render inline

**DECIDED (lean, pending prototype):** render mini-apps **inline in the host React
tree**, not in a per-widget iframe. The iframe existed for exactly one reason —
sandboxing `eval`'d agent code. With no code (only data + a bounded interpreter),
that reason is gone, and inline rendering is the single biggest performance lever
in this revamp.

```jsx
<MiniAppRenderer tree={serializedTree} />   // just a host component
```

What this removes:

- the separate **5.4 MB runtime bundle** + its fetch + service-worker runtime cache
- a **duplicate React instance** per widget (the runtime bundles its own React today)
- **recharts + chart/graph/map primitives duplicated** — already in the host bundle
  (`src/components/charts/`), so inline reuses them
- the **iframe browsing context per widget** — the dominant cost on busy boards
  (each iframe is a full document); N widgets become N light React subtrees
- the **postMessage handshake**, the 5s ready-timeout, and the theme relay;
  `host.saveState`/`toast` become direct calls

The whole second Vite build (`vite.mini-app.config.ts`), `mount.tsx`,
`runtime-target.ts`, prefetch, and the cross-origin/single-frontend duality go away
(§12).

> Dropping the iframe moves **three** responsibilities the sandbox used to cover
> for free onto us — but they are not equal. **§5.1 (bounded interpreter) is the
> one genuinely hard, must-be-perfect problem** — it *is* the new security
> boundary. §5.3 (crash containment) is standard React-boundary work. §5.2 turns
> out to be easy once input is constrained — it's layout containment, not style
> isolation. The sections below are the plan of record for each.

### 5.1 The interpreter must be provably bounded *(security — replaces the sandbox)*

The untrusted input is now data, but the interpreter is the new trust boundary. It
must not let a crafted tree climb back to real code, reach host globals, or hang the
main thread.

**Solutions:**
- **Deny-by-default node allowlist.** Evaluate only: `Literal`, `Identifier`,
  `Member`, `Array`/`Object`/`Template` literals, `Unary`/`Binary`/`Logical`,
  `Conditional`, and whitelisted `Call`. Every other ESTree node is **rejected at
  author-time validation** *and* is unreachable at runtime (double gate).
- **Block the escape keys.** On member access, hard-deny `__proto__`, `prototype`,
  `constructor`. Resolve properties with a safe getter that reads own / explicitly
  whitelisted keys only — **never** walk the prototype chain (that's the path from
  any value back to `Function` → arbitrary code).
- **Whitelisted call surface only.** A call's callee must resolve to a fixed
  allowlist: `Math.*` (subset), pure array methods (`map/filter/slice/includes/
  length/join/indexOf/sort` with a pure comparator), string methods
  (`toUpperCase/slice/includes/split/padStart`…), `Number/String/Boolean`
  coercion. No user closures exist in the grammar, so there is nothing arbitrary to
  invoke.
- **No statements, assignment, or `new`** in expressions → an expression cannot
  build unbounded computation. Iteration exists *only* via whitelisted array
  methods (`.map`/`.filter`/… §8.6) over concrete arrays, each length-capped.
- **Budgets guarantee termination.** A per-render op counter (throw past ~100k node
  visits), an array-method iteration cap (~10k), and expression/tree depth caps. No
  pathological tree can freeze the host thread.
- **Actions are interpreted, not run.** `set/toggle/append/…` mutate a state draft
  (immer-style) then commit; no arbitrary side effects are reachable.
- **A red-team fixture suite is a shipping deliverable.** `constructor` /
  `__proto__` escapes, `[].constructor.constructor("…")()`, prototype pollution,
  giant loops, deep nesting — regression tests that must stay green. **This suite
  is the audit that replaces the iframe**; no inline render ships without it.

### 5.2 Layout containment *(keep a widget in its box)*

The iframe era needed full **style isolation** because arbitrary agent code could
write raw `<style>`, global selectors, `* {}` — anything. The declarative
constraint removes that: the agent emits only whitelisted Tailwind *utility*
classes on its own elements + registered components — no raw `<style>`, no global
selectors, no free-form CSS. So the **cascade** threats mostly vanish by
construction:
- *Widget → host* — a utility class only styles the element it sits on; it can't
  reach host elements. Structurally bounded.
- *Host → widget* — this is **desired**: a widget *should* inherit the host's theme
  tokens, fonts, and base resets so it looks native. Not a leak, the feature.

So we don't need cascade isolation (and therefore **not** Shadow DOM). What's left
is a narrower, easy problem: a widget can still use *legitimate* utilities to
escape its box — `fixed inset-0` covering the board, a huge `z-[9999]` floating
over host chrome, overflow spilling onto the canvas.

**Solution — a containment wrapper on `<MiniAppRenderer>`:**
- `contain: layout paint` + `isolation: isolate` → a local stacking + layout
  context; the widget's `z-index` and paint can't escape.
- Because a wrapper with `contain`/`transform` becomes the **containing block**,
  even `position: fixed` inside gets pinned to the widget box, not the viewport —
  neutralizing the `fixed inset-0` escape.
- `overflow: hidden` (or the host's node clip) bounds spill.

That's a few CSS properties on one wrapper — no Shadow DOM, no `adoptedStyleSheets`,
no Tailwind-cross-boundary work. **DECIDED:** containment only. Shadow DOM stays a
noted last resort *only if* we ever loosen the class allowlist to permit arbitrary
CSS (we don't plan to).

### 5.3 Crash containment *(one bad widget can't take the board down)*

The iframe contained a crash in its own document; inline we contain it in JS.

**Solutions:**
- **Per-widget React error boundary** (already the runtime's pattern) around every
  `<MiniAppRenderer>` → a throwing widget shows an error card; the host and sibling
  widgets are unaffected, with a "reload widget" reset (like today's retry).
- **Graceful binding failure.** Wrap each expression / action eval in try/catch: a
  bad binding renders a placeholder + a dev warning rather than throwing through
  React render. Degrade the pixel, not the widget.
- **Async safety.** `saveState` / `toast` are fire-and-forget with their own catch
  — a rejected save toasts, never crashes.
- **The §5.1 budgets double as crash-containment** — a runaway widget is bounded,
  never an infinite host-thread hang.

**Net:** the isolation surface shrinks from *"sandbox arbitrary JS"* to *"one
audited interpreter + containment + error boundaries"* — smaller and testable —
while the performance ceiling rises sharply. It also *strengthens* the 2.5.2 story:
no sandboxed-eval-of-downloaded-code anywhere, just a React component interpreting
data.

## 6. Serialized tree format

**DECIDED.** The cache the transformer emits and the interpreter reads. Two layers:
**structure** uses our own compact nodes (we compile `.map`/ternary into `list`/
`cond`, and raw JSX ESTree is verbose); **expressions** keep the **ESTree subset
verbatim** (spans stripped) so the evaluator is a bog-standard ESTree walker and
the transformer is mostly validate-and-strip, not rewrite.

### 6.1 Envelope

```jsonc
{
  "v": 1,                              // format version (migrations)
  "scopes": {
    "state":   { "count": 0 },         // literal JSON (§8.1)
    "data":    { "questions": [] },    // literal JSON, optional
    "derived": { "total": <expr> }     // name → expr-AST, optional
  },
  "persist": true,                     // optional (§9.3)
  "root": <node>                       // the <Widget>'s single child
}
```

The `<Widget>` element itself is not a node — it *is* the envelope (its
`state`/`data`/`derived`/`persist` props become `scopes`/`persist`; its one child
becomes `root`).

### 6.2 Structure nodes (`k` = kind)

| Kind | Shape | From |
|---|---|---|
| `el` | `{ k:"el", tag, props?, bind?, on?, children? }` | a JSX element |
| `txt` | `{ k:"txt", v:"literal" }` **or** `{ k:"txt", x:<expr> }` | text child |
| `list` | `{ k:"list", src:<expr>, item:"t", index?:"i", tpl:<node> }` | `src.map((t,i)=><tpl>)` |
| `cond` | `{ k:"cond", test:<expr>, then:<node>, else:<node>? }` | `test ? <a> : <b>` / `test && <a>` |

- `tag` — a registry component (`"Card"`, `"Chart"`) or a whitelisted intrinsic
  (`"div"`); the interpreter looks it up in the registry (§7), else treats it as an
  intrinsic, else errors.
- `props` — **literal** attributes only (`{ "className":"p-4", "kind":"bar" }`).
- `bind` — attributes whose JSX value was an expression: `propName → <expr>`,
  evaluated per render.
- `on` — event → handler: `{ "click": <action>, "change": <action> }` (§6.4).
- `children` — ordered `[<node>…]`. `list`/`cond` appear here like any child.

### 6.3 Expression AST (`<expr>`)

The §8 ESTree subset, spans stripped, node `type`s kept verbatim so a standard
evaluator handles it: `Literal`, `Identifier`, `TemplateLiteral`, `ArrayExpression`,
`ObjectExpression` (+ `SpreadElement`), `MemberExpression`, `UnaryExpression`,
`BinaryExpression`, `LogicalExpression`, `ConditionalExpression`, `CallExpression`,
`ArrowFunctionExpression` (HOF position only). Nothing else validates in (§8.3). An
`ArrowFunctionExpression` whose body is JSX is *not* an expr — the transformer
lifts it into a `list` node instead.

### 6.4 Action AST (`<action>` — handlers only)

```jsonc
// verb:  set/toggle/append take a STATIC path string (§9.1), then expr args
{ "do": "set", "path": "count", "arg": <expr> }
{ "do": "toggle", "path": "open" }
{ "do": "append", "path": "items", "arg": <expr> }
{ "do": "toast", "arg": <expr>, "level": "info" }
{ "do": "batch", "actions": [ <action>, … ] }
// guarded action (§9.2):  `cond && a`  →  else omitted;  `cond ? a : b`
{ "guard": <expr>, "then": <action>, "else": <action>? }
```

`path` is a validated static string (never an expr) — the footgun gate from §9.1.

### 6.5 Worked example — the counter compiles to

```jsonc
{
  "v": 1,
  "scopes": { "state": { "count": 0 } },
  "persist": true,
  "root": { "k":"el", "tag":"Card", "children": [
    { "k":"el", "tag":"CardTitle", "children":[ {"k":"txt","v":"Counter"} ] },
    { "k":"el", "tag":"div", "props":{"className":"text-3xl"},
      "children":[ {"k":"txt","x":{"type":"Identifier","name":"count"}} ] },
    { "k":"el", "tag":"Button",
      "on":{ "click":{ "do":"set", "path":"count",
        "arg":{"type":"BinaryExpression","operator":"-",
               "left":{"type":"Identifier","name":"count"},
               "right":{"type":"Literal","value":1}} } },
      "children":[ {"k":"txt","v":"–"} ] },
    { "k":"el", "tag":"Button",
      "on":{ "click":{ "do":"set", "path":"count",
        "arg":{"type":"BinaryExpression","operator":"+",
               "left":{"type":"Identifier","name":"count"},
               "right":{"type":"Literal","value":1}} } },
      "children":[ {"k":"txt","v":"+"} ] }
  ] }
}
```

### 6.6 Interpreter reads it as

- `el` → `createElement(registry[tag] ?? tag, { ...props, ...evalBinds(bind), ...wrapHandlers(on) }, children)`
- `txt` → `v`, or `String(eval(x))`
- `list` → `eval(src)` → for each `(item,i)` push into env, render `tpl`, auto-key
  by `item.id ?? i`
- `cond` → `eval(test)` ? `then` : (`else` ?? null)
- handlers → on event, run the action against an immer draft of `state`, commit,
  auto-save if `persist`

No node holds executable code; every leaf is data or a validated AST. This is the
`§5.1` interpreter's entire input contract.

## 7. Component registry

**DECIDED:** keep the `scope.ts` pattern — one registry is the **single source of
truth** for (a) what the interpreter can render, (b) what the validator allows, and
(c) what the prompt advertises (generated, never drifts). Today's inventory carries
over unchanged (all already exist as shared host↔iframe primitives in
`src/components/charts/` + `ui/`):

| Category | Components |
|---|---|
| Layout/UI | `Card`, `CardHeader`, `CardTitle`, `CardContent`, `CardFooter`, `Button` |
| Chart | `<Chart>` (bar/line/area/scatter/pie/composed) |
| Graph | `<Graph>` (force/tree/manual node-link) |
| Map | `<Map>` (world choropleth + markers) |
| Data | `<Table>` (columns + rows, optional sortable) — **new** (dry-run: building tables from raw `<table>` intrinsics is verbose; a first-class component bakes in theming + sort) |
| Intrinsics | a deliberate HTML whitelist (below); raw `<table>` family still available for custom layouts |

**Intrinsic whitelist** *(dry-run finding: the table widget needed the table
family).* Allowed: structural `div span p ul ol li`, headings `h1`–`h6`, table
`table thead tbody tr th td`, text `b i em strong small code pre kbd br hr`, media
`img`, and form controls `input textarea select option label button`. **Excluded
by design:** `a` (navigation), `script`/`style`/`iframe`/`object`/`embed`,
`form`'s native submit, and any event/URL attrs beyond the curated handler +
`src`/`alt`/`href`-less set. Attributes are also allowlisted (`className`, `type`,
`placeholder`, `value`, `checked`, `disabled`, `colSpan`, …; **no** `style`,
`dangerouslySetInnerHTML`, `on*` except the §9.2 handlers).

- **Auto-`key` on `.map` lists** — the runtime keys list children (by item `id` if
  present, else index); the model never writes `key`.

Adding a component = one registry entry (value + prop schema + prompt signature),
same ergonomics as today. **OPEN:** prop schemas — do we validate props per
component (Zod), and how strict (reject unknown props vs pass-through)?

## 8. State, bindings & the expression grammar

This is the load-bearing spec: it is simultaneously the interpreter's safety
boundary (§5.1) and the surface the model authors against. **Design rule: a strict
subset of real JS expressions — everything valid here means exactly what it means
in JS, so the model is never surprised. We only ever *remove*, never redefine.**

### 8.1 The three declaration scopes

A `<Widget>` declares up to three named scopes on its root — this is the real
React `const x = …` at the top of a component, split by mutability. *(Dry-run
finding: `state`-only was insufficient — constant data like quiz questions or table
rows had nowhere to live but `state`, which is wrong.)*

| Scope | Mutable? | Persisted? | Recomputed? | For |
|---|---|---|---|---|
| `state={{…}}` | yes (via §9 actions) | only if `persist` (§9.3) | — | interactive state: `count`, `items`, `draft` |
| `data={{…}}` | no | never | once at mount | constants: quiz questions, table rows, chart data |
| `derived={{…}}` | no | never | when its inputs change | computed-from-state/data, memoized: `current: questions[i]` |

- `state`/`data` values are literal JSON. `derived` values are **expressions**
  (§8.2–8.5) over `state` + `data` — the one place a declaration holds an
  expression, memoized so `questions[i].q` isn't repeated five times.
- All three are optional; a static widget is `data`-only, a counter is `state`-only.

An expression may appear in four places, all evaluated against the current
environment (§8.2):
- **value bindings** — a prop or child: `{count}`, `{items.length}`, `{done ? "✓" : "○"}`
- **`.map(...)` element lists** (§8.6) — `{items.map(t => <li>{t.text}</li>)}`
- **`derived` values** — `{ total: revenue.reduce((a,b)=>a+b, 0) }`
- **action arguments** (§9) — the `expr` in `set("count", count - 1)`

### 8.2 The environment (identifier resolution)

An `Identifier` resolves, in order, against:
1. **arrow/map params** in scope (§8.6) — e.g. `t`, `i`
2. **`derived` keys**, then **`data` keys**, then **`state` keys** (§8.1)
3. **`$event`** — inside an action only (§8.7)
4. **the global allowlist** — `Math`, `Number`, `String`, `Boolean`, `Object`
   (keys/values/entries only), `Array` (isArray only)

Anything else is an **author-time error** — `undefined reference 'foo' (in scope:
count, items, questions)`. Catching typos before render is both a safety gate and a
big authorability win. (`derived` may reference `data`/`state` but not other
`derived` keys in v1 — no dependency graph; keep it flat.)

### 8.3 Allowed node types (deny-by-default allowlist)

| ESTree node | Allowed | Notes |
|---|---|---|
| `Literal` | ✅ | string, number, boolean, null. No regex, no bigint |
| `Identifier` | ✅ | resolved per §8.2; unknown → error |
| `TemplateLiteral` | ✅ | no *tagged* templates |
| `ArrayExpression` / `ObjectExpression` | ✅ | incl. `SpreadElement` (for immutable updates: `[...items, x]`). Object: `init` props only — no getters/setters/methods/computed-escape keys |
| `MemberExpression` | ✅ | `a.b` and `a[b]`; optional `a?.b`. Key rules in §8.4 |
| `UnaryExpression` | ✅ | `!`, `-`, `+`, `typeof`, `~`. **Deny** `delete`, `void` |
| `BinaryExpression` | ✅ | `+ - * / % **`, `< <= > >= === !== == !=`, bitwise. **Deny** `in`, `instanceof` |
| `LogicalExpression` | ✅ | `&&`, `\|\|`, `??` |
| `ConditionalExpression` | ✅ | ternary — the main conditional idiom |
| `CallExpression` | ✅* | only Form A/B in §8.5; optional `?.()` ok |
| `ArrowFunctionExpression` | ✅* | only as a higher-order-method arg (§8.6) |
| `JSXElement` | ✅ | in binding / ternary-branch / `.map`-return position → compiled to an element node, not evaluated as data |
| `SpreadElement` | ✅ | in array/object/call-arg position only |

**Explicitly denied** (author-time error, and unreachable at runtime):
`AssignmentExpression`, `UpdateExpression` (`i++`), `SequenceExpression` (comma),
`NewExpression`, `ThisExpression`, `FunctionExpression`, `Super`, `AwaitExpression`,
`YieldExpression`, `ImportExpression`, tagged templates. → no mutation, no `this`,
no constructors, no async, no free functions.

### 8.4 Member access & the escape-key rule *(the security crux)*

`MemberExpression` evaluates to a **data value only** — own/enumerable properties
of plain objects & arrays, plus `length`. It is the one place a crafted tree could
climb to real code, so:

- **Hard-deny keys `__proto__`, `prototype`, `constructor`** — statically (Literal
  key) at author time, and dynamically (computed key resolving to one) at runtime →
  throw.
- Resolve via a `safeGet(obj, key)` that reads **own enumerable props only** and
  **never walks the prototype chain**. (Prototype-chain access is the path from any
  value to `Function` → arbitrary code.)
- **Methods are never first-class values.** `arr.map` on its own is not "read the
  map function" — it's invalid outside call position. Method names resolve *only*
  inside a `CallExpression` (§8.5), dispatched to **our** implementation. The
  interpreter never hands out a real function reference.

### 8.5 Calls — the method / function whitelist

A `CallExpression` is valid only in one of two forms; anything else is an error.

**Form A — method on a value** `value.method(args)`, method ∈ the type's whitelist
(all pure / non-mutating; mutating variants are excluded):

| Type | Methods |
|---|---|
| Array | `map filter find findIndex some every includes indexOf slice at concat join reduce flat flatMap sort*` (`sort` copies first — never in-place) |
| String | `toUpperCase toLowerCase slice substring includes indexOf startsWith endsWith split trim padStart padEnd replace† repeat‡ at charAt` |
| Number | `toFixed toString`‡ |

† `replace` with string args only (no global-regex side effects).
‡ `repeat`/`padStart`/`toString(radix)` are length-capped (§8.8).

**Form B — global function** from the §8.2 allowlist: `Math.{abs min max round floor
ceil sqrt pow sign trunc hypot log clamp?}`, `Number/String/Boolean(x)`,
`Array.isArray(x)`, `Object.{keys values entries}(x)`.

**Denied on purpose:** `Math.random`, `Date.now`, any I/O — expressions are
**deterministic** (§8.10). No callee outside Form A/B is reachable.

### 8.6 Restricted arrows + lists via `.map` *(resolves the old "lists" OPEN)*

The model's native way to render a list is `{items.map(t => <li>{t.text}</li>)}`.
We support exactly that, safely, by allowing arrows **only as a direct argument to
a whitelisted higher-order method** (`map filter find findIndex some every reduce
sort flatMap`):

- params: identifiers **and destructuring patterns** — `t`, `(t, i)`,
  `({ id, text })`, `([a, b])`, with defaults (`({ done = false })`) and rest
  (`({ id, ...rest })`). This is how the model actually writes `.map`/`.filter`,
  so it's table stakes, not bloat. Bound by a recursive `bindPattern(pattern,
  value, env)` that reuses `safeGet` and applies the §8.4 escape-key denial to
  object-pattern keys — patterns only *name* already-safe values, adding no new
  read surface. (Param defaults are ESTree `AssignmentPattern`, allowed **only** in
  param position — distinct from the denied `AssignmentExpression`.)
- body: a **single expression** (or a `JSXElement`) — no block/statements.
- the arrow is created and invoked **only by our own method implementation**,
  synchronously, never stored or returned — so it cannot escape.

At author time, `source.map(param => <JSX>)` compiles to an internal **list node**
(iteration source expr + item param + element template), so list rendering is one
uniform mechanism. **DECIDED:** this supersedes the earlier `<For>` idea — `.map`
is what the model already writes, so we don't invent a component. (`<For>` may
return later as optional sugar; not v1.)

### 8.7 The `$event` object (inside actions only)

Event handlers get a **sanitized** `$event`, never the raw DOM event — curated
safe fields only: `$event.value` (input value), `$event.checked` (checkbox),
`$event.key` (keydown). e.g. `onChange={set("draft", $event.value)}`,
`onKeyDown={$event.key === "Enter" && append("items", state.draft)}`.

### 8.8 Runtime budgets (termination guarantee)

Author-time can't know data sizes, so the evaluator enforces:

| Budget | Cap (tune) | On breach |
|---|---|---|
| ops per binding eval | ~50k node-visits | throw → graceful degrade |
| AST / recursion depth | ~64 | throw |
| array method input length | ~10k | throw |
| string `repeat`/`pad`/`toString` result | ~100k chars | throw |

These guarantee every expression terminates and cannot freeze the host thread —
the §5.3 crash-containment backstop.

### 8.9 Validate-time vs runtime split

- **Author-time (`validate.ts`, §12):** structural — every node in the allowlist,
  every identifier resolves (§8.2), every call is Form A/B, static escape-key
  denial, arrows only in HOF position. Precise `line:col` errors → same-turn
  model self-correction.
- **Runtime (interpreter):** dynamic — computed-key escape denial, `safeGet`,
  budgets, and graceful degradation on any throw (§5.3).

### 8.10 Determinism

No `random`, no clock, no I/O → **same tree + same state ⇒ same render.** Keeps
re-renders stable (bindings re-evaluate every render), makes widgets snapshot- and
golden-testable, and shrinks the security surface.

## 9. Actions (the only invented vocabulary)

Actions appear **only** in event-handler props (`onClick`, `onChange`,
`onKeyDown`, `onSubmit`, …). They're parsed to action-ASTs, never executed as code.
`expr` args are §8 expressions evaluated at event time against `state` + `data` +
`derived` + `$event`.

### 9.1 The verb set — small, orthogonal, footgun-free

**DECIDED (revised after the dry-run):** five verbs. Dropped `increment` (redundant
with `set(p, n+1)`) and **`remove`/index-`toggle`** — the dry-run showed
index-based array mutation is a **trap**: under `.filter()`/`.sort()` the `.map`
index ≠ the source index, so `remove("items", i)` deletes the wrong row.

| Verb | Meaning |
|---|---|
| `set(path, expr)` | set `state.<path>` to the evaluated expr |
| `toggle(path)` | flip a boolean at `state.<path>` |
| `append(path, expr)` | push to an array at `state.<path>` (index-free → safe) |
| `toast(expr, level?)` | transient host message |
| `batch(a, b, …)` | run several actions in one commit |

- **`path` is a static string-literal dotted path** (`"count"`, `"user.name"`) —
  **never** a runtime-built/index path (`"items." + i + ".done"` is rejected at
  author time). This structurally removes the index footgun.
- **Array *element* edits use `set` with an immutable expression keyed by identity**,
  not an index. This is the safe React idiom and it's already in-grammar:

  ```jsx
  onChange={set("items", items.map(x => x.id === it.id ? { ...x, done: !x.done } : x))}
  onClick={set("items", items.filter(x => x.id !== it.id))}   // "remove"
  ```

  → list items should carry a stable `id`. The prompt (§10) teaches this pattern
  explicitly so the model reaches for it instead of index paths.

### 9.2 Handler grammar — "guarded actions"

*(Dry-run finding: `$event.key === "Enter" && …` appeared in every input.)* A
handler is not a bare action but a small **guarded-action** form:

- a single action: `onClick={set("i", i + 1)}`
- a guarded action: `onKeyDown={$event.key === "Enter" && append("items", draft)}`
- a branch: `onClick={picked === null ? set("picked", o) : toast("locked")}`
- a group: `onClick={batch(append("items", {id: nextId, text: draft}), set("draft", ""))}`

Guards/conditions are §8 expressions; the leaves are §9.1 verbs. `&&`/ternary here
choose *whether/which action runs*, evaluated only on the event — no action fires
at render. `$event` is the sanitized event (§8.7).

### 9.3 Persistence — a flag, not a verb

*(Dry-run simplification.)* `<Widget state={…} persist>` → the runtime hydrates
`state` from saved state at mount and auto-saves (debounced) on every change. No
`saveState()` verb, no manual `host.initialState ?? x` dance. Ephemeral widgets omit
`persist`. **OPEN:** whole-`state` persist vs per-key (`persist="items"`) — lean
whole-state for v1.

## 10. Prompting (first-class — not an afterthought)

The revamp is **half runtime, half prompt.** A format the model can't author well
is worthless. The prompt work:

- **Write a new `prompts/skills/applet.md`** — delivered as the output of a new
  `learn_generate_applet` tool (patterned on `skills.ts:29`); progressive disclosure
  stays. The old `mini-app` skill/tool is removed (§13). It teaches: "compose from
  these components; values are
  expressions; behavior is these verbs; you are **not** writing free-form React."
- **Generate the registry manifest into the prompt** (today's `renderScopeManifest()`
  idea) so the advertised vocabulary is exactly the interpreter's vocabulary — zero
  drift when we add a component/verb.
- **Worked examples carry the load.** Port the current examples (counter, todo,
  stepper, charts, graph, map) into the new format so the model pattern-matches.
  The counter/todo/stepper examples prove the interactivity story.
- **Frame the constraint positively.** Not "you may not use X" (the current skill's
  long "always reject" list) but "here is the full palette; anything on it is
  guaranteed to render and theme." Reduce the model's search space.
- **Tighten the self-correction loop.** The new validator (§4) returns precise,
  actionable errors (unknown component, bad prop, undefined state ref, unknown
  verb, expression outside grammar) with line/col, so the model fixes it **in the
  same turn** — far more reliable than "hope the JS runs." A concrete win over
  today's opaque runtime failures.

**OPEN:** how much of the old JSX muscle memory to lean on vs. signposting the
differences. The closer the examples read to real React, the better the model does
— but the `state`/verb layer must be unmistakable.

## 11. Escape hatch (Path C) — optional, later

For the rare widget that genuinely needs arbitrary code, keep a `note_type` that
maps to the *old* code path (sucrase + iframe eval) — but **disabled/degraded on
App Store builds** (branch on `isTauri()` + a store-build flag). Web + notarized
desktop keep full power; the store build shows a "not available in this app"
placeholder. **OPEN:** ship C in v1, or land the declarative path first and add C
only if real demand appears? Leaning **defer**.

## 12. Seams to change (implementation surface)

| Seam | File | Change |
|---|---|---|
| Author-time validate + emit tree | `features/mini-app/validate.ts` | acorn parse → grammar-validate → serialized tree (replaces sucrase+regex) |
| Backend validate (online) | `backend/topix/mini_app/compile.py` | mirror the new validator, or retire if author-time moves fully client-side |
| New node type + create gate | `engine/tools.ts`, `engine/skills.ts`, `board-mutator.ts`, UI create menu | register `note_type:"applet"`; **remove** the `mini-app` create path + `learn_generate_mini_app` (freeze legacy, §13) |
| **Render target** | new `features/applet/renderer.tsx` (inline); old `mini-app/mount.tsx` + `runtime-target.ts` + `vite.mini-app.config.ts` KEPT render-only | new type renders inline (§5); the 5.2 MB iframe runtime loads **only** when a legacy node renders (lazy, disabled on store builds) — a shrinking tail, off the hot path |
| Interpreter (new) | new `features/applet/interpreter/` | tree-walk render + bounded expression/action evaluator + budgets (§5.1); red-team suite alongside |
| Registry | new `features/applet/registry.ts` (patterned on `scope.ts`) | components + prop schemas + action verbs + prompt signatures, single source of truth |
| Prompt | new `prompts/skills/applet.md` + `learn_generate_applet` | new skill for the declarative format; generate manifest from registry. Old `mini-app.md`/skill removed |
| Note content | `note.content` | **OPEN:** store canonical JSX source (parse on load) vs the serialized tree (parse once). Leaning **JSX source canonical**, tree derived/cached — keeps content human-readable + agent-editable and minimizes agent-facing change |
| CSP | host CSP + FE-F5 | inline render drops `'unsafe-eval'` and the separate-origin runtime; `connect-src` on the host governs the widget → closes FE-F5 |

## 13. New node type + frozen legacy (no migration)

**DECIDED:** ship as a **new node type with a new name** (`applet`),
not by changing `mini-app`. Migration becomes a non-event:

- **Legacy `mini-app` nodes are frozen** — they still render (via the old iframe
  runtime, kept **render-only**), but **users can no longer create them**: the
  `learn_generate_mini_app` skill + the `note_type:"mini-app"` create path are
  removed from the agent tools and the UI create menu. Existing boards are
  untouched; nothing re-parses or converts.
- **The new type is the whole §3–§10 system** — inline, interpreted, App-Store-safe,
  with its own `learn_generate_applet` skill and `note_type:"applet"`.
- **Two runtimes coexist by node *type*, not by a validation fork** — cleaner than
  the earlier "route failed-validation notes to the old path" idea (dropped).
- **App Store builds:** the old runtime uses `eval`, so on store builds a legacy
  `mini-app` node renders a static "not available in this app" placeholder (same
  gate as §11) and never loads the eval path. Legacy mini-apps were authored on the
  web and are a shrinking tail; all new content is the safe type.

## 14. Open decisions (rolled up)

1. ~~Parse location~~ → **settled: host/client** (author-time + on load), so it
   works offline in the standalone app; never backend-only.
2. ~~Canonical storage~~ → **settled: JSX source is canonical** on `note.content`;
   the compiled tree is a regenerated cache (agent edits the source naturally,
   re-derivable if the format changes). acorn is cheap + author-time (§4).
3. ~~Lists/derived data~~ → **settled (§8.6): `.map` with a restricted arrow**
   (what the model already writes); `<For>` dropped from v1.
4. Prop validation strictness per component.
5. ~~Action verb core~~ → **settled (§9.1): 5 verbs** (`set/toggle/append/toast/
   batch`), static paths only, array edits via immutable `set`.
6. Ship escape hatch (C) in v1? *Lean: defer.*
7. ~~Legacy migration~~ → **settled (§13): new node type + new name, old `mini-app`
   frozen (render-only, no new creation), zero migration.**
9b. ~~New node-type name~~ → **settled: `applet`** (`note_type:"applet"`,
   `learn_generate_applet`, UI label "Applet").
10. `persist` granularity — whole-state vs per-key (§9.3). *Lean: whole-state.*
11. Regex literals — deferred to v2 on ReDoS grounds (§8.3); revisit with a
    safe-regex validator or timeout.
8. **Render target: inline vs keep-iframe (§5).** *Lean: inline — the perf lever.*
9. ~~Style isolation~~ → **settled (§5.2): layout containment only, no Shadow DOM**
   (the class allowlist removes the cascade threat).

## 15. Next steps

- [x] Settle §8 expression grammar. → **specced.**
- [x] Settle §6 tree format. → **specced.**
- [ ] **Write the implementation plan** — all load-bearing specs (§5, §6, §8, §9)
      and decisions (§14) are settled; ready.
- [ ] **Prototype inline render + the §5.1 bounded interpreter and its red-team
      suite — the gating security work; nothing ships inline without it.**
- [ ] Add the §5.2 containment wrapper (small; no open question left there).
- [ ] Draft the new `applet.md` skill with ported examples; dry-run a real model on
      5–10 prompts to test authorability (the real test of §3's premise).
- [ ] Measure device bundle + board-memory delta (expect a large drop from removing
      the iframe + sucrase + duplicate React).
