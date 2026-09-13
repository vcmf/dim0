// Deriving the model-facing message view from the full-fidelity log.
//
// The agent loop keeps every tool result at FULL size in `messages` (the
// authoritative log). This module derives, per turn, the shrunk view actually
// sent to the model: recent + small + authored results stay whole; only OLD,
// BULKY results are elided. This is the recency-aware replacement for the old
// eager "truncate every result to 8000 chars at insertion", which shrank even the
// just-produced result the model still needs. See docs/plans/tool-result-lifecycle.md
// (and its study of Claude Code's microcompaction, which this mirrors: keep-last-K,
// replace-whole with a sentinel).

import type { LlmMessage } from "./types"


/** Keep this many of the most recent BULKY tool results in full; older bulky ones
 *  are elided (once they've been shown at least once — see `shownBulky`). Claude
 *  Code keeps 5. */
export const KEEP_RECENT_TOOL_RESULTS = 5


/** A result whose full content exceeds this (chars) is "bulky" — eligible for
 *  eliding once it ages past the recent window. Smaller results are always kept:
 *  they cost little and are often structural (a note id, a short status). */
export const BULKY_RESULT_CHARS = 8000


/** Hard per-result ceiling for any result KEPT whole (a recent bulky result, or a
 *  `keepFull` skill), so a single pathologically large result can't exceed the
 *  provider's max-input limit. Generous — well above a normal fetch/skill — and
 *  only bites a runaway. ~50k tokens at ~4 chars/token. */
export const RESULT_CEILING_CHARS = 200_000


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


/** Keep a message whole, but head-truncate it if it exceeds the hard per-result
 *  ceiling (protects against a single runaway result — fetch page or skill). */
function capped(m: ToolMessage): ToolMessage {
  if (m.content.length <= RESULT_CEILING_CHARS) return m
  const head = m.content.slice(0, RESULT_CEILING_CHARS)
  return {
    role: "tool",
    toolCallId: m.toolCallId,
    toolName: m.toolName,
    content: `${head}\n…[truncated ${m.content.length - RESULT_CEILING_CHARS} chars — re-call the tool for the rest]`,
  }
}


/**
 * Derive the model-facing messages from the full log, eliding old bulky tool
 * results by recency. Kept whole (up to {@link RESULT_CEILING_CHARS}): all small
 * results, all `keepFull` (skill) results, the most recent
 * {@link KEEP_RECENT_TOOL_RESULTS} bulky results, and any bulky result not yet
 * shown. Older, already-shown bulky results are replaced WHOLE with
 * {@link clearedResultText}, keeping the `tool_use ↔ tool_result` pairing.
 *
 * `shownBulky` is the run-scoped "seen at least once" set: a bulky result is kept
 * until it has appeared in one sent view, then becomes elidable. This GUARANTEES
 * the model sees every result at least once — even when a single turn produces more
 * than K bulky results (parallel tool calls) — while still bounding context (a
 * result stays past the window for at most one extra turn). It is the inverse of a
 * "freeze what was seen" set (which would keep results forever and defeat eliding);
 * pass the same set across a run's turns. Mutated in place; non-tool messages pass
 * through untouched.
 */
export function buildModelMessages(
  messages: LlmMessage[],
  metaOf: (m: ToolMessage) => ToolMsgMeta,
  shownBulky: Set<string>,
): LlmMessage[] {
  // One pass: resolve meta once per tool message (a message is addressed once) and
  // record bulkiness, so `metaOf` isn't called twice per message per turn.
  const cache = new Map<string, { meta: ToolMsgMeta; bulky: boolean }>()
  const bulkyIds: string[] = []
  for (const m of messages) {
    if (m.role !== "tool") continue
    const meta = metaOf(m)
    const bulky = !meta.keepFull && m.content.length > BULKY_RESULT_CHARS
    cache.set(m.toolCallId, { meta, bulky })
    if (bulky) bulkyIds.push(m.toolCallId)
  }
  const recentBulky = new Set(bulkyIds.slice(-KEEP_RECENT_TOOL_RESULTS))

  return messages.map((m) => {
    if (m.role !== "tool") return m
    const { meta, bulky } = cache.get(m.toolCallId)!
    if (!bulky) return capped(m) // small or keepFull → kept (capped)
    // Bulky: keep while recent OR not-yet-shown (so it's seen ≥ once), then elide.
    if (recentBulky.has(m.toolCallId) || !shownBulky.has(m.toolCallId)) {
      shownBulky.add(m.toolCallId)
      return capped(m)
    }
    return { role: "tool", toolCallId: m.toolCallId, toolName: m.toolName, content: clearedResultText(meta.toolName) }
  })
}
