// Mini-app iframe runtime entry — Phase 1 (compile + render path).
//
// Listens for `mini-app:render` messages from the host, compiles the
// agent's JSX source via sucrase, and mounts the resulting component
// inside a React error boundary. Compile failures and render failures
// show as inline error cards rather than tearing down the iframe.
//
// Phase 2 layers postMessage RPC on top of this; Phase 4 adds theme
// propagation + auto-resize.

import { StrictMode } from "react"
import type { ReactNode } from "react"
import { createRoot } from "react-dom/client"

import { compileMiniApp } from "./compile"
import { ErrorBoundary } from "./error-boundary"
import { CompileErrorCard, RuntimeErrorCard } from "./error-display"
import { handleHostMessage, setHostInitialState } from "./rpc"
import { MINI_APP_SCOPE_NAMES, MINI_APP_SCOPE_VALUES } from "./scope"
import { isSingleFrontend } from "./single-frontend"
import "./runtime.css"
// Self-hosted fonts (same as the main app). runtime.css re-uses src/index.css,
// which only defines the `--font-*` vars — the actual @font-face declarations
// live in src/fonts.ts. Import them here too or the mini-app falls back to
// system fonts. viteSingleFile inlines the woff2 into the one-file bundle.
import "../src/fonts"
// NOTE: the `@tailwindcss/browser` runtime JIT used to live here — it scanned
// each iframe's DOM continuously (a per-mini-app CPU cost + WASM in the bundle)
// solely because the agent's JSX is a runtime string the static build can't see.
// It's replaced by the build-time safelist in runtime.css (`@source inline(...)`),
// which force-emits the standard utility surface at compile time. Off-safelist /
// arbitrary-value classes therefore no longer resolve — see the safelist comment.


// Host origin resolution priority:
//   1. window.__APP_CONFIG__.hostOrigin set by docker-entrypoint.sh
//      from VITE_HOST_ORIGIN at container start. Lets one image ship
//      to dev / staging / prod without rebuilding.
//   2. import.meta.env.VITE_HOST_ORIGIN — build-time fallback for
//      vite-dev (no entrypoint runs there).
//
// The Window.__APP_CONFIG__ shape declaration lives in
// src/config/api.ts — both dist/index.html and dist-mini-app/index.html
// load the same /config.js so the shape is identical across bundles.
// We don't redeclare it here to avoid TS's "subsequent property
// declarations must have the same type" conflict from the shared
// tsconfig.app.json project root.

const HOST_ORIGIN =
  (typeof window !== "undefined" ? window.__APP_CONFIG__?.hostOrigin : undefined) ||
  import.meta.env.VITE_HOST_ORIGIN

// Single-frontend: served same-origin and loaded into an opaque-origin sandbox.
// Detected from the opaque origin ("null") rather than a possibly-mismatched
// injected host origin (see single-frontend.ts). We trust the parent by SOURCE
// (origin-independent; a sandboxed iframe can only be embedded by its parent) and
// reply with "*". Cross-origin mode keeps the strict origin check.
const SINGLE_FRONTEND = isSingleFrontend(
  HOST_ORIGIN,
  typeof window !== "undefined" ? window.origin : undefined,
)
const REPLY_TARGET = SINGLE_FRONTEND ? "*" : (HOST_ORIGIN as string)


// Dev-only debug surface for the iframe console. The console treats
// inputs as classic scripts, so `import.meta` is unavailable from a
// prompt — exposing a plain window global keeps the runtime
// inspectable. Read in devtools as `__MINI_APP_DEBUG__`.
declare global {
  var __MINI_APP_DEBUG__:
    | {
        hostOrigin: string
        runtimeOrigin: string
        bootedAt: string
        readyPosted: boolean
        renderCount: number
        lastIncoming?: { type?: unknown; origin?: string }
      }
    | undefined
}

if (import.meta.env.DEV) {
  globalThis.__MINI_APP_DEBUG__ = {
    hostOrigin: HOST_ORIGIN,
    runtimeOrigin: window.location.origin,
    bootedAt: new Date().toISOString(),
    readyPosted: false,
    renderCount: 0,
  }
}


const rootEl = document.getElementById("root")
if (!rootEl) throw new Error("missing #root element")
const root = createRoot(rootEl)


/**
 * Build the scope map from the registry's parallel name/value arrays.
 * The runtime passes the *values* positionally to `new Function` via
 * compileMiniApp; we rebuild a name→value object here so call sites
 * (and the agent's code, through the function's argument list) see a
 * stable shape.
 */
function buildScope(): Record<string, unknown> {
  return Object.fromEntries(
    MINI_APP_SCOPE_NAMES.map((name, i) => [name, MINI_APP_SCOPE_VALUES[i]]),
  )
}


function renderWidget(source: string, savedState: unknown) {
  if (globalThis.__MINI_APP_DEBUG__) {
    globalThis.__MINI_APP_DEBUG__.renderCount += 1
  }
  // The agent's component reads `host.initialState` (typically inside a
  // useState initializer) on first render. Set it before compile so the
  // first read sees the persisted value, not undefined.
  setHostInitialState(savedState)

  const result = compileMiniApp(source, buildScope())
  if (!result.ok) {
    root.render(<CompileErrorCard error={result.error} />)
    return
  }
  const Widget = result.Component as () => ReactNode
  root.render(
    <StrictMode>
      <ErrorBoundary fallback={(err) => <RuntimeErrorCard error={err} />}>
        <Widget />
      </ErrorBoundary>
    </StrictMode>,
  )
}


// Apply the host's active theme by writing data attributes to <html>.
// The shared src/index.css declares every palette × mode pair as
// `[data-theme="X"][data-mode="Y"] { --background: ...; ... }`, so
// flipping the attribute is enough to retheme CSS variables + Tailwind
// utilities for the entire iframe document.
function applyTheme(theme: unknown) {
  if (!theme || typeof theme !== "object") return
  const t = theme as { id?: unknown; mode?: unknown }
  if (typeof t.id === "string") {
    document.documentElement.dataset.theme = t.id
  }
  if (t.mode === "light" || t.mode === "dark") {
    document.documentElement.dataset.mode = t.mode
  }
}


window.addEventListener("message", (event) => {
  if (globalThis.__MINI_APP_DEBUG__) {
    const data = event.data as { type?: unknown } | null
    globalThis.__MINI_APP_DEBUG__.lastIncoming = {
      type: data?.type,
      origin: event.origin,
    }
  }
  // Trust the host: by source in single-frontend (opaque origin), else by origin.
  if (SINGLE_FRONTEND ? event.source !== window.parent : event.origin !== HOST_ORIGIN) return
  // Route RPC results back to their pending promises first — handle returns
  // true if it recognized + processed the message type, in which case we're
  // done with this event.
  if (handleHostMessage(event.data)) return

  const msg = event.data as {
    type?: string
    source?: string
    savedState?: unknown
    theme?: unknown
  } | null
  if (!msg || typeof msg !== "object") return
  if (msg.type === "mini-app:render" && typeof msg.source === "string") {
    applyTheme(msg.theme)
    renderWidget(msg.source, msg.savedState)
    return
  }
  if (msg.type === "mini-app:theme") {
    applyTheme(msg.theme)
  }
})


window.parent.postMessage({ type: "mini-app:ready" }, REPLY_TARGET)
if (globalThis.__MINI_APP_DEBUG__) {
  globalThis.__MINI_APP_DEBUG__.readyPosted = true
}


// Auto-resize: watch the widget's content height and report it to
// the host so the iframe (and the canvas node it lives in) can grow
// to fit. ResizeObserver fires on every content-size change,
// including after React commits a state update that grows the DOM.
//
// Reports are coalesced via requestAnimationFrame so a widget
// animating its height (e.g. the stepper, BFS step-through) sends
// at most one `mini-app:resize` per frame instead of one per
// ResizeObserver fire. The host's MiniAppView batches incoming
// heights through its own rAF on the way to `store.updateNode`, so
// without this coalescing we'd pay two postMessage hops + a
// dedup-no-op per fire — fine for steady state, wasteful during
// animation.
//
// Measurement combines four metrics (documentElement vs body,
// scrollHeight vs offsetHeight) and takes the max. Single-metric
// measurement (just body.scrollHeight) understates content extent
// in layouts with sticky/absolute positioning, transforms, or
// overflow containers; the 4-metric max is robust against those
// quirks at near-zero cost.
let lastReportedHeight = 0
let scheduledFrame: number | null = null
function measureContentHeight(): number {
  const doc = document.documentElement
  const body = document.body
  return Math.ceil(
    Math.max(
      doc ? doc.scrollHeight : 0,
      doc ? doc.offsetHeight : 0,
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
    ),
  )
}

function flushHeight() {
  scheduledFrame = null
  const height = measureContentHeight()
  if (height === lastReportedHeight || height <= 0) return
  lastReportedHeight = height
  window.parent.postMessage(
    { type: "mini-app:resize", height },
    REPLY_TARGET,
  )
}

function scheduleReport() {
  if (scheduledFrame != null) return
  scheduledFrame = requestAnimationFrame(flushHeight)
}

const resizeObserver = new ResizeObserver(() => scheduleReport())
resizeObserver.observe(document.body)

// Kick the first measurement on next frame so the post-mount React
// commit has flushed to DOM before we measure. ResizeObserver covers
// every subsequent change.
scheduleReport()
