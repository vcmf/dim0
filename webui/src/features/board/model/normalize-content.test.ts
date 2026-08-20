import { describe, expect, it } from "vitest"
import type { BoardContent, DimEdge, DimNode } from "."
import { labelText, normalizeBoardContent } from "."


const node = (id: string, label: unknown): DimNode =>
  ({ id, type: "rect", x: 0, y: 0, w: 1, h: 1, angle: 0, z: 0, groups: [], data: { label, meta: { v: 1, createdAt: 0, updatedAt: 0 } } }) as unknown as DimNode


const edge = (id: string, opts: { label?: unknown; content?: string }): DimEdge =>
  ({ id, source: { nodeId: "a" }, target: { nodeId: "b" }, pathStyle: "bezier", z: 0, groups: [], content: opts.content, data: { label: opts.label, meta: { v: 1, createdAt: 0, updatedAt: 0 } } }) as unknown as DimEdge


const content = (nodes: DimNode[], edges: DimEdge[] = []): BoardContent =>
  ({ schemaVersion: 1, nodes, edges, groups: [] }) as unknown as BoardContent


describe("normalizeBoardContent", () => {
  it("coerces a legacy bare-string node label to RichText", () => {
    const out = normalizeBoardContent(content([node("n", "Legacy Title")]))
    expect(out.nodes[0].data?.label).toEqual({ markdown: "Legacy Title" })
  })


  it("leaves a RichText node label untouched (keeps identity — no churn)", () => {
    const n = node("n", { markdown: "Already Rich" })
    const out = normalizeBoardContent(content([n]))
    expect(out.nodes[0]).toBe(n) // unchanged node keeps its reference
  })


  it("migrates a legacy string edge label to content and strips the dead field", () => {
    const out = normalizeBoardContent(content([], [edge("e", { label: "causes" })]))
    expect(out.edges[0].content).toBe("causes") // the field the harness renders
    expect((out.edges[0].data as { label?: unknown })?.label).toBeUndefined()
  })


  it("migrates a legacy RichText edge label to content", () => {
    const out = normalizeBoardContent(content([], [edge("e", { label: { markdown: "leads to" } })]))
    expect(out.edges[0].content).toBe("leads to")
  })


  it("keeps existing edge.content over a stale data.label", () => {
    const out = normalizeBoardContent(content([], [edge("e", { label: "stale", content: "real" })]))
    expect(out.edges[0].content).toBe("real")
  })


  it("is idempotent — a normalized content re-normalizes to the same labels", () => {
    const once = normalizeBoardContent(content([node("n", "T")], [edge("e", { label: "causes" })]))
    const twice = normalizeBoardContent(once)
    expect(labelText(twice.nodes[0].data?.label)).toBe("T")
    expect(twice.edges[0].content).toBe("causes")
    expect((twice.edges[0].data as { label?: unknown })?.label).toBeUndefined()
  })
})
