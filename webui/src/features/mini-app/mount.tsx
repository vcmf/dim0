// MiniAppMount — the host-side React component that owns the sandboxed
// iframe lifecycle, the postMessage handshake, and the routing of
// host.* RPC calls back into the host app.
//
// Lifecycle (see mini-app-archi.md §9 for the full spec):
//
//   1. Mount → kick off fetchMiniAppState(noteId) in parallel with the
//      iframe loading the runtime bundle.
//   2. iframe posts {type:"mini-app:ready"} once mounted.
//   3. When BOTH "ready" arrived AND the saved-state fetch settled
//      (success OR failure — failure falls back to undefined), the host
//      posts {type:"mini-app:render", source, savedState, theme}.
//   4. Whenever the host's active theme/palette changes thereafter, the
//      host posts {type:"mini-app:theme", theme}. The iframe applies
//      data attributes only; no widget remount.
//   5. iframe may post {type:"mini-app:rpc"} → host dispatches by method,
//      replies with {type:"mini-app:rpc-result"}. See dispatch.ts.
//   6. iframe may post {type:"mini-app:resize"} → host updates height.
//
// Security: the iframe is sandbox="allow-scripts" only, and the runtime
// is served from a different origin (different port in dev, different
// subdomain in prod — see mini-app-archi.md §5). Every incoming message
// is filtered on event.origin === RUNTIME_ORIGIN AND
// event.source === iframeRef.current.contentWindow. Both, no exceptions.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { ArrowClockwiseIcon, WarningIcon } from "@phosphor-icons/react"
import { toast } from "sonner"

import { useTheme } from "@/components/theme-provider"
import { cn } from "@/lib/utils"
import { isTauri } from "@/platform"

import { createMessageHandler } from "./dispatch"
import { fetchMiniAppState, saveMiniAppState } from "./state-client"


// How long we wait for the iframe to send `mini-app:ready` after mount
// before declaring it stuck. Generous enough to survive a slow CDN +
// cold sucrase compile but short enough that the user doesn't stare
// at an empty rectangle wondering if anything's happening.
const HANDSHAKE_TIMEOUT_MS = 5000


// Runtime origin resolution:
//   - If runtime config was injected (docker-entrypoint's `/config.js` on web),
//     it is AUTHORITATIVE — including an intentional empty string, which means
//     single-frontend mode (load `/mini-app` same-origin). We must NOT let a
//     build-time-baked `VITE_MINI_APP_ORIGIN` (e.g. a dev `localhost` port) leak
//     through when the config says empty — that's what made a single-frontend
//     prod deploy try to load the iframe from an unreachable localhost origin.
//   - Only when there's no injected config at all (vite-dev, no entrypoint) do
//     we fall back to the build-time value.
// See mini-app-archi.md §6.1.
const injectedConfig = typeof window !== "undefined" ? window.__APP_CONFIG__ : undefined
const RUNTIME_ORIGIN = isTauri()
  // Desktop is a compiled, offline-first app: the runtime is BUNDLED under
  // `/mini-app` and served same-origin by Tauri, with no runtime config.js to
  // inject an origin. Force single-frontend and IGNORE any baked
  // VITE_MINI_APP_ORIGIN — `.env.sample` (which the desktop build bakes) points
  // it at a dev localhost port that doesn't exist on a user's machine, so a
  // cross-origin load just fails ("loading failed").
  ? ""
  : injectedConfig
    ? injectedConfig.miniAppOrigin ?? ""
    : import.meta.env.VITE_MINI_APP_ORIGIN || ""


// Single-frontend (default): no separate runtime origin configured, so load the
// self-contained runtime as a same-origin static asset into an OPAQUE-origin
// iframe (sandbox WITHOUT allow-same-origin) — isolation without a second origin
// (best practice for untrusted code; see mini-app-archi.md). Cross-origin mode
// (with Vite HMR) is opt-in by setting VITE_MINI_APP_ORIGIN.
const SINGLE_FRONTEND = RUNTIME_ORIGIN === ""
const RUNTIME_PATH = SINGLE_FRONTEND ? "/mini-app/index.html" : `${RUNTIME_ORIGIN}/index.html`
// postMessage target: an opaque iframe has no addressable origin → "*". The
// inbound guard (source === contentWindow) is the real boundary either way.
const POST_TARGET = SINGLE_FRONTEND ? "*" : RUNTIME_ORIGIN
// Inbound origin to trust: an opaque-sandbox iframe posts with origin "null".
const EXPECTED_ORIGIN = SINGLE_FRONTEND ? "null" : RUNTIME_ORIGIN
const SANDBOX = SINGLE_FRONTEND ? "allow-scripts" : "allow-scripts allow-same-origin"


// Deployment safeguard: the iframe is sandboxed with `allow-same-origin`
// for legit browser-API reasons (see the comment near the `sandbox`
// attribute below). That flag is SAFE only when the runtime is served
// from a *different* origin than the host — that cross-origin split is
// what stops the iframe from touching host cookies / DOM / storage.
// If a deploy ever points VITE_MINI_APP_ORIGIN at the host's origin,
// the security model collapses silently. Fail loud here at module
// load so a misconfig is impossible to miss.
if (
  typeof window !== "undefined" &&
  RUNTIME_ORIGIN !== "" &&
  RUNTIME_ORIGIN === window.location.origin
) {
  console.error(
    "[mini-app] runtime origin matches host origin — `allow-same-origin` " +
      "sandbox would expose host cookies/storage to the iframe. " +
      "Move the runtime to a different subdomain.",
    { hostOrigin: window.location.origin, runtimeOrigin: RUNTIME_ORIGIN },
  )
}


// Dev-only host-side debug surface — pairs with the iframe's
// __MINI_APP_DEBUG__. Lets us inspect from the board's devtools
// whether the handshake is happening + what origin we expect.
declare global {
  var __MINI_APP_HOST_DEBUG__:
    | {
        runtimeOrigin: string
        mounts: number
        readyEventsReceived: number
        rpcEventsReceived: number
        lastReadyFrom?: string
      }
    | undefined
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  globalThis.__MINI_APP_HOST_DEBUG__ ??= {
    runtimeOrigin: RUNTIME_ORIGIN,
    mounts: 0,
    readyEventsReceived: 0,
    rpcEventsReceived: 0,
  }
}


export interface MiniAppMountProps {
  /** The note id whose state we hydrate on mount and save on each change. */
  noteId: string
  /** JSX source the agent wrote; lives on note.content. */
  source: string
  /** Optional canvas-side className for sizing/spacing. */
  className?: string
  /**
   * Optional sink for the widget's reported natural height (from
   * `mini-app:resize`). Lets a parent grow its surrounding chrome to
   * fit the widget — for the canvas card this is wired into the
   * harness's `updateNode` so a node grows when its widget grows.
   * Receives the raw widget height in CSS pixels; the parent decides
   * whether to apply chrome offset, throttle, or clamp.
   */
  onContentHeightChange?: (height: number) => void
}


export function MiniAppMount({
  noteId,
  source,
  className,
  onContentHeightChange,
}: MiniAppMountProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [iframeReady, setIframeReady] = useState(false)
  const [savedStateLoaded, setSavedStateLoaded] = useState(false)
  const savedStateRef = useRef<unknown>(undefined)
  // Load-failure state: `iframeFailed` flips when either the iframe
  // never sends `mini-app:ready` within HANDSHAKE_TIMEOUT_MS, or when
  // the browser surfaces a low-level load error (404, network blip,
  // CSP block). `reloadKey` bumps to force the iframe element to
  // remount on retry. Keep them separate so we can show a different
  // message for "stuck" vs "couldn't fetch" if we ever want to.
  const [iframeFailed, setIframeFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  // Pull the host's active theme so the iframe can mirror it. `themeId`
  // is the palette ("parchment", "tokyo-night", …) and `resolvedTheme`
  // collapses "system" mode down to a concrete "light" | "dark". Both
  // map 1:1 to data attributes the iframe sets on its own <html>.
  const { themeId, resolvedTheme } = useTheme()
  // Stash the latest onContentHeightChange in a ref so the message
  // listener (recreated only when `noteId` flips) always sees the
  // current callback without forcing a re-subscribe on every parent
  // re-render.
  const onContentHeightChangeRef = useRef(onContentHeightChange)
  onContentHeightChangeRef.current = onContentHeightChange

  // Trip iframeFailed if `mini-app:ready` doesn't arrive within the
  // handshake budget. Reset on `reloadKey` so the retry path gets a
  // fresh window.
  useEffect(() => {
    if (iframeReady) return
    const timer = window.setTimeout(() => {
      setIframeFailed(true)
    }, HANDSHAKE_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [iframeReady, reloadKey])

  const retryLoad = useCallback(() => {
    setIframeReady(false)
    setIframeFailed(false)
    setReloadKey((k) => k + 1)
  }, [])

  // Bake the host's active theme into the iframe URL so the runtime's
  // inline bootstrap script (index.html) applies it to <html> BEFORE
  // any CSS paints. Eliminates the parchment-default flash when the
  // host is in a different palette. Intentionally NOT depending on
  // themeId/resolvedTheme — live theme changes flow via postMessage
  // (mini-app:theme) and must NOT recompute the src, or the iframe
  // would reload and lose state on every host theme flip. Re-evaluates
  // only on retry (reloadKey++), at which point we capture the
  // current theme for the fresh iframe instance.
  const iframeSrc = useMemo(() => {
    const u = new URL(RUNTIME_PATH, window.location.origin)
    u.searchParams.set("theme", themeId)
    u.searchParams.set("mode", resolvedTheme)
    return u.toString()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey])

  // Hydrate saved state from the backend. Failures fall through
  // silently — a network blip on load shouldn't block the widget from
  // rendering; it just starts from undefined state.
  useEffect(() => {
    let active = true
    fetchMiniAppState(noteId)
      .then((state) => {
        if (!active) return
        savedStateRef.current = state
        setSavedStateLoaded(true)
      })
      .catch(() => {
        if (!active) return
        setSavedStateLoaded(true)
      })
    return () => {
      active = false
    }
  }, [noteId])

  // Register the message listener. Recreated whenever noteId changes
  // so the closure captures the right one for saveState routing.
  useEffect(() => {
    if (globalThis.__MINI_APP_HOST_DEBUG__) {
      globalThis.__MINI_APP_HOST_DEBUG__.mounts += 1
    }
    const handler = createMessageHandler({
      postToIframe: (msg) => {
        iframeRef.current?.contentWindow?.postMessage(msg, POST_TARGET)
      },
      getIframeWindow: () => iframeRef.current?.contentWindow ?? null,
      expectedOrigin: EXPECTED_ORIGIN,
      noteId,
      saveState: saveMiniAppState,
      toastInfo: (m) => toast(m),
      toastError: (m) => toast.error(m),
      onReady: () => {
        if (globalThis.__MINI_APP_HOST_DEBUG__) {
          globalThis.__MINI_APP_HOST_DEBUG__.readyEventsReceived += 1
          globalThis.__MINI_APP_HOST_DEBUG__.lastReadyFrom = RUNTIME_ORIGIN
        }
        setIframeReady(true)
      },
      onResize: (h) => {
        onContentHeightChangeRef.current?.(h)
      },
    })
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [noteId])

  // Once both signals are in (handshake + state fetched), kick off the
  // render. The theme payload is captured here too so the very first
  // paint already matches the host palette / mode. Theme is intentionally
  // NOT in this effect's dep list — flipping themes shouldn't trash the
  // widget's React tree; see the dedicated mini-app:theme effect below.
  useEffect(() => {
    if (!iframeReady || !savedStateLoaded) return
    iframeRef.current?.contentWindow?.postMessage(
      {
        type: "mini-app:render",
        source,
        savedState: savedStateRef.current,
        theme: { id: themeId, mode: resolvedTheme },
      },
      POST_TARGET,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iframeReady, savedStateLoaded, source])

  // Live theme propagation. Re-posts `mini-app:theme` whenever the host
  // theme changes so the iframe flips `data-theme`/`data-mode` on its
  // own <html> without remounting the widget. Gated on iframeReady so we
  // don't race the handshake; on first mount the render effect above
  // already carries the same payload, so the iframe receives one render
  // + one theme back-to-back — harmless, second is a no-op.
  useEffect(() => {
    if (!iframeReady) return
    iframeRef.current?.contentWindow?.postMessage(
      {
        type: "mini-app:theme",
        theme: { id: themeId, mode: resolvedTheme },
      },
      POST_TARGET,
    )
  }, [iframeReady, themeId, resolvedTheme])

  if (iframeFailed) {
    return (
      <div
        className={cn(
          "flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center",
          className,
        )}
      >
        <WarningIcon className="size-5 shrink-0 text-destructive" />
        <span className="text-sm font-medium text-destructive">
          Mini-app failed to load
        </span>
        <span className="text-xs text-muted-foreground">
          The runtime didn't respond. Network blip, bad deploy, or the iframe was blocked.
        </span>
        <button
          type="button"
          onClick={retryLoad}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent"
        >
          <ArrowClockwiseIcon className="size-3.5" />
          Retry
        </button>
      </div>
    )
  }

  return (
    <iframe
      key={reloadKey}
      ref={iframeRef}
      data-testid="mini-app-iframe"
      // `allow-same-origin` is included on purpose. Without it the iframe
      // has an opaque "null" origin, which (a) breaks Vite's HMR module
      // loading in dev (null-origin iframes can't load their own modules
      // due to SOP) and (b) blocks several browser APIs even in prod
      // (localStorage, IndexedDB, etc.).
      //
      // Security is still preserved because the iframe is loaded from
      // VITE_MINI_APP_ORIGIN, which is a *different origin from the host*
      // (different port in dev, different subdomain in prod). The host
      // → iframe boundary still blocks cross-origin DOM/cookie/storage
      // access. The iframe still cannot remove its own sandbox.
      //
      // ⚠ If the iframe is ever served from the SAME origin as the host
      // (e.g., a misconfig putting it on `dim0.net/mini-app/`),
      // `allow-same-origin` becomes catastrophic — the iframe could
      // then read host cookies/localStorage/DOM. Keep mini-app on its
      // own subdomain; the assertion below enforces it at boot.
      sandbox={SANDBOX}
      src={iframeSrc}
      title="mini-app"
      onError={() => setIframeFailed(true)}
      style={{
        width: "100%",
        // Fill the parent slot. The slot height is owned by the host: the
        // canvas card grows to fit the widget (capped at MAX_AUTO_GROW_PX
        // in the board view). When content exceeds that cap, the iframe's
        // own document scrolls — styled by the runtime's scrollbar-thin on
        // <html> — instead of being clipped.
        height: "100%",
        border: 0,
        display: "block",
      }}
      className={className}
    />
  )
}
