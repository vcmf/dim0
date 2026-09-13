// Deriving the model-facing message view from the full-fidelity log.
//
// The agent loop keeps every tool result at FULL size in `messages` (the
// authoritative log). This module derives, per turn, the shrunk view actually
// sent to the model: recent + small + authored results stay whole; only OLD,
// BULKY results are elided. This is the recency-aware replacement for the old
// eager "truncate every result to 8000 chars at insertion", which shrank even the
// just-produced result the model still needs. See docs/plans/tool-result-lifecycle.md
// (and its study of Claude Code's microcompaction, which this mirrors: keep-last-K,
// replace-whole with a sentinel, freeze-what-was-seen for prompt-cache stability).

import type { LlmMessage } from "./types"


/** Keep this many of the most recent BULKY tool results in full; older bulky ones
 *  are elided. Claude Code keeps 5. The just-produced result is always inside this
 *  window, so the model never loses output it is still acting on. */
export const KEEP_RECENT_TOOL_RESULTS = 5


/** A result whose full content exceeds this (chars) is "bulky" — eligible for
 *  eliding once it ages past the recent window. Smaller results are always kept:
 *  they cost little and are often structural (a note id, a short status). */
export const BULKY_RESULT_CHARS = 8000


/** Hard ceiling even for `keepFull` (skill) results, so a pathologically large one
 *  can't blow the provider's max-input limit. Generous — well above any skill
 *  (~21k) — and only ever bites a runaway. ~50k tokens at ~4 chars/token. */
export const KEEP_FULL_CEILING_CHARS = 200_000


type ToolMessage = Extract<LlmMessage, { role: "tool" }>


/** Metadata the view needs about a tool message, resolved from the tool that ran. */
export interface ToolMsgMeta {
  toolName: string
  /** Never elide this result (bounded, authored — chiefly skills). */
  keepFull: boolean
}


/** What an elided old result is replaced with — a clear statement that the payload
 *  is gone (not a head-slice that looks complete but isn't), keeping the
 *  tool_use↔tool_result pairing intact. */
export const clearedResultText = (toolName: string): string =>
  `[old ${toolName} result cleared to save context — re-call the tool if you need it again]`


/** Substitute for a tool that returned nothing: a bare-empty result makes some
 *  models end their turn, so the loop stores this instead. */
export const emptyResultText = (toolName: string): string => `(${toolName} completed with no output)`


/**
 * Derive the model-facing messages from the full log, eliding old bulky tool
 * results by pure recency. Kept whole: all small results, all `keepFull` (skill)
 * results, and the most recent {@link KEEP_RECENT_TOOL_RESULTS} bulky results.
 * Older bulky results are replaced WHOLE with {@link clearedResultText}, keeping the
 * `tool_use ↔ tool_result` pairing. Non-tool messages pass through untouched.
 *
 * Pure and deterministic: the same log yields the same view. There is deliberately
 * NO "freeze what was already sent" — that would keep every result frozen the first
 * (and only) turn it appears as the most-recent bulky one, so nothing produced in a
 * run would ever elide and context would grow unbounded. We accept that an aging
 * result is rewritten once (full → sentinel) as it crosses the window, trading some
 * prompt-cache reuse for a hard bound on context. `keepFull` results (skills) stay
 * whole because the model may need the guidance across a whole multi-call task.
 */
export function buildModelMessages(messages: LlmMessage[], metaOf: (m: ToolMessage) => ToolMsgMeta): LlmMessage[] {
  // The bulky, elidable results in order — the last K of these are "recent".
  const bulkyIds: string[] = []
  for (const m of messages) {
    if (m.role !== "tool") continue
    if (metaOf(m).keepFull) continue
    if (m.content.length > BULKY_RESULT_CHARS) bulkyIds.push(m.toolCallId)
  }
  const recentBulky = new Set(bulkyIds.slice(-KEEP_RECENT_TOOL_RESULTS))

  return messages.map((m) => {
    if (m.role !== "tool") return m
    const meta = metaOf(m)
    // `keepFull` (skills) is never elided, but is still bounded by a hard ceiling so
    // a runaway can't exceed the provider's input limit.
    if (meta.keepFull) {
      if (m.content.length <= KEEP_FULL_CEILING_CHARS) return m
      const head = m.content.slice(0, KEEP_FULL_CEILING_CHARS)
      return {
        role: "tool",
        toolCallId: m.toolCallId,
        toolName: m.toolName,
        content: `${head}\n…[truncated ${m.content.length - KEEP_FULL_CEILING_CHARS} chars]`,
      }
    }
    // Keep whole if small or among the most recent bulky results; else elide.
    const elidable = m.content.length > BULKY_RESULT_CHARS
    if (!elidable || recentBulky.has(m.toolCallId)) return m
    return { role: "tool", toolCallId: m.toolCallId, toolName: m.toolName, content: clearedResultText(meta.toolName) }
  })
}
