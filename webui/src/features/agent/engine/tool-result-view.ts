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


/** Ceiling on a single NON-SKILL result kept whole (a recent bulky fetch/search/read
 *  result). ~20k chars ≈ 5k tokens — 2.5× the old universal cap, generous enough
 *  that a fresh result is almost always complete, but small enough that the recent
 *  window (K × this) and a single-turn fan-out stay comfortably within context.
 *  A larger result is head-cropped with a neutral marker. Together with `maxTurns`
 *  (caps run length) and recency eliding (caps *full* bulky content to K), this is
 *  what bounds aggregate input in practice; see docs/plans/tool-result-lifecycle.md. */
export const RESULT_CEILING_CHARS = 20_000


/** Ceiling for a `keepFull` (skill) result — much higher, since a skill's whole
 *  point is the full guidance (~18–21k today). Only a runaway is cropped. */
export const SKILL_CEILING_CHARS = 200_000


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


/** Keep a message whole, but head-crop it if it exceeds `ceiling` (the skill tier
 *  for `keepFull` results, else the non-skill tier). The marker is deliberately
 *  neutral: it does NOT say "re-call for the rest", because a deterministic tool
 *  re-called reproduces the same result cropped to the same head — a futile loop.
 *  The tail is simply unavailable. */
function capped(m: ToolMessage, ceiling: number): ToolMessage {
  if (m.content.length <= ceiling) return m
  const head = m.content.slice(0, ceiling)
  return {
    role: "tool",
    toolCallId: m.toolCallId,
    toolName: m.toolName,
    content: `${head}\n…[${m.content.length - ceiling} more chars omitted — result too large to include in full]`,
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
 * `shownBulky` is the run-scoped "included in a view once" set: a bulky result is
 * kept until it has appeared in one built view, then becomes elidable. So every
 * result is included in a sent view at least once — even when a single turn produces
 * more than K bulky results (parallel tool calls) — while context stays bounded (a
 * result lingers past the window for at most one extra turn). It is the inverse of a
 * "freeze what was seen" set (which would keep results forever and defeat eliding);
 * pass the same set across a run's turns. (A result is marked at build time, so a
 * turn whose model call then throws still counts it seen — harmless: the throw ends
 * the run and the set is per-run.)
 *
 * The returned array reuses the log's message objects for anything kept whole
 * (only elided/capped messages are new) — treat the view as READ-ONLY; callers must
 * not mutate it in place or they'd corrupt the authoritative log. Non-tool messages
 * pass through untouched.
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
    const ceiling = meta.keepFull ? SKILL_CEILING_CHARS : RESULT_CEILING_CHARS
    if (!bulky) return capped(m, ceiling) // small (never hits it) or keepFull skill
    // Bulky: keep while recent OR not-yet-shown (so it's seen ≥ once), then elide.
    if (recentBulky.has(m.toolCallId) || !shownBulky.has(m.toolCallId)) {
      shownBulky.add(m.toolCallId)
      return capped(m, ceiling)
    }
    return { role: "tool", toolCallId: m.toolCallId, toolName: m.toolName, content: clearedResultText(meta.toolName) }
  })
}
