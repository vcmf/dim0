// Run a callback when the main thread is idle — used to defer non-urgent work (e.g.
// rasterizing an applet snapshot) off the interaction path. WebKit (Tauri's engine) is
// single-threaded, so idle-scheduling matters there most; it also lacks a stable
// requestIdleCallback in older WKWebView, hence the rAF fallback.

/** Opaque handle returned by {@link scheduleIdle}; pass it to {@link cancelIdle}. */
export type IdleHandle = { id: number; kind: "idle" | "raf" }


/**
 * Schedule `cb` to run once when the main thread is idle. Uses `requestIdleCallback`
 * where available (with a `timeout` so it can't be starved indefinitely), else falls
 * back to `requestAnimationFrame` (Safari/older WKWebView). Returns a handle for
 * {@link cancelIdle}. In a non-browser context (SSR/test without timers) it no-ops.
 */
export function scheduleIdle(cb: () => void, timeoutMs = 2000): IdleHandle {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    return { id: window.requestIdleCallback(() => cb(), { timeout: timeoutMs }), kind: "idle" }
  }
  if (typeof requestAnimationFrame === "function") {
    return { id: requestAnimationFrame(() => cb()), kind: "raf" }
  }
  return { id: 0, kind: "raf" }
}


/** Cancel a pending {@link scheduleIdle} callback (no-op if it already ran). */
export function cancelIdle(handle: IdleHandle | null | undefined): void {
  if (!handle) return
  if (handle.kind === "idle" && typeof window !== "undefined" && typeof window.cancelIdleCallback === "function") {
    window.cancelIdleCallback(handle.id)
  } else if (handle.kind === "raf" && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(handle.id)
  }
}
