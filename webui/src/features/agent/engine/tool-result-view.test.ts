import { describe, expect, it } from "vitest"

import {
  BULKY_RESULT_CHARS,
  KEEP_FULL_CEILING_CHARS,
  KEEP_RECENT_TOOL_RESULTS,
  buildModelMessages,
  clearedResultText,
  type ToolMsgMeta,
} from "./tool-result-view"
import type { LlmMessage } from "./types"


// A bulky tool result of `n` chars, id `id`, from `toolName`.
function bulky(id: string, toolName = "fetch", n = BULKY_RESULT_CHARS + 100): Extract<LlmMessage, { role: "tool" }> {
  return { role: "tool", toolCallId: id, toolName, content: "x".repeat(n) }
}


// Default meta: nothing is keepFull; toolName read off the message.
const meta = (m: Extract<LlmMessage, { role: "tool" }>): ToolMsgMeta => ({ toolName: m.toolName ?? "tool", keepFull: false })


describe("buildModelMessages", () => {
  it("keeps a lone bulky result whole (it's the most recent)", () => {
    const msgs: LlmMessage[] = [{ role: "user", content: "hi" }, bulky("a")]
    const out = buildModelMessages(msgs, meta, new Set())
    expect(out[1]).toEqual(msgs[1])
  })

  it("elides bulky results older than the recent window", () => {
    // KEEP_RECENT + 1 bulky results → the oldest one is elided, the rest kept.
    const ids = Array.from({ length: KEEP_RECENT_TOOL_RESULTS + 1 }, (_, i) => `b${i}`)
    const msgs: LlmMessage[] = ids.map((id) => bulky(id))
    const out = buildModelMessages(msgs, meta, new Set()) as Extract<LlmMessage, { role: "tool" }>[]
    expect(out[0].content).toBe(clearedResultText("fetch")) // oldest elided
    for (let i = 1; i < out.length; i += 1) expect(out[i].content).not.toContain("cleared") // recent kept
  })

  it("never elides a small result, however old", () => {
    const small: LlmMessage = { role: "tool", toolCallId: "s", toolName: "get_note", content: '{"id":"n1"}' }
    const msgs: LlmMessage[] = [small, ...Array.from({ length: KEEP_RECENT_TOOL_RESULTS }, (_, i) => bulky(`b${i}`))]
    const out = buildModelMessages(msgs, meta, new Set())
    expect(out[0]).toEqual(small)
  })

  it("never elides a keepFull result, but bounds it at the hard ceiling", () => {
    const keepMeta = (m: Extract<LlmMessage, { role: "tool" }>): ToolMsgMeta => ({ toolName: m.toolName ?? "tool", keepFull: true })
    const skill = bulky("k", "learn_generate_applet", 30000)
    const [outSkill] = buildModelMessages([skill], keepMeta, new Set()) as Extract<LlmMessage, { role: "tool" }>[]
    expect(outSkill).toEqual(skill) // under the ceiling → whole

    const runaway = bulky("r", "learn_generate_applet", KEEP_FULL_CEILING_CHARS + 5000)
    const [outRunaway] = buildModelMessages([runaway], keepMeta, new Set()) as Extract<LlmMessage, { role: "tool" }>[]
    expect(outRunaway.content.length).toBeLessThan(runaway.content.length)
    expect(outRunaway.content).toContain("truncated")
  })

  it("freezes a result once shown full — it is never re-elided as it ages (cache stability)", () => {
    const sentFull = new Set<string>()
    // Turn 1: one bulky result, kept full → frozen.
    buildModelMessages([bulky("a")], meta, sentFull)
    expect(sentFull.has("a")).toBe(true)

    // Turns later: `a` has aged past the window, but being frozen it stays full.
    const later: LlmMessage[] = [bulky("a"), ...Array.from({ length: KEEP_RECENT_TOOL_RESULTS }, (_, i) => bulky(`n${i}`))]
    const out = buildModelMessages(later, meta, sentFull) as Extract<LlmMessage, { role: "tool" }>[]
    expect(out[0].content).not.toContain("cleared") // frozen → still whole
  })

  it("is deterministic — same log + freeze set yields byte-identical output", () => {
    const ids = Array.from({ length: KEEP_RECENT_TOOL_RESULTS + 2 }, (_, i) => `b${i}`)
    const msgs: LlmMessage[] = ids.map((id) => bulky(id))
    const a = buildModelMessages(msgs, meta, new Set())
    const b = buildModelMessages(msgs, meta, new Set())
    expect(a).toEqual(b)
  })

  it("passes non-tool messages through untouched", () => {
    const msgs: LlmMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "fetch", arguments: "{}" }] },
    ]
    expect(buildModelMessages(msgs, meta, new Set())).toEqual(msgs)
  })
})
