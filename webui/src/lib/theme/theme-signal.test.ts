import { afterEach, describe, expect, it, vi } from "vitest"

import { getThemeSignature, subscribeThemeChange } from "./theme-signal"

// theme-signal is a module singleton (one shared MutationObserver). These tests drive the
// real observer via <html> data-* mutations; a macrotask tick lets its microtask fire.

const tick = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.mode
})


describe("theme-signal", () => {
  it("notifies subscribers and advances the signature on a data-mode change", async () => {
    document.documentElement.dataset.mode = "light"
    const cb = vi.fn()
    const unsub = subscribeThemeChange(cb)
    document.documentElement.dataset.mode = "dark"
    await tick()
    expect(cb).toHaveBeenCalled()
    expect(getThemeSignature()).toBe(":dark")
    unsub()
  })

  it("stops notifying after unsubscribe", async () => {
    const cb = vi.fn()
    subscribeThemeChange(cb)() // subscribe then immediately unsubscribe
    document.documentElement.dataset.theme = "solar"
    await tick()
    expect(cb).not.toHaveBeenCalled()
  })

  it("a subscribe does NOT swallow a concurrent theme change (regression: current advances only via the observer)", async () => {
    // Prime a known signature so the next change is a real diff.
    document.documentElement.dataset.mode = "light"
    subscribeThemeChange(() => {})() // ensure the observer is installed
    await tick()

    document.documentElement.dataset.mode = "dark" // mutation queued
    const late = vi.fn()
    subscribeThemeChange(late) // lands before the observer microtask runs
    await tick()
    expect(late).toHaveBeenCalled() // the change was delivered, not swallowed
    expect(getThemeSignature()).toBe(":dark")
  })
})
