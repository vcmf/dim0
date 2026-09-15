import { afterEach, describe, expect, it } from "vitest"

import {
  clearAppletSnapshots,
  evictAppletSnapshot,
  getAppletSnapshot,
  getAppletSnapshotHash,
  setAppletSnapshot,
  snapshotKey,
} from "./snapshot-cache"

// A CanvasImageSource stand-in — the cache never inspects the image, only stores/returns
// it, so a tagged object suffices for identity assertions.
const img = (tag: string) => ({ tag }) as unknown as CanvasImageSource

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

  // MAX_SNAPSHOTS is 96; CAP+1 fills just past capacity.
  const CAP = 96

  it("bounds memory with an LRU: over capacity, the least-recently-used is dropped", () => {
    for (let i = 0; i <= CAP; i++) setAppletSnapshot(`k${i}`, img(`${i}`), "h") // CAP+1 entries
    expect(getAppletSnapshot("k0")).toBeNull() // oldest evicted
    expect(getAppletSnapshot(`k${CAP}`)).not.toBeNull() // newest kept
  })

  it("reads do NOT reorder recency (LRU is write-driven, so the paint hot path is pure)", () => {
    for (let i = 0; i < CAP; i++) setAppletSnapshot(`k${i}`, img(`${i}`), "h") // fills to cap
    getAppletSnapshot("k0") // a read must NOT rescue the oldest entry
    setAppletSnapshot(`k${CAP}`, img(`${CAP}`), "h") // over cap → evicts the oldest (k0)
    expect(getAppletSnapshot("k0")).toBeNull() // still evicted — the read didn't touch it
    expect(getAppletSnapshot("k1")).not.toBeNull()
  })

  it("a re-capture (write) refreshes recency so the rewritten entry survives", () => {
    for (let i = 0; i < CAP; i++) setAppletSnapshot(`k${i}`, img(`${i}`), "h") // fills to cap
    setAppletSnapshot("k0", img("0-new"), "h2") // re-capture k0 → now most-recent
    setAppletSnapshot(`k${CAP}`, img(`${CAP}`), "h") // over cap → evicts the now-oldest (k1)
    expect(getAppletSnapshot("k0")).toEqual({ tag: "0-new" }) // survived via the rewrite
    expect(getAppletSnapshot("k1")).toBeNull()
  })
})
