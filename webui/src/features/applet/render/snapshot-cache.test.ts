import { afterEach, describe, expect, it } from "vitest"

import {
  clearAppletSnapshots,
  evictAppletSnapshot,
  getAppletSnapshot,
  getAppletSnapshotForPaint,
  getAppletSnapshotHash,
  setAppletSnapshot,
  snapshotKey,
} from "./snapshot-cache"

// A CanvasImageSource stand-in — the cache reads natural dims for byte accounting, so a
// tagged object with dims suffices. `img` (dimensionless → ~1 byte) for identity tests;
// `sized` for byte-budget eviction tests. Default ~21 MB each (2300² × 4), so 3 fit under
// the ~64 MB budget and a 4th overflows it.
const img = (tag: string) => ({ tag }) as unknown as CanvasImageSource
const sized = (tag: string, w = 2300, h = 2300) => ({ tag, naturalWidth: w, naturalHeight: h }) as unknown as CanvasImageSource

afterEach(() => clearAppletSnapshots())


describe("snapshotKey", () => {
  it("is deterministic for the same inputs", () => {
    expect(snapshotKey("<Chart/>", { a: 1 }, "dark:")).toBe(snapshotKey("<Chart/>", { a: 1 }, "dark:"))
  })

  it("is independent of object key order in state", () => {
    expect(snapshotKey("s", { a: 1, b: 2 }, "t")).toBe(snapshotKey("s", { b: 2, a: 1 }, "t"))
  })

  it("changes when source, state, or theme changes", () => {
    const base = snapshotKey("s", { a: 1 }, "light:")
    expect(snapshotKey("s2", { a: 1 }, "light:")).not.toBe(base) // source
    expect(snapshotKey("s", { a: 2 }, "light:")).not.toBe(base) // state
    expect(snapshotKey("s", { a: 1 }, "dark:")).not.toBe(base) // theme
  })

  it("does not throw on non-serializable state (cyclic) — degrades to a constant tail", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => snapshotKey("s", cyclic, "t")).not.toThrow()
    // two different cyclic states hash equal (state contribution collapses), by design
    const other: Record<string, unknown> = { x: 1 }
    other.self = other
    expect(snapshotKey("s", cyclic, "t")).toBe(snapshotKey("s", other, "t"))
  })
})


describe("snapshot cache", () => {
  it("stores and retrieves an image + its hash", () => {
    setAppletSnapshot("n1", img("a"), "h1")
    expect(getAppletSnapshot("n1")).toEqual({ tag: "a" })
    expect(getAppletSnapshotHash("n1")).toBe("h1")
  })

  it("returns null / null for an absent id", () => {
    expect(getAppletSnapshot("missing")).toBeNull()
    expect(getAppletSnapshotHash("missing")).toBeNull()
  })

  it("replaces an existing entry (latest image + hash win)", () => {
    setAppletSnapshot("n1", img("old"), "h1")
    setAppletSnapshot("n1", img("new"), "h2")
    expect(getAppletSnapshot("n1")).toEqual({ tag: "new" })
    expect(getAppletSnapshotHash("n1")).toBe("h2")
  })

  it("evicts a single entry, and clears all", () => {
    setAppletSnapshot("n1", img("a"), "h")
    setAppletSnapshot("n2", img("b"), "h")
    evictAppletSnapshot("n1")
    expect(getAppletSnapshot("n1")).toBeNull()
    expect(getAppletSnapshot("n2")).not.toBeNull()
    clearAppletSnapshots()
    expect(getAppletSnapshot("n2")).toBeNull()
  })

  // The budget is ~64 MB; ~21 MB/`sized` image → 5 entries (~106 MB) overflows it.
  it("bounds memory by BYTES, evicting least-recently-written until under budget", () => {
    for (let i = 0; i < 5; i++) setAppletSnapshot(`k${i}`, sized(`${i}`), "h") // ~106 MB total
    expect(getAppletSnapshot("k0")).toBeNull() // oldest evicted to get under ~64 MB
    expect(getAppletSnapshot("k4")).not.toBeNull() // newest kept
  })

  it("keeps a single entry larger than the whole budget (never evicts what was just written)", () => {
    setAppletSnapshot("huge", sized("huge", 5000, 5000), "h") // ~100 MB, alone over budget
    expect(getAppletSnapshot("huge")).not.toBeNull()
  })

  it("reads do NOT reorder recency (LRU is write-driven, so the paint hot path is pure)", () => {
    for (let i = 0; i < 3; i++) setAppletSnapshot(`k${i}`, sized(`${i}`), "h") // ~50 MB
    getAppletSnapshot("k0") // a read must NOT rescue the oldest entry
    setAppletSnapshot("k3", sized("3"), "h") // ~67 MB → evicts the oldest (k0)
    expect(getAppletSnapshot("k0")).toBeNull() // still evicted — the read didn't touch it
    expect(getAppletSnapshot("k1")).not.toBeNull()
  })

  it("a re-capture (write) refreshes recency so the rewritten entry survives", () => {
    for (let i = 0; i < 3; i++) setAppletSnapshot(`k${i}`, sized(`${i}`), "h") // ~50 MB
    setAppletSnapshot("k0", sized("0-new"), "h2") // re-capture k0 → now most-recent
    setAppletSnapshot("k3", sized("3"), "h") // ~67 MB → evicts the now-oldest (k1)
    expect((getAppletSnapshot("k0") as unknown as { tag: string }).tag).toBe("0-new") // survived
    expect(getAppletSnapshot("k1")).toBeNull()
  })
})


describe("getAppletSnapshotForPaint (recency-capped placeholder)", () => {
  it("draws a bitmap only for the 10 most-recently-captured applets; older ones → glyph (null)", () => {
    for (let i = 0; i < 15; i++) setAppletSnapshot(`p${i}`, img(`${i}`), "h") // 15 cached
    // Total bitmaps bounded to 10 regardless of how many are queried (timing-independent).
    const drawn = Array.from({ length: 15 }, (_, i) => getAppletSnapshotForPaint(`p${i}`)).filter(Boolean).length
    expect(drawn).toBe(10)
    expect(getAppletSnapshotForPaint("p14")).not.toBeNull() // newest → bitmap
    expect(getAppletSnapshotForPaint("p5")).not.toBeNull() // 10th-newest → bitmap
    expect(getAppletSnapshotForPaint("p4")).toBeNull() // beyond MRU-10 → glyph
    expect(getAppletSnapshotForPaint("p0")).toBeNull() // oldest → glyph
  })

  it("a re-capture moves an old applet back into the eligible set (and pushes one out)", () => {
    for (let i = 0; i < 15; i++) setAppletSnapshot(`q${i}`, img(`${i}`), "h")
    expect(getAppletSnapshotForPaint("q0")).toBeNull() // too old to be eligible
    setAppletSnapshot("q0", img("0new"), "h2") // re-capture → now newest
    expect(getAppletSnapshotForPaint("q0")).not.toBeNull() // eligible again
    expect(getAppletSnapshotForPaint("q5")).toBeNull() // pushed out of the newest-10
  })

  it("evict + clear keep the eligible set consistent", () => {
    for (let i = 0; i < 12; i++) setAppletSnapshot(`e${i}`, img(`${i}`), "h") // eligible: e2..e11
    evictAppletSnapshot("e11") // drop the newest → e1 slides into the newest-10
    expect(getAppletSnapshotForPaint("e11")).toBeNull() // gone
    expect(getAppletSnapshotForPaint("e1")).not.toBeNull() // now within the newest-10
    clearAppletSnapshots()
    expect(getAppletSnapshotForPaint("e10")).toBeNull() // nothing eligible after clear
  })
})
