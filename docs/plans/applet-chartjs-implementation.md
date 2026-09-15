# Applet rendering migration — implementation plan

> Build sequence for the design in
> [`applet-chartjs-migration.md`](./applet-chartjs-migration.md) (§ refs point
> there). Targets `epic/applet` (the applet render code lives there). Ship behind a
> `dim0_applet_canvas` flag for canary rollout; promote durable decisions to an ADR
> as PRs land.
>
> **Status:** ready to spike. The plan is **risk-first**: PR 0 (the WebKit capture
> spike) gates everything — if snapDOM can't reliably capture a composed applet on
> WKWebView, the whole snapshot-first architecture changes, so we prove it *before*
> building.

## Shape of the work

Two pillars (design §2): **(A)** render every heavy rich element to `<canvas>`
(Chart→Chart.js, Graph/Map→our layout/projection + canvas), and **(B)** snapshot
the whole applet to an image with **snapDOM** for the LOD placeholder (perf) and
board export. A **shared canvas harness** (theme resolver + DPR canvas +
capture-ready signal — mostly reusing existing board-harness code, design §5)
underpins every element. Net bundle: **~75 KB lighter** while gaining to-image.

## Sequencing

```
PR0 spike (WebKit capture) ──▶ PR1 harness ──▶ PR2 Chart.js ──┐
                                     │                        ├─▶ PR5 snapshot+LOD ──▶ PR6 export+validation
                                     ├──▶ PR3 Graph→canvas ────┤
                                     └──▶ PR4 Map→canvas ──────┘
```

PR0 gates all. PR1 is the foundation every element sits on. PR2/3/4 are independent
of each other once PR1 lands (parallelizable). PR5 needs all elements on canvas
(2+3+4) for clean, reliable snapshots. PR6 reuses PR5's `snapshotApplet`.

---

## PR 0 — WebKit capture spike (de-risk; throwaway)

**Objective:** prove snapDOM reliably captures a *composed* applet on real
Tauri/WKWebView before building anything. This is the single highest-value,
lowest-cost step.

**Deliverables:** a hidden dev route / story that renders one composed applet
(Card + a Chart.js canvas + a hand-drawn canvas + our handwriting+mono fonts + an
active theme) and captures it with snapDOM; verify on macOS + Linux WebKit and on
Chrome. Check: fonts embed (`@font-face` vs JS `FontFace`), theme colors correct,
canvas pixels present, timing (fonts.ready + render-complete), capture latency.

**LOC:** ~150 (throwaway). **Complexity:** Low (code) / High (learning value).
**Depends on:** nothing. **Acceptance:** a pixel-correct PNG of the composed applet
on WKWebView, with a measured capture time and a documented font/timing recipe. If
it fails or is slow, **stop and re-plan the snapshot approach** (design §9.6).

**RESULT (2026-09-14, PR #297) — 🟢 PASS on Safari/macOS WebKit.** A composed card
(Card + handwriting/mono/sans `@fontsource` text + `chart-1…5` themed surfaces + a
theme-resolved DPR canvas) captured faithfully via snapDOM 3.0.0: **fonts embed**,
**theme colors match** (HTML *and* canvas), **canvas pixels captured**, and a
**light↔dark theme switch re-captures correctly** (canvas repaints on theme change).
Timing: **~116–120 ms warm**, cold ~240–370 ms, **~210–225 KB/PNG** at DPR.
Recipe confirmed: self-hosted `@fontsource` faces embed cleanly (biggest gotcha,
de-risked); await `document.fonts.ready` + repaint canvas before capture.
**Two inputs for PR 5:** (1) capture is main-thread + sequential → a 200-applet
board export ≈ 24 s (needs a progress UI); (2) ~210 KB/PNG × hundreds is tens of MB
→ **downscale the placeholder snapshot** (shown small when zoomed out) + evict; don't
cache full-DPR PNGs. Linux WebKitGTK check via real `tauri dev` still pending, but
not a gate. → **proceed to PR 1.**

---

## PR 1 — Shared canvas harness (foundation)

**Objective:** the primitives every canvas element needs, built once (design §5).

**Deliverables:**
- Lift `harness/theme/css-vars.ts` → a shared `lib/` (it's used outside the board
  now); keep `readCssVarMixed` (the oklch/`color-mix` DOM-probe) verbatim.
- `resolveToken(token) → concrete color` over the full chart token set (chart-1…5 +
  semantic — enumerated in `charts/color-token.ts`), + rgb→hex helper.
- `useCanvasSurface(ref)` — DPR-aware backing store (`cssSize × dpr`, `ctx.scale`),
  resize handling, and a `useResolvedPalette()` that recomputes on the theme
  MutationObserver (reuse `use-board-theme.ts`'s pattern).
- `useCaptureReady(ref)` — resolves after `document.fonts.ready` + a per-element
  render-complete signal.
- Tests: token→concrete resolution across a couple themes × light/dark; DPR sizing.

**LOC:** ~350–450. **Complexity:** Medium (theme reactivity + oklch, but ~60%
reuses existing harness code). **Depends on:** PR 0. **Acceptance:** a demo canvas
draws themed, DPR-crisp shapes that re-color on theme switch; unit tests green.

---

## PR 2 — Chart.js `<Chart type data options>` (replaces recharts)

**Objective:** the biggest single win — Chart.js on the harness, one config shape
for all types (kills the pie inconsistency), recharts removed (design §3, §2.1).

**Deliverables:**
- New `chart-impl` on Chart.js (v4, tree-shaken: register only used
  controllers/scales) via a thin canvas-ref wrapper on the harness (no
  `react-chartjs-2` unless it earns its place — the harness already owns the ref).
- `<Chart>` accepts `{ type, data, options }`; palette injected from
  `resolveToken`; `options` restricted to plain config (function options rejected).
- Registry + **skill** update: replace `kind/labels/data/datasets/color` docs with
  the Chart.js shape; new worked examples (bar/line/pie/doughnut/scatter); note the
  pie shape is now the same as bar/line.
- Compat: decide hard-cut vs a small `kind/labels/data`→config shim for existing
  epic applets (§11).
- **Remove recharts** + `chart-translate.ts`/`chart-types.ts` recharts glue; drop
  the dep. Update `chart-impl.tsx`/`chart.tsx`.
- Tests: golden config→render for the worked examples; the pie case that broke
  before now renders.

**LOC:** ~500–700 (incl. skill + examples; minus deletions). **Complexity:**
Medium-High (new lib, theming injection, skill rewrite, dep removal).
**Depends on:** PR 1. **Acceptance:** all chart kinds render themed + DPR-crisp;
pie renders correctly from the unified shape; recharts gone from the bundle; skill
examples compile + render.

---

## PR 3 — Graph → canvas

**Objective:** swap `graph.tsx`'s SVG render body to Canvas 2D on the harness;
layout untouched (design §3, study-confirmed +0 KB).

**Deliverables:**
- Rewrite `graph.tsx` render as a `useCanvasSurface` draw loop: `arc/fill/stroke`
  nodes, `moveTo/lineTo` trimmed edges, 3-point arrowheads, `fillText` labels,
  `roundRect` edge-label chips. `trimToBoundary`, `markerIdFor`, constants port
  verbatim; `graph-layout*.ts`/`graph-types.ts` untouched.
- Manual viewBox→canvas scale/translate (SVG did this for free).
- Colors via `resolveToken`; fonts via `useCaptureReady`.
- Tests: layout output unchanged; a render smoke test.

**LOC:** ~250. **Complexity:** Medium (canvas port + viewBox math + text metrics).
**Depends on:** PR 1. **Acceptance:** graphs render visually equivalent to the SVG
version, themed, DPR-crisp, and capture cleanly in a snapDOM test.

---

## PR 4 — Map → canvas

**Objective:** render `map.tsx` via `d3-geo`'s canvas path on the harness; projection
untouched (design §3, study-confirmed +0 KB).

**Deliverables:**
- Rewrite `map.tsx` draw with `geoPath(projection, ctx)` for region fills/strokes +
  `ctx.arc`/`fillText` markers; `map-projection.ts`/`map-geo.ts` mostly intact.
- Concrete fill resolution via `resolveToken` (replaces the `color-mix` SVG strings
  from `buildFillResolver`).
- Promote `d3-geo` to a direct dependency (`package.json`).
- Tests: projection unchanged; a render smoke test.

**LOC:** ~250. **Complexity:** Medium (d3-geo canvas path + concrete fills + DPR).
**Depends on:** PR 1. **Acceptance:** choropleth + markers render equivalent to SVG,
themed, offline, DPR-crisp, capture cleanly.

---

## PR 5 — `snapshotApplet` + snapshot-first LOD (the perf win)

**Objective:** the payoff — hundreds of applets stay smooth on WebKit via
snapshot-first rendering (design §7).

**Deliverables:**
- `snapshotApplet(rootEl) → dataURL` wrapping snapDOM (fonts.ready + all elements'
  render-complete; try/catch → glyph fallback; tainted-canvas guard).
- Content-hash cache (source + persisted state) → never re-rasterize a static applet.
- Add `createDeferredMount({ cap: 10 })` to the applet node view (not there today).
- Upgrade `drawAppletPlaceholder`: draw the cached **snapshot** instead of the glyph
  (glyph as fallback until a snapshot exists).
- Live↔snapshot swap: double-buffer (keep snapshot until live renders), capture on
  live→idle, idle-throttled (`requestIdleCallback`).
- **Measure**: a hundreds-of-applets board (a few live + rest snapshots) on real
  WKWebView vs the old mini-app iframe baseline.

**LOC:** ~500–600. **Complexity:** High (swap logic, caching/invalidations, capture
timing, the measurement). **Depends on:** PR 2 + 3 + 4 (all elements canvas → clean
snapshots). **Acceptance:** a 200-applet board pans/zooms smoothly on WKWebView; live count
bounded by the cap; snapshots re-use cache; measured win over the iframe baseline.

---

## PR 6 — Board export + Chart config validation

**Objective:** unblock whole-board export (applets included) and close the
silent-wrong gap with author-time Chart validation (design §8, §9).

**Deliverables:**
- Whole-board export reuses `snapshotApplet` for applet nodes (Graph/Map already
  canvas → uniform capture); wire into the export flow.
- Chart config **author-time schema** in `validateApplet`: reject unknown props /
  wrong `data` shapes (e.g. pie without `{labels,datasets}`) with `line:col`. The
  single Chart.js shape makes this far easier than per-kind recharts shapes.
- Tests: export produces a correct composed image incl. applets; validator rejects
  the known bad shapes with actionable messages.

**LOC:** ~400. **Complexity:** Medium (export wiring + the config schema).
**Depends on:** PR 5 (export) + PR 2 (Chart shape). **Acceptance:** board export
includes applets faithfully; the pie/`colors`/`yAxis`-style mistakes now error at
author time.

---

## Summary — LOC & complexity

| PR | Objective | LOC | Complexity | Gates |
|----|-----------|-----|------------|-------|
| **0** | WebKit capture spike (de-risk) | ~150 (throwaway) | Low code / **critical** | blocks all |
| **1** | Shared canvas harness | ~350–450 | Medium | foundation |
| **2** | Chart.js `<Chart>` (−recharts) | ~500–700 | Medium-High | biggest single PR |
| **3** | Graph → canvas | ~250 | Medium | parallel w/ 2,4 |
| **4** | Map → canvas | ~250 | Medium | parallel w/ 2,3 |
| **5** | snapshot + LOD (perf win) | ~500–600 | **High** | the riskiest integration |
| **6** | Board export + Chart validation | ~400 | Medium | last |

**Total: ~2,400–2,800 LOC** across 6 PRs (+ the throwaway spike), net of the recharts
deletion. The two to watch: **PR 2** (largest, new dep + skill rewrite) and **PR 5**
(highest complexity — the swap/caching/measurement).

## Cross-cutting

- **Feature flag** `dim0_applet_canvas` — gate the canvas renderers + snapshot path
  for canary; flip after the WebKit soak (mirrors `dim0_applet`).
- **The WebKit spike (PR 0) is a hard gate** — do not start PR 1+ until it passes.
- **Fallbacks everywhere** — a failed snapshot falls back to the glyph placeholder;
  a failed capture never breaks the live view.
- **CI** — the harness resolver tests + per-element render smoke tests + the
  validator tests are permanent gates.
- **Rollback posture** — behind the flag, the recharts path can co-exist until PR 2
  fully lands; keep the flag until PR 5's WebKit numbers are confirmed.

## Open questions (from the design doc, decided as PRs plan)

- **`<Chart>` compat** — hard-cut vs shim for epic applets (PR 2). Leaning hard-cut
  (applets are epic-only, not shipped) + a one-off rewrite of any existing ones.
- **`react-chartjs-2` vs custom ref** — custom, since the harness owns the ref (PR 2).
- **Snapshot cadence constants** — the exact idle timeout + viewport margin land in
  PR 5, tuned by the WebKit measurement.
- **Graph/Map interactivity** — deferred; when it arrives, cached `Path2D` +
  `isPointInPath` (design §11), a small follow-up, not in this plan.
