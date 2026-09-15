// A bounded, in-memory cache of rasterized applet snapshots, keyed by node id.
//
// The canvas-harness core paints a zoomed-out / motion applet by calling the node
// def's `getSnapshot(node)` and blitting whatever CanvasImageSource it returns
// (falling back to the glyph placeholder when it returns null). That call is
// synchronous, so the async snapDOM capture (use-applet-snapshot.ts) writes here and
// `getSnapshot` reads here — this module is the hand-off between the two.
//
// Entries carry a content HASH (source + persisted state + theme) so the capturer can
// tell a fresh snapshot from a stale one and re-rasterize only when the applet actually
// changed. The cache is a bounded LRU so a huge board can't grow snapshot memory without
// limit; an evicted applet simply falls back to the glyph until it's re-captured.

import { subscribeThemeChange } from "@/lib/theme/theme-signal"

// The cache is bounded by BYTES, not entry count — snapshots are decoded bitmaps whose
// size is the applet node's own box (a 300×220 applet ≈ 0.35 MB at ≤1 device px), so a
// fixed count would let big applets blow the budget. We evict the least-recently-written
// until under this ceiling. Tunable post-measurement.
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024 // ~64 MB of decoded snapshots
// A secondary hard cap on entry COUNT — guards against pathological tiny images filling
// the map without hitting the byte budget (belt-and-suspenders; not normally reached).
const MAX_SNAPSHOT_ENTRIES = 512


interface SnapshotEntry {
  img: CanvasImageSource
  hash: string
  bytes: number
}


// Running total of `bytes` across all cache entries, kept in sync with the map.
let totalBytes = 0


/** Estimate the decoded-bitmap bytes of an image (w·h·4, RGBA). Reads natural dims from
 *  an <img>, else width/height (canvas/bitmap); unknown → 1 so an entry always counts. */
function bytesOf(img: CanvasImageSource): number {
  const any = img as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number }
  const w = any.naturalWidth || any.width || 0
  const h = any.naturalHeight || any.height || 0
  return Math.max(1, w * h * 4)
}


// Insertion-ordered Map used as an LRU: a WRITE (setAppletSnapshot) moves an entry to
// the newest slot, and eviction drops the oldest (first) key. Reads deliberately do NOT
// reorder — see getAppletSnapshot.
const cache = new Map<string, SnapshotEntry>()


/** The snapshot image for `id`, or `null` if none is cached (→ glyph fallback). A PURE
 *  read — it does NOT touch LRU order, because `getSnapshot` calls this on the canvas
 *  paint hot path (every frame, per zoomed-out node); a per-frame Map mutation there
 *  would churn the map and make recency mean "whatever painted last frame". Recency is
 *  instead driven by writes (a re-capture), which is when an applet is actually live.
 *
 *  KNOWN LIMITATION (acceptable, self-healing): because recency is write-driven, a static
 *  snapshot that's still being blitted but never re-captured ages toward the LRU tail and
 *  can be evicted by newer captures when the board exceeds the byte budget. The result is
 *  a glyph fallback (never broken output), which re-captures the next time that applet is
 *  live + settled. Tune MAX_SNAPSHOT_BYTES if the post-measurement board shows a flash. */
export function getAppletSnapshot(id: string): CanvasImageSource | null {
  return cache.get(id)?.img ?? null
}


// NOTE: a per-placeholder BITMAP cap (draw at most N snapshots, glyph the rest) was
// attempted and reverted. Both tried mechanisms were wrong: a per-paint counter never bit
// (the harness strip-renders a subset of nodes per frame, so it can't detect a "pass"),
// and cache-recency (newest-N) froze the eligible set to an off-screen group while zoomed
// out (snapshots are consumed exactly when applets are NOT live, so nothing re-captures to
// move the window) — making the applets you're actually viewing fall back to glyphs. A
// CORRECT cap must know which applets are nearest the viewport, which `getSnapshot` isn't
// told (only `node`, no camera). The right fix is camera-aware: either a board-level
// nearest-center budget fed from the canvas store, or a `@canvas-harness` SnapshotEnv change
// that hands the draw its target size (which also gives zoom-matched resolution). Until then
// we bound cost via the dpr-1 capture (small bitmaps), not by count.


/** The content hash of the cached snapshot for `id`, or `null` if none — lets the
 *  capturer skip re-rasterizing an applet whose content/theme hasn't changed. */
export function getAppletSnapshotHash(id: string): string | null {
  return cache.get(id)?.hash ?? null
}


/** Store (or replace) the snapshot for `id`, then evict least-recently-written entries
 *  until the cache is under the byte budget (and entry cap). The just-written entry is
 *  never evicted — a single applet larger than the whole budget is still kept. */
export function setAppletSnapshot(id: string, img: CanvasImageSource, hash: string): void {
  const existing = cache.get(id)
  if (existing) {
    totalBytes -= existing.bytes
    cache.delete(id)
  }
  const bytes = bytesOf(img)
  cache.set(id, { img, hash, bytes }) // newest → last in insertion order
  totalBytes += bytes

  while (cache.size > 1 && (totalBytes > MAX_SNAPSHOT_BYTES || cache.size > MAX_SNAPSHOT_ENTRIES)) {
    const oldest = cache.keys().next().value
    if (oldest === undefined || oldest === id) break // don't evict the entry we just wrote
    totalBytes -= cache.get(oldest)!.bytes
    cache.delete(oldest)
  }
}


/** Drop the snapshot for `id` — call when the applet node is deleted. */
export function evictAppletSnapshot(id: string): void {
  const entry = cache.get(id)
  if (entry) {
    totalBytes -= entry.bytes
    cache.delete(id)
  }
}


/** Drop every snapshot (test hook / global theme reset). */
export function clearAppletSnapshots(): void {
  cache.clear()
  totalBytes = 0
}


// A snapshot bakes in the theme's colors. On a zoomed-out board every applet paints from
// this cache with NO live view to re-capture, so on a theme flip we must drop them all —
// otherwise the whole board would show old-theme snapshots until each applet is zoomed
// back in. Cleared → glyph placeholder (which re-themes live) until re-captured. Process-
// lifetime subscription (the cache lives for the app's lifetime); no unsubscribe needed.
subscribeThemeChange(clearAppletSnapshots)


/**
 * A stable content hash over the inputs that determine an applet's rendered pixels:
 * its `source`, its persisted `state`, and the active `themeSig` (theme flips recolor
 * the render). TWO independent 32-bit rolling hashes concatenated → an effectively 64-bit
 * key: a single 32-bit hash risks a same-value collision with the cached hash, which
 * would make a genuinely-changed applet skip re-capture and paint stale (a silent wrong
 * render, not a safe glyph). Deterministic + key-sorted; non-serializable state degrades
 * to a constant, so such an applet just isn't re-captured on state change.
 */
export function snapshotKey(source: string, state: unknown, themeSig: string): string {
  // Length-prefix each field (`len:field`) so the concatenation is UNAMBIGUOUS regardless
  // of what the fields contain — `source` is arbitrary applet JSX and can hold any separator
  // string, so a plain delimiter (or a NUL, which also turned the file binary) isn't safe.
  const payload = [themeSig, source, stableStringify(state)].map((p) => `${p.length}:${p}`).join("")
  let h1 = 5381 // djb2 (xor variant)
  let h2 = 52711 // second seed, add variant → independent of h1
  for (let i = 0; i < payload.length; i++) {
    const c = payload.charCodeAt(i)
    h1 = ((h1 << 5) + h1) ^ c
    h2 = ((h2 << 5) + h2) + c
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0")
}


/** JSON.stringify with object keys sorted, so equal state hashes regardless of key
 *  insertion order. Falls back to "" if the value can't be serialized (cycles, etc.). */
function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, val) => {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        return Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      }
      return val
    }) ?? ""
  } catch {
    return ""
  }
}
