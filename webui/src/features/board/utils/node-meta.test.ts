import { describe, expect, it } from "vitest"
import { bumpMeta, freshMeta, nodeStamp } from "./node-meta"


describe("freshMeta", () => {
  it("stamps createdAt == updatedAt at the given instant, v:1", () => {
    const m = freshMeta(1000)
    expect(m).toEqual({ v: 1, createdAt: 1000, updatedAt: 1000 })
  })
})


describe("bumpMeta", () => {
  it("preserves createdAt, advances updatedAt, increments the version", () => {
    const prev = freshMeta(1000)
    const next = bumpMeta(prev, 2000)
    expect(next).toEqual({ v: 2, createdAt: 1000, updatedAt: 2000 })
  })

  it("treats a missing prev as a fresh stamp (v:1, createdAt == now)", () => {
    expect(bumpMeta(undefined, 2000)).toEqual({ v: 1, createdAt: 2000, updatedAt: 2000 })
  })
})


describe("nodeStamp", () => {
  it("reads canonical meta (numbers) and flags an edited node", () => {
    const { iso, edited } = nodeStamp({ meta: { createdAt: 1000, updatedAt: 2000 } })
    expect(iso).toBe(new Date(2000).toISOString()) // last-touched = updatedAt
    expect(edited).toBe(true)
  })

  it("is not 'edited' when createdAt == updatedAt", () => {
    expect(nodeStamp({ meta: { createdAt: 1000, updatedAt: 1000 } }).edited).toBe(false)
  })

  it("falls back to legacy top-level ISO strings when meta is absent", () => {
    const created = new Date(1000).toISOString()
    const updated = new Date(2000).toISOString()
    const { iso, edited } = nodeStamp({ createdAt: created, updatedAt: updated })
    expect(iso).toBe(updated)
    expect(edited).toBe(true)
  })

  it("prefers meta over the legacy strings when both are present", () => {
    const { iso } = nodeStamp({
      createdAt: new Date(5000).toISOString(),
      meta: { createdAt: 1000, updatedAt: 1000 },
    })
    expect(iso).toBe(new Date(1000).toISOString())
  })

  it("returns iso:null and edited:false when nothing is known", () => {
    expect(nodeStamp(undefined)).toEqual({ iso: null, edited: false })
    expect(nodeStamp({})).toEqual({ iso: null, edited: false })
  })

  it("ignores an unparseable legacy string", () => {
    expect(nodeStamp({ createdAt: "not-a-date" })).toEqual({ iso: null, edited: false })
  })

  it("uses createdAt when only createdAt is present (created, not edited)", () => {
    const { iso, edited } = nodeStamp({ meta: { createdAt: 1000 } })
    expect(iso).toBe(new Date(1000).toISOString())
    expect(edited).toBe(false)
  })
})
