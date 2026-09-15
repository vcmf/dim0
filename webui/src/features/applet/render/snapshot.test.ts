import { snapdom } from "@zumer/snapdom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { snapshotApplet } from "./snapshot"

// snapDOM needs a real canvas/DOM engine, so mock it — we're testing snapshotApplet's
// orchestration (readiness wait, decode, failure→null), not snapDOM itself.
vi.mock("@zumer/snapdom", () => ({
  snapdom: vi.fn(async () => ({ toPng: async () => fakeImg() })),
}))

function fakeImg(): HTMLImageElement {
  return { src: "data:image/png;base64,AA", decode: async () => {} } as unknown as HTMLImageElement
}

const mockedSnapdom = vi.mocked(snapdom)

beforeEach(() => {
  mockedSnapdom.mockClear()
  mockedSnapdom.mockImplementation(async () => ({ toPng: async () => fakeImg() }) as never)
})
afterEach(() => {
  document.body.innerHTML = ""
})


describe("snapshotApplet", () => {
  it("captures an element with no pending canvas leaves and returns the decoded image", async () => {
    const el = document.createElement("div")
    document.body.appendChild(el)
    const img = await snapshotApplet(el)
    expect(img).not.toBeNull()
    expect(mockedSnapdom).toHaveBeenCalledOnce()
  })

  it("returns null (never throws) when snapDOM fails — e.g. a tainted canvas", async () => {
    mockedSnapdom.mockRejectedValueOnce(new Error("tainted canvas"))
    const el = document.createElement("div")
    const img = await snapshotApplet(el)
    expect(img).toBeNull()
  })

  it("waits for a not-yet-ready canvas leaf, then captures once it commits", async () => {
    const el = document.createElement("div")
    const leaf = document.createElement("canvas")
    leaf.dataset.captureReady = "false" // not yet painted
    el.appendChild(leaf)
    document.body.appendChild(el)

    const pending = snapshotApplet(el, { timeoutMs: 1000 })
    // Not captured yet — still waiting on the leaf.
    await Promise.resolve()
    expect(mockedSnapdom).not.toHaveBeenCalled()

    leaf.dataset.captureReady = "true" // leaf commits
    const img = await pending
    expect(img).not.toBeNull()
    expect(mockedSnapdom).toHaveBeenCalledOnce()
  })

  it("aborts without rasterizing when shouldCancel trips (applet went off-screen)", async () => {
    const el = document.createElement("div")
    document.body.appendChild(el)
    const img = await snapshotApplet(el, { shouldCancel: () => true })
    expect(img).toBeNull()
    expect(mockedSnapdom).not.toHaveBeenCalled() // never paid for the raster
  })

  it("snaps anyway once the readiness timeout elapses (a stuck leaf can't block forever)", async () => {
    const el = document.createElement("div")
    const leaf = document.createElement("canvas")
    leaf.dataset.captureReady = "false" // never flips
    el.appendChild(leaf)
    document.body.appendChild(el)

    const img = await snapshotApplet(el, { timeoutMs: 30 })
    expect(img).not.toBeNull() // captured after the timeout
    expect(mockedSnapdom).toHaveBeenCalledOnce()
  })
})
