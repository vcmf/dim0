# Applet charts: migrate recharts → Chart.js (lightweight + native to-image)

> **Status:** proposal, for review before implementation. Participants: dev04 +
> Claude. Targets `epic/applet` (where the applet chart code lives). Promote the
> durable decision to an ADR once the shape is agreed.

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

Both capabilities reduce to the same primitive: **turn an applet into a static
image, fast, and cheaply.** So the chart engine must be chosen for **(a) bundle
weight and (b) native, fast raster export** — *before* aesthetics or API taste.

**Priority #1 is therefore: lightweight + built-in fast `toImage`.** Everything
below follows from that.

## 1. Why recharts fails priority #1

`<Chart>` is recharts today (`components/charts/chart-impl.tsx`). Against the two
must-haves it is the *worst* common choice:

- **No built-in raster export.** recharts renders **SVG**; there is no `toImage`.
  SVG→PNG means serialize the DOM → draw onto a canvas via an `Image` → `toDataURL`,
  fighting fonts/CSS/`foreignObject` tainting. Slow and fragile — exactly the export
  path we'd lean on for hundreds of nodes.
- **Heavy.** ~190 KB gz (our own `chart.tsx` note), and recharts **v3 pulls in
  Redux Toolkit + react-redux + immer + d3 (`victory-vendor`)** internally. Heavy to
  ship, heavy to run.
- **Slowest render at scale.** SVG creates a **DOM node per data point**; a few
  hundred charts × dozens of points each is a DOM explosion — the single-process
  WebKit worst case.

recharts optimizes for SVG crispness and composability — neither of which is our
priority-#1. It's the wrong tool for a hundreds-of-applets, export-first board.

## 2. Why Chart.js

| Need | Chart.js |
|---|---|
| **Native fast to-image** | ✅ `chart.toBase64Image()` — one call, canvas→PNG, no serialization |
| **Lightweight** | ✅ ~65 KB gz (⅓ of recharts), v4 tree-shakeable (register only used controllers/scales) |
| **Fast render at scale** | ✅ canvas — one draw call, not N DOM nodes |
| **Consistent, model-known API** | ✅ one `{ type, data, options }` object for every chart type |
| **Eval-free-interpreter fit** | ✅ plain object literals; one `<Chart>` component, no whitelist explosion |

### 2.1 The consistency win (kills the pie bug)
Chart.js uses **one config shape for all chart types**, and the `data` shape is
uniform — pie included:

```jsx
<Chart type="bar"  data={{ labels, datasets: [{ label, data }] }} />
<Chart type="line" data={{ labels, datasets: [{ label, data }] }} />
<Chart type="pie"  data={{ labels, datasets: [{ data, backgroundColor }] }} />
```

Pie takes the **same `{ labels, datasets: [{ data }] }}` shape** as bar/line — it
is *not* special-cased into `{ name, value }` the way recharts (and our wrapper)
does. The class of failure that silently broke real applets — "pie needs a
different data shape and renders empty with no error" — **disappears by
construction.** (See the AI-market-share applet: `data={[31.4, …]}` + `labels` +
invented `colors` → empty pie, "value value value" legend.)

### 2.2 Model familiarity
Chart.js config is heavily represented in training data; the model authors it
fluently. Fewer invented-syntax mistakes than our small, bespoke `kind/labels/
data/datasets/color` API.

## 3. The performance architecture this unlocks (the real point)

Chart.js is not just a lighter chart — it enables a **snapshot-first render model**
for the whole applet layer:

- **Live** (interactive React + Chart.js canvas) **only** for applets that are
  in-view, at-rest, above the LOD zoom threshold, and recently interacted — a
  *handful* at any moment.
- **Snapshot** (a static image) for everything else — off-screen, zoomed-out, or
  idle. Hundreds of applets become hundreds of `<img>` (or one draw onto the board
  canvas): no React reconciliation, no live chart, no iframe. Trivial for
  single-process WebKit.

This is the same "LOD placeholder" idea already stubbed in the applet node
(`node-types/applet/placeholder.ts` is a generic glyph today), but Chart.js makes
the placeholder a **real snapshot of the applet**, produced cheaply:

- A chart-only applet → `toBase64Image()` directly.
- A composed applet (Card + text + several charts) → rasterize the applet's root
  DOM subtree with **`html-to-image`** (foreignObject). Crucially, **Chart.js
  canvases capture cleanly** inside that pass (their pixels are read directly),
  whereas SVG charts (recharts/Graph/Map) need fragile re-serialization. So even the
  whole-applet snapshot is *easier and more reliable* with canvas charts.

**Net:** lightweight engine + clean rasterization → a board that stays smooth on
WebKit with hundreds of applets, and a whole-board export that finally includes
applets.

## 4. Scope — what changes, what doesn't

**Migrate:**
- `components/charts/chart-impl.tsx` + `chart.tsx` + `chart-translate.ts` +
  `chart-types.ts` → a Chart.js-backed `<Chart>` (via `react-chartjs-2` or a thin
  canvas-ref wrapper that owns create/update/destroy).
- The applet **registry + skill**: replace the `kind/labels/data/datasets/color`
  signature with the Chart.js `{ type, data, options }` shape; new worked examples;
  update the pie guidance (now the same shape as bar/line).
- **Theming**: `color-token.ts` already resolves our `chart-1…5` / semantic tokens
  to values — reuse it to **inject the palette into the config** and **re-render on
  theme switch** (canvas doesn't live-update with CSS).
- **To-image plumbing**: a `snapshotApplet(node) → dataURL` util (Chart.js
  `toBase64Image` for chart-only; `html-to-image` for composed), wired into (a) the
  LOD placeholder and (b) board export.

**Do NOT migrate (out of scope here):**
- **`Graph` and `Map`** are already hand-rolled **SVG**, not recharts — they stay.
  But they *do* need a to-image path for the snapshot/export story; `html-to-image`
  covers them (with the usual SVG caveats). A later pass could canvas-render them if
  their SVG rasterization proves unreliable at scale.
- **Table** and the HTML/Card/text components — unaffected (captured by the DOM
  snapshot).
- No Chart.js **plugins** or **function options** (see risks).

## 5. Risks / hard parts (be honest)

1. **Theming on canvas is the main new work.** recharts themed for free via CSS
   tokens; Chart.js needs real color values in the config, so we inject the resolved
   palette and **re-render on theme change**. Bounded, but it's the biggest piece.
2. **Function options can't be expressed.** Chart.js `options` allow callbacks
   (tooltip/tick formatters, `onClick`). The eval-free interpreter rejects
   functions → these become **author-time errors** (self-correcting), not silent
   no-ops. The common case (labels, datasets, colors, title, legend, axis min/max)
   is all plain values. Document "options are plain config, no callbacks."
3. **Canvas blurs on deep zoom-in.** Acceptable: at rest we show a snapshot; live
   charts appear only above the LOD threshold near 1:1, and users zoom *into*
   individual charts rarely. If it bites, Chart.js supports `devicePixelRatio`
   scaling.
4. **Whole-applet snapshot needs `html-to-image`, not just `toBase64Image`.** A
   composed applet is a DOM subtree, so the placeholder/export uses DOM
   rasterization; Chart.js's role is to make the chart parts capture cleanly + keep
   the live render cheap. `html-to-image` has its own font/CSS caveats to validate.
5. **Migration burden is low** — applets are epic-only (not on `main`) and old
   mini-apps are frozen, so there's little authored content to convert; it's mostly
   re-pointing the component + skill. Decide: hard cut vs a compat shim mapping the
   old `kind/labels/data` → Chart.js config for any existing epic applets.
6. **Author-time validation still required.** Chart.js is *also* silent-wrong on
   misuse (a pie with numbers renders empty, no throw). Pair the migration with a
   Chart config schema (reject unknown/mis-shaped props at author time) — the
   consistent single shape makes this far easier than recharts' per-kind shapes.

## 6. Rough phases

1. **P1 — Chart.js `<Chart type data options>` behind the applet node.** New impl +
   registry + skill + worked examples (bar/line/pie/scatter/doughnut). Charts render
   live and correctly; pie inconsistency gone.
2. **P2 — Theming.** Palette injection via `color-token.ts` + re-render on theme
   switch, across all 6 themes × light/dark.
3. **P3 — Snapshot + LOD (the perf win).** `snapshotApplet` util; swap live
   applets for snapshot images when off-screen / zoomed-out / idle; hydrate to live
   on focus/interaction. Measure a hundreds-of-applets board on WebKit vs the old
   iframe baseline.
4. **P4 — Board export.** Reuse `snapshotApplet` so whole-board export includes
   applets; add the SVG path for Graph/Map.
5. **P5 — Chart config validation.** Author-time schema (option B) rejecting bad
   shapes / unknown options with `line:col`.

## 7. Open questions

- **Keep the `<Chart>` name/API or introduce `<Chart type data options>` fresh?**
  Leaning: same component name, new config-object props; drop the recharts-era
  `kind/labels/data/datasets/color` (with an optional compat shim for epic applets).
- **`react-chartjs-2` vs a thin custom ref wrapper?** react-chartjs-2 handles
  lifecycle/updates for ~small weight; a custom wrapper avoids the dep. Likely
  react-chartjs-2 to start.
- **Snapshot cadence** — when exactly does an applet go live↔snapshot (zoom
  threshold, viewport margin, idle timeout, interaction)? Reuse the mini-app
  deferred-mount heuristics as a starting point.
- **`html-to-image` reliability** for composed applets (fonts, theme CSS,
  cross-origin) — spike it early; it's load-bearing for both perf and export.
- **Do Graph/Map eventually move to canvas too**, for a uniform snapshot story, or
  is SVG rasterization good enough for them?

## 8. Non-goals

- Not switching Graph/Map rendering engines (SVG stays; only their to-image path is
  added).
- Not building a charting DSL or supporting Chart.js plugins/function options.
- Not re-opening the engine choice beyond Chart.js — priority #1 (light + native
  to-image) selects it; a lighter-but-weaker lib (uPlot/Frappe) loses versatility
  and model-familiarity, and a heavier one (ECharts/recharts) loses the weight.
