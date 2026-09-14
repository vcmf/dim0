# Applet rendering: all-canvas rich elements + whole-applet snapshot

> **Status:** proposal, for review before implementation. Participants: dev04 +
> Claude. Targets `epic/applet` (where the applet render code lives). Promote the
> durable decision to an ADR once the shape is agreed.
>
> Supersedes the narrower "migrate Chart → Chart.js" framing: the research below
> shows the real move is **standardize every rich element on canvas and snapshot
> the whole applet to an image** — Chart→Chart.js is one of four element decisions,
> and the load-bearing piece is the whole-applet capture.

## 0. Frame — why this is a board-architecture decision, not a chart-library preference

The board is **Excalidraw shapes + notes + applets**. Applets are the precious
part — they're how the board grows *rich* elements (charts, graphs, maps, tables,
interactive widgets) instead of just drawings and text. But that richness is also
the **heaviest** thing on the board, and two board-wide capabilities are gated on
it:

1. **Export-to-image.** Excalidraw shapes rasterize trivially; notes take some
   effort; **applets are the blocker.** A whole-board export can't ship until
   applets have a fast, reliable path to a static image.
2. **Performance at scale (the hard blocker).** A board can hold **hundreds** of
   applets. The old mini-app made each one a **sandboxed iframe**. On Chrome that's
   survivable — iframes get their own processes/threads, so the board stays smooth.
   On **WebKit — Tauri's default engine on macOS and Linux** — rendering is
   effectively **single-process / single-threaded**, and hundreds of live heavy
   subtrees (iframes then, live SVG charts now) make it **horrible**. Unlike
   Excalidraw shapes (so light they need no placeholder), applets **must** degrade
   to a cheap static representation when they're not the one you're touching.

Both capabilities reduce to the same primitive: **turn a *whole applet* into a
static image, fast, and cheaply.** So each rich element must be chosen for **(a)
bundle weight and (b) how cleanly it rasterizes inside a whole-applet snapshot** —
*before* aesthetics or API taste.

**Priority #1 is therefore: lightweight + fast, reliable whole-applet `toImage`.**
Everything below follows from that.

## 1. Why the current SVG stack fails priority #1

Today `Chart` is recharts (SVG) and `Graph`/`Map` are hand-rolled **SVG**. Against
the two must-haves, SVG is the wrong substrate:

- **SVG doesn't snapshot cleanly.** DOM-to-image tools rasterize a subtree by
  cloning it into an SVG `<foreignObject>` and painting to canvas. An SVG element is
  **re-rasterized inside that foreignObject** — exactly where WebKit's font-
  substitution and layer-positioning bugs bite (WebKit #83189/#23113). So our
  richest elements are the *least* reliable to capture, on the engine we care about.
- **recharts is heavy + slow.** ~190 KB gz, and v3 pulls in **Redux Toolkit +
  react-redux + immer + d3 (`victory-vendor`)** internally; SVG also creates a **DOM
  node per data point** — a DOM explosion across hundreds of charts.

## 2. The plan in one line

**Render every heavy rich element to `<canvas>`, and snapshot the whole applet
subtree to an image with snapDOM.** Two pillars:

- **Pillar A — all-canvas rich elements.** Chart → Chart.js; Graph → our layout,
  canvas render; Map → our projection, canvas render. Canvas because a live
  `<canvas>` captures **cleanly and deterministically** in DOM-to-image (the libs
  read `canvas.toDataURL()` and inline it — no foreignObject re-render, no WebKit
  font/positioning bugs), *and* it renders faster at scale.
- **Pillar B — whole-applet snapshot.** One `snapshotApplet(root) → dataURL` via
  **snapDOM**, used for both the LOD placeholder (perf) and board export. This is
  the load-bearing piece; the element choices exist to make *this* fast + reliable.

## 2.1 Composability model — DOM composes, canvas rasterizes per leaf, snapDOM flattens

Composability is the precious property, so it dictates the design: **we do NOT
render an applet to one big canvas** (that would force us to reimplement HTML layout
— grids, text wrap, Cards — on canvas and destroy composability). Instead, three
cleanly separated layers:

1. **Composition = HTML/CSS (unchanged).** The interpreter renders the applet tree
   to DOM; each rich element (`Chart`/`Graph`/`Map`) is a **`<canvas>` leaf in the
   flow, exactly like an `<img>`**. Cards, grids, flex, text, tables, and multiple
   rich elements nest freely — the *authoring grammar is identical to today*.
2. **Per-leaf rendering = canvas.** Each rich element is a self-contained black box
   that renders itself into **whatever box the layout hands it** (fit-to-box at
   `× devicePixelRatio`). Elements never know about each other; the DOM composes
   them.
3. **Flatten = snapDOM.** A snapshot walks the whole subtree and stitches it into
   ONE image: every **HTML box** via the foreignObject clone at its laid-out
   position, every **`<canvas>`** via `toDataURL()` pixels at its laid-out position.
   The composed layout is preserved exactly.

**Two states, one composition:**
- **LIVE** — the full React/DOM tree: HTML + N live canvases, fully interactive.
  Shown when focused / at-rest / near 1:1 zoom.
- **SNAPSHOT** — a single `<img>`: a snapDOM raster of that *exact composed DOM*.
  Static, cheap. Shown zoomed-out / off-screen / on a hundreds-of-applets board.

The snapshot is a photograph of the live composition, so the layout is identical in
both; you swap live↔snapshot on focus/interaction and zoom. Moving each leaf to
canvas makes this flatten *more* reliable the more you compose (canvas captures
deterministically; SVG re-rasterizes in foreignObject and hits WebKit font/
positioning bugs — the current fragile case).

### Sizing & the ResizeObserver cost (why it's cheap here)
Canvas doesn't auto-size, so a canvas leaf must know its box — but the cost is far
smaller than it looks, by construction:
- **ResizeObserver only fires on a real content-box change** — *not* on board
  pan/zoom (those are CSS transforms; the element's own box is unchanged), and not
  continuously. So there is no per-frame observer storm during navigation.
- **The snapshot model bounds it to the *few* live applets.** Hundreds of applets
  are static `<img>` — no observer, no canvas, no redraw; they scale for free. Only
  the handful of live applets carry observers.
- **Applets are fixed-size for v1** (auto-grow deferred), so the *outer* size comes
  from the board's node-dimension store (a prop), not observation — ResizeObserver is
  needed only for *internal* responsive boxes (e.g. a chart in a `grid-cols-3` cell).
- **The redraw (not the observe) is the real cost, and it's rAF-throttled** — one
  redraw per frame max, inheriting the mini-app view's existing pattern.
- **Best case: resize shows the scaled snapshot, redraws live only on settle** — so
  a drag-resize scales an `<img>` (free) and does exactly one live redraw when the
  drag ends. Zero redraw-during-drag.

Net: cheaper than the old mini-app iframe resize (which round-tripped over
postMessage), and bounded to the few applets that are actually live.

## 3. Per-element renderer study (the results)

Each rich element evaluated for: lightweight, canvas (clean rasterization), perf at
scale, keeps our declarative eval-free API (no callbacks).

| Element | Today | Best option | Δ bundle | Effort | Why |
|---|---|---|---|---|---|
| **Chart** | recharts (SVG, ~190 KB) | **Chart.js** via one `<Chart type data options>` | **−125 KB** (65 vs 190) | med | Native `toBase64Image()`, canvas, one `{type,data,options}` shape for *all* types → **pie uses the same `{labels,datasets:[{data}]}` as bar/line, killing the silent pie-shape bug**; model already fluent |
| **Graph** | hand-rolled SVG + our d3-force/d3-hierarchy layout | **Keep layout, swap render body to Canvas 2D** | **+0 KB** | small (~120–150 line render rewrite; layout files untouched) | Every lib (Sigma/Cytoscape/force-graph/g6, 55–350 KB) *inverts* our architecture — owns layout + **callback styling** our eval-free interpreter can't feed; WebGL ones (Sigma/g6) put a GPU context per applet (won't scale to hundreds on WebKit) and **rasterize blank/black in DOM-to-image** |
| **Map** | hand-rolled SVG + `d3-geo` projection | **Keep projection, render via `d3-geo` canvas path** (`geoPath(projection).context(ctx)`) | **+0 KB** (d3-geo already shipped) | small (~1 day) | Tile libs (Leaflet ~42 KB+network, MapLibre ~200 KB+GL) ruled out on weight + offline + per-instance GL; d3-geo *is* the light offline renderer and already in the tree |
| **Table** | HTML/DOM | **Keep as HTML** | 0 | none | Plain DOM captures fine inside the snapshot; no canvas needed |
| Card / text / intrinsics | HTML/DOM | Keep | 0 | none | Captured by the whole-applet snapshot |

**Takeaways:** the two hand-rolled elements (Graph, Map) go to canvas at **+0 KB**
each — we already own their layout/projection and every library would *lose* us
that while adding weight and a callback API we can't use. Only Chart pulls a new
dependency (Chart.js), and it *replaces* a heavier one.

## 4. Whole-applet capture — snapDOM (the spine)

All serious DOM-to-image tools share the foreignObject-clone engine; they differ on
speed, fidelity, and WebKit robustness. The study's verdict:

**Use snapDOM (`@zumer/snapdom`, ~50 KB gz, zero-dep, MIT, very active).** On a
complex tree it's **~33 ms vs ~181 ms (modern-screenshot) vs ~196 ms (html2canvas)**,
has **explicit CSS-variable fidelity fixes** (load-bearing — we theme via CSS vars,
where the others are weak/buggy), embeds `@font-face` fonts, captures embedded
`<canvas>` via `toDataURL`, handles Shadow DOM, and ships **documented Safari/WebKit
workarounds**. Crucially, **`html-to-image` declares Safari unsupported** — a
non-starter for our WebKit target. (html2canvas: slow, being abandoned — skip.
Native Element/Region Capture: Chromium-only, no WebKit — rule out under Tauri.)

**This is exactly why Pillar A (canvas) matters:** snapDOM captures a live
`<canvas>` by reading its pixels directly (`toDataURL`), which is deterministic and
sidesteps the foreignObject re-render path where SVG hits WebKit's bugs. Canvas
elements ⇒ clean, fast, predictable snapshots.

## 5. The shared canvas harness (consolidation the studies converged on)

All three canvas renderers (Chart.js, Graph, Map) need the **same three things** —
so build them **once** and share:

1. **Theme resolution — mostly already exists (verified).** Canvas `fillStyle`
   can't resolve `var(--foreground)` / oklch `color-mix(...)` — only SVG/CSS can. But
   the board harness **already** does this for its own canvas placeholders, and we
   reuse it rather than rebuild:
   - **`harness/theme/css-vars.ts`** — `readCssVarMixed(name, %)` (hidden DOM probe
     with `color: color-mix(in oklch, var(--x) N%, transparent)` → concrete `rgb()`)
     is the correct, only-robust way to concretize this app's **oklch/color-mix**
     tokens for canvas. Reuse verbatim. (`board/utils/color.ts:cssVarToHex` is NOT
     usable — it returns null for oklch.)
   - **`harness/theme/resolver.ts:makeBoardThemeResolver`** — the proven "canvas
     draw needs a concrete token color" pattern (already feeds `env.theme(...)` as
     `ctx.fillStyle` in every node placeholder, including `applet`).
   - **`harness/theme/use-board-theme.ts`** — a MutationObserver on
     `data-theme`/`data-mode` that recomputes on theme switch. Our re-render-on-theme
     pattern, already built.
   - **What we add is thin:** a general `resolveToken(token) → concrete color` keyed
     by the full chart token set (chart-1…5 + semantic — already enumerated in
     `components/charts/color-token.ts`), over `readCssVarMixed`, + an rgb→hex step if
     a lib needs hex. Likely **lift `css-vars.ts` from `harness/theme/` to a shared
     `lib/`** since the applet renderer sits outside the board.
   So this piece is **wiring, not new infrastructure.**
2. **HiDPI backing store.** Size the canvas to `cssSize × devicePixelRatio` and
   `ctx.scale(dpr, dpr)` — crisp on screen *and* crisp in the raster (part of why
   canvas out-rasterizes SVG).
3. **Capture-ready signalling.** A snapshot must fire only after
   `document.fonts.ready` **and** the element's render-complete (Chart.js
   `onComplete`, or our draw `useEffect` commit for Graph/Map) — foreignObject/
   snapDOM captures whatever is painted at that instant, so a too-early capture
   yields a blank/partial element.

So the migration produces a small **`applet/render/canvas/`** harness (resolved
palette + DPR canvas + ready-signal) that Chart/Graph/Map all consume, plus a
**`snapshotApplet()`** util wrapping snapDOM.

## 6. Net bundle — this makes applets *lighter*

| | Before | After |
|---|---|---|
| Chart | recharts ~190 KB (+ internal Redux/d3) | Chart.js ~65 KB |
| Graph | our SVG (0) | our canvas (0) |
| Map | our SVG + d3-geo (0*) | our canvas + d3-geo (0*) |
| Snapshot | — (none / fragile manual SVG raster) | snapDOM ~50 KB |
| **Net** | ~190 KB | **~115 KB** |

*d3-geo already shipped (promote to a direct dependency). Net: **~75 KB lighter**,
*and* we gain fast reliable to-image + the snapshot perf path. Weight and capability
move the same direction — rare and worth banking.

## 7. The perf architecture this unlocks (the payoff)

**Snapshot-first rendering.** Live (React + canvas) only for applets that are
in-view, at-rest, above the LOD zoom threshold, and recently interacted — a handful
at a time. Everything else is a **cached snapshot image**. Hundreds of applets →
hundreds of `<img>`, no reconciler, no live chart, no iframe — trivial for single-
process WebKit.

**Existing infra to build on (verified):** every node type already has a canvas
`placeholder.ts` (incl. `applet`) drawing themed glyphs — the snapshot *replaces the
glyph with a real applet image*. And `harness/canvas/use-thumbnail-capture.ts`
already does offscreen-canvas→PNG for the board minimap — a precedent for the
capture/caching plumbing (though snapDOM-of-the-DOM-subtree is a different mechanism
than the lib's minimap render).

Make the snapshot cheap enough to run at that scale (from the study):
- **Cache the dataURL per applet, keyed on a content hash** — never re-rasterize a
  static applet.
- **Capture lazily**, only on the live→snapshot transition (zoom-out / off-screen),
  and **throttle to idle** (`requestIdleCallback`) since WebKit is single-thread.
- **Batch export sequentially**, not in parallel, to avoid main-thread contention.
- Lean on snapDOM's built-in **MutationObserver memoization** for repeats.

**Live-canvas cost + escape hatches (only if the P4 WebKit spike shows a problem).**
The observer/redraw cost is bounded to the *few* live applets (§2.1), and further
reduced by: outer size from the node store (no observation), quiet internal
ResizeObservers (fire on mount + user-resize only), rAF-throttled redraw, and
showing the scaled snapshot *during* a drag-resize (live redraw once on settle).
If the handful of live charts is *still* too heavy on WebKit, in order of
preference:
1. **Render at a fixed logical size + CSS-scale** the live canvas (no redraw on
   resize; some blur when scaled up). Cheap, simple.
2. **OffscreenCanvas + Web Worker** — render off the main thread. Kept in the back
   pocket, *not* v1: WebKit's OffscreenCanvas support is late/uneven (depends on the
   WKWebView version Tauri ships) and moving Chart.js into a worker is a big lift.
The default is: don't pre-optimize — **measure a hundreds-of-applets board (a few
live + the rest snapshots) on real Tauri/WebKit** and only reach for these if needed.

## 8. Scope

**In:** Chart→Chart.js; Graph→canvas; Map→canvas; the shared canvas harness;
`snapshotApplet()` (snapDOM); LOD placeholder + board export wired to it; Chart
config **author-time validation** (Chart.js is *also* silent-wrong on misuse, but
its single consistent shape makes a schema easy).

**Out:** Table / Card / text stay HTML (captured by the snapshot); no Chart.js
plugins or **function options** (rejected as author-time errors); not re-opening the
engine choice beyond the above.

## 9. Risks / gotchas (research-informed)

1. **Tainted canvas = hard failure.** Any cross-origin image drawn into a
   chart/map canvas *without* CORS headers makes `toDataURL()` **throw**, killing the
   whole capture. Proxy/same-origin every image feeding a canvas; wrap capture in
   try/catch with a fallback (e.g., the generic glyph placeholder).
2. **Capture timing.** Only after `document.fonts.ready` **and** the element's
   render-complete; JS-registered fonts (`new FontFace()`) need snapDOM's
   `localFonts` (our handwriting/mono faces — check how they're loaded).
3. **Theme on canvas.** *De-risked* (§5): the oklch/color-mix resolver
   (`css-vars.ts`), the canvas-consumption pattern (`resolver.ts`), and the
   theme-switch MutationObserver (`use-board-theme.ts`) already exist in the board
   harness — we add a thin token-set wrapper, not new infrastructure.
4. **Function options / callbacks** (Chart.js tooltip/tick formatters, graph/map
   interactivity) can't be expressed — become author-time errors, not silent no-ops.
   Acceptable, but document the ceiling.
5. **Canvas blur on deep zoom-in** — mitigated by DPR backing store + showing the
   *live* chart only near 1:1; snapshots serve the zoomed-out view anyway.
6. **snapDOM Safari edges** — it engineers around them, but spike a composed applet
   (Card + Chart.js + a canvas Graph + fonts + theme) on real Tauri/WebKit **early**;
   it's load-bearing for both perf and export.

## 10. Phases

1. **P1 — Shared canvas harness + Chart.js `<Chart>`.** Palette resolver + DPR
   canvas + ready-signal; Chart.js `<Chart type data options>` on top; registry +
   skill + worked examples; pie inconsistency gone.
2. **P2 — Graph → canvas.** Rewrite `graph.tsx` render body to Canvas 2D on the
   harness; layout files untouched.
3. **P3 — Map → canvas.** `map.tsx` render via `d3-geo` canvas path on the harness;
   promote `d3-geo` to a direct dep.
4. **P4 — `snapshotApplet()` + LOD (the perf win).** snapDOM util; live↔snapshot
   swap with content-hash caching + idle throttling; **measure a hundreds-of-applets
   board on real WebKit vs the old iframe baseline.**
5. **P5 — Board export** reuses `snapshotApplet()`; **Chart config validation**
   (author-time schema).

## 11. Open questions

- **`<Chart>` name/API** — keep the name, new `{type,data,options}` props, drop the
  recharts-era `kind/labels/data/datasets/color` (compat shim for any epic applets?).
- **`react-chartjs-2` vs a thin custom canvas-ref wrapper** — the wrapper handles
  lifecycle/updates for ~small weight; the custom path avoids the dep and slots onto
  our harness directly. Leaning custom, since Graph/Map already need the harness.
- **Snapshot cadence** — exact live↔snapshot thresholds (zoom, viewport margin,
  idle, interaction); reuse mini-app deferred-mount heuristics as a start.
- **Handwriting/mono font embedding** in snapDOM (`@font-face` vs JS `FontFace`) —
  verify our faces capture; else pass via `localFonts`.
- **Graph/Map interactivity later** — canvas loses per-element DOM hit-testing; when
  tooltips/click arrive, use cached `Path2D` + `ctx.isPointInPath`. Fine for v1
  (declarative, no callbacks).

## 12. Non-goals

- Not switching Graph/Map *layout/projection* (those stay — only the render layer
  moves to canvas).
- Not a charting DSL, Chart.js plugins, or function options.
- Not native Element/Region Capture (Chromium-only; unusable under Tauri WebKit).
