import { describe, expect, it } from "vitest"

import {
  BULKY_RESULT_CHARS,
  RESULT_CEILING_CHARS,
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

const tools = (out: LlmMessage[]) => out.filter((m): m is Extract<LlmMessage, { role: "tool" }> => m.role === "tool")


describe("buildModelMessages", () => {
  it("keeps a lone bulky result whole (it's the most recent)", () => {
    const msgs: LlmMessage[] = [{ role: "user", content: "hi" }, bulky("a")]
    const out = buildModelMessages(msgs, meta, new Set())
    expect(out[1]).toEqual(msgs[1])
  })

  it("shows every result at least once, then elides the aged ones on the next view", () => {
    // KEEP_RECENT + 2 bulky results produced in one turn: the FIRST view keeps them
    // all (none has been shown yet — the seen-once guarantee), so the model never
    // loses fresh output even beyond K.
    const ids = Array.from({ length: KEEP_RECENT_TOOL_RESULTS + 2 }, (_, i) => `b${i}`)
    const msgs: LlmMessage[] = ids.map((id) => bulky(id))
    const shown = new Set<string>()
    const first = buildModelMessages(msgs, meta, shown)
    for (const m of tools(first)) expect(m.content).not.toContain("cleared") // all shown once

    // A LATER view (same set, results now seen): the oldest two have aged out and elide.
    const second = tools(buildModelMessages(msgs, meta, shown))
    expect(second[0].content).toBe(clearedResultText("fetch"))
    expect(second[1].content).toBe(clearedResultText("fetch"))
    for (let i = 2; i < second.length; i += 1) expect(second[i].content).not.toContain("cleared")
  })

  it("elides a result once it has aged out AND been shown (no permanent freeze)", () => {
    const shown = new Set<string>()
    buildModelMessages([bulky("a")], meta, shown) // a shown
    const later: LlmMessage[] = [bulky("a"), ...Array.from({ length: KEEP_RECENT_TOOL_RESULTS }, (_, i) => bulky(`n${i}`))]
    const out = tools(buildModelMessages(later, meta, shown))
    expect(out[0].content).toBe(clearedResultText("fetch")) // aged out + shown → elided
  })

  it("caps a single runaway recent result at the hard ceiling (protects fetch, not just skills)", () => {
    const huge = bulky("h", "fetch", RESULT_CEILING_CHARS + 50000)
    const [out] = tools(buildModelMessages([huge], meta, new Set()))
    expect(out.content.length).toBeLessThan(huge.content.length)
    expect(out.content).toContain("omitted")
    // The ceiling marker must NOT invite a re-call: a deterministic tool would
    // reproduce the same head → a futile loop (the anti-pattern this PR removed).
    expect(out.content).not.toContain("re-call")
    expect(out.toolName).toBe("fetch")
  })

  it("preserves toolName on an elided message", () => {
    const ids = Array.from({ length: KEEP_RECENT_TOOL_RESULTS + 1 }, (_, i) => `b${i}`)
    const msgs: LlmMessage[] = ids.map((id) => bulky(id, "web_search"))
    const shown = new Set<string>()
    buildModelMessages(msgs, meta, shown) // show once
    const out = tools(buildModelMessages(msgs, meta, shown))
    expect(out[0].toolName).toBe("web_search")
  })

  it("never elides a small result, however old", () => {
    const small: LlmMessage = { role: "tool", toolCallId: "s", toolName: "get_note", content: '{"id":"n1"}' }
    const msgs: LlmMessage[] = [small, ...Array.from({ length: KEEP_RECENT_TOOL_RESULTS + 1 }, (_, i) => bulky(`b${i}`))]
    const shown = new Set<string>()
    buildModelMessages(msgs, meta, shown)
    const out = buildModelMessages(msgs, meta, shown)
    expect(out[0]).toEqual(small)
  })

  it("never elides a keepFull result, but bounds it at the hard ceiling", () => {
    const keepMeta = (m: Extract<LlmMessage, { role: "tool" }>): ToolMsgMeta => ({ toolName: m.toolName ?? "tool", keepFull: true })
    const skill = bulky("k", "learn_generate_applet", 30000)
    // Many later bulky results; the skill still isn't elided.
    const msgs: LlmMessage[] = [skill, ...Array.from({ length: KEEP_RECENT_TOOL_RESULTS + 3 }, (_, i) => bulky(`b${i}`))]
    const shown = new Set<string>()
    buildModelMessages(msgs, keepMeta, shown)
    const out = tools(buildModelMessages(msgs, keepMeta, shown))
    expect(out[0]).toEqual(skill) // under the ceiling → whole, never elided

    const runaway = bulky("r", "learn_generate_applet", RESULT_CEILING_CHARS + 5000)
    const [outRunaway] = tools(buildModelMessages([runaway], keepMeta, new Set()))
    expect(outRunaway.content.length).toBeLessThan(runaway.content.length)
    expect(outRunaway.content).toContain("omitted")
  })

  it("is deterministic given the same log and set state", () => {
    const ids = Array.from({ length: KEEP_RECENT_TOOL_RESULTS + 2 }, (_, i) => `b${i}`)
    const msgs: LlmMessage[] = ids.map((id) => bulky(id))
    expect(buildModelMessages(msgs, meta, new Set())).toEqual(buildModelMessages(msgs, meta, new Set()))
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
