import { describe, expect, it } from "vitest"

import { withCaptureSlot } from "./capture-scheduler"

// Drain microtasks (a macrotask tick is safely after any pending promise jobs).
const flush = () => new Promise((r) => setTimeout(r, 0))

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}


describe("withCaptureSlot", () => {
  it("runs at most 2 tasks concurrently, queueing the rest until a slot frees", async () => {
    let active = 0
    let peak = 0
    const gates = [deferred(), deferred(), deferred(), deferred()]
    const task = (i: number) => async () => {
      active += 1
      peak = Math.max(peak, active)
      await gates[i].promise
      active -= 1
    }
    const runs = gates.map((_, i) => withCaptureSlot(task(i)))

    await flush()
    expect(peak).toBe(2) // only 2 of 4 started; the rest are queued

    // Free slots one at a time — each release should admit exactly one queued task.
    for (const g of gates) {
      g.resolve()
      await flush()
    }
    await Promise.all(runs)
    expect(peak).toBe(2) // never exceeded the limit across the whole run
  })

  it("releases the slot even when the task rejects, so later captures still run", async () => {
    await expect(withCaptureSlot(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    // If the slot leaked, this would hang; instead it runs immediately.
    await expect(withCaptureSlot(async () => 42)).resolves.toBe(42)
  })
})
