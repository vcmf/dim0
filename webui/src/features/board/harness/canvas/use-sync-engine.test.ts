import { afterEach, describe, expect, it } from "vitest"
import type { BoardMeta } from "@/features/board/model"
import { browserAgentActiveFor, resolveSyncEngine } from "./use-sync-engine"


const meta = (syncEngine?: "legacy" | "v2"): BoardMeta => ({
  id: "b1",
  title: "B",
  kind: "synced",
  syncEngine,
  visibility: "private",
  createdAt: 0,
  updatedAt: 0,
})


describe("resolveSyncEngine", () => {
  it("defaults to v2 when no meta and no override (Phase 1: v2 is the default)", () => {
    expect(resolveSyncEngine(undefined, false)).toBe("v2")
  })

  it("reads the stored engine from meta (incl. the legacy-pin escape hatch)", () => {
    expect(resolveSyncEngine(meta("v2"), false)).toBe("v2")
    expect(resolveSyncEngine(meta("legacy"), false)).toBe("legacy") // pin holds a board on legacy
  })

  it("treats meta without syncEngine as v2 (the default)", () => {
    expect(resolveSyncEngine(meta(undefined), false)).toBe("v2")
  })

  it("dev override forces v2 regardless of stored engine or missing meta", () => {
    expect(resolveSyncEngine(undefined, true)).toBe("v2")
    expect(resolveSyncEngine(meta("legacy"), true)).toBe("v2")
    expect(resolveSyncEngine(meta("v2"), true)).toBe("v2")
  })
})


describe("browserAgentActiveFor", () => {
  afterEach(() => {
    localStorage.clear()
  })

  it("is always on for a local-only board, regardless of the resolved engine", () => {
    // Local boards have no sync engine (null) but must still run the browser agent.
    expect(browserAgentActiveFor(true, null)).toBe(true)
    expect(browserAgentActiveFor(true, "v2")).toBe(true)
    expect(browserAgentActiveFor(true, "legacy")).toBe(true)
  })

  it("runs the browser agent on a v2 synced board when the flag is on (default)", () => {
    expect(browserAgentActiveFor(false, "v2")).toBe(true)
  })

  it("KEEPS a legacy-sync board on the backend agent even with the flag on (no data loss)", () => {
    // The legacy relay has no DB persistence, so the browser agent must not run.
    expect(browserAgentActiveFor(false, "legacy")).toBe(false)
  })

  it("defers to the backend agent while a synced board's engine is still resolving", () => {
    expect(browserAgentActiveFor(false, null)).toBe(false)
  })

  it("honours the flag opt-out on a v2 synced board", () => {
    localStorage.setItem("dim0_local_agent_on_synced", "0")
    expect(browserAgentActiveFor(false, "v2")).toBe(false)
  })
})
