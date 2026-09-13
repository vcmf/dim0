/**
 * The agent loop (A4). Drives an `LlmClient` through tool-calling turns against
 * the local tools, emitting `AgentEvent`s. Provider-agnostic and network-free by
 * construction — the LLM is injected, so tests use a scripted mock.
 */
import { z } from "zod"
import { CONFIRM_TOOL_NAMES } from "./types"
import type { AgentEvent, LlmClient, LlmMessage, LlmToolDef, LlmTurn, Tool, ToolContext } from "./types"
import { isToolSoftError, toolRejected, toolThrew, unknownTool, userDeclined } from "./tool-result"
import { agentLog } from "./debug"


/**
 * Safety cap on tool-calling rounds for a single turn. High enough for complex
 * multi-step builds, bounded so a misbehaving model can't loop forever (each
 * round is a billed LLM call). Override per-run via `RunAgentOptions.maxTurns`.
 */
export const DEFAULT_MAX_TURNS = 30


/**
 * Cap on a single tool result fed back to the model within a turn. Large results
 * (`fetch` / `web_search` / `doc_search` full text) would otherwise ride in
 * context for every remaining round of the turn. The head is kept (ids, first
 * results); small results (note-tool `{id}`, failures) are untouched.
 */
export const MAX_TOOL_RESULT_CHARS = 8000


/**
 * Serialize a tool result for the model. Past the size cap the tail is dropped with
 * a neutral marker; `keepFull` (tools that declare `keepFullResult`, e.g. skills)
 * bypasses the cap entirely. Deterministic → byte-stable re-send.
 *
 * NOTE: this is an eager, at-insertion truncation with no recency awareness — it
 * shrinks even the just-produced result the model still needs. That's a known flaw;
 * the recency-aware, retain-full-derive-the-view rework is docs/plans/tool-result-
 * lifecycle.md PR 2. This PR only stops skills from being truncated and removes the
 * misleading "narrower query" nudge that drove futile re-calls.
 */
const serializeToolResult = (output: unknown, keepFull = false): string => {
  const s = JSON.stringify(output) ?? "null"
  if (keepFull || s.length <= MAX_TOOL_RESULT_CHARS) return s
  return `${s.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${s.length - MAX_TOOL_RESULT_CHARS} chars]`
}


/**
 * Tools that reach OFF the board — network egress (`fetch`, `web_search`) and
 * code execution (`code_interpreter`). When a confirmer is wired (see `ToolContext.confirmTool`)
 * these require an explicit user OK before running, so a prompt-injected tool
 * call (from a selected note / uploaded doc) can't silently exfiltrate board
 * data or run attacker code. Note tools stay auto — they act on the user's own
 * board and gating them would wreck the normal build flow.
 */
const CONFIRM_TOOLS = new Set<string>(CONFIRM_TOOL_NAMES)


/** Convert a tool's Zod schema to a plain JSON Schema (dropping the `$schema` tag). */
const toJsonSchema = (schema: z.ZodType): Record<string, unknown> => {
  const json = z.toJSONSchema(schema) as Record<string, unknown>
  delete json.$schema
  return json
}


/** Reduce tools to the name/description/parameters the LLM needs. */
const toDefs = (tools: Tool[]): LlmToolDef[] =>
  tools.map((t) => ({ name: t.name, description: t.description, parameters: toJsonSchema(t.parameters) }))


/** Parse a tool call's JSON arguments, tolerating malformed/non-object input. */
const parseArgs = (raw: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(raw)
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}


/** Order-independent JSON of a value, so equal args produce the same string. */
const stableStringify = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null"
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`
  const obj = v as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`
}


/** Identity of a specific tool call (name + args) — the decline gate's key, so a
 *  refusal is scoped to THAT call, not the whole tool. */
const callKey = (name: string, args: Record<string, unknown>): string => `${name}:${stableStringify(args)}`


/**
 * Per-run memory for the off-board confirm gate:
 *  - `declined` — SPECIFIC calls (tool + args, see `callKey`) the user refused.
 *    An identical later call fails closed WITHOUT reopening the dialog (a
 *    retrying model can't nag), but a DIFFERENT call of the same tool still
 *    prompts — declining one web search doesn't ban the next.
 *  - `approved` — TOOLS the user chose "allow for this request" for; every later
 *    call to that tool runs without prompting (a deliberate broad grant).
 */
export type ConfirmGate = { declined: Set<string>; approved: Set<string> }


/** A fresh gate for one run. */
export const newConfirmGate = (): ConfirmGate => ({ declined: new Set(), approved: new Set() })


/**
 * Execute one tool call under the loop's policy and return the model-facing
 * result: the tool's own output on success, or a structured `ToolFailure`
 * (unknown tool / user-declined / thrown error) the model can act on. The
 * single choke point for tool execution — the frontend analog of the backend's
 * tool decorator, so every failure origin yields one consistent shape.
 *
 * The off-board confirm gate is consulted only when the tool is neither already
 * declined nor already approved this run (see {@link ConfirmGate}).
 */
export async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  tools: Tool[],
  ctx: ToolContext,
  gate: ConfirmGate,
): Promise<unknown> {
  const tool = tools.find((t) => t.name === name)
  if (!tool) return unknownTool(name)

  // Confirm gate + run share one try/catch, so neither a throwing confirmer nor
  // a throwing tool aborts the whole run — both surface as a `tool_error`.
  try {
    if (CONFIRM_TOOLS.has(tool.name) && ctx.confirmTool) {
      // Decline is per specific call; approval is per tool (broad). Check the
      // exact-call decline first so an explicitly refused call stays refused
      // even if the tool was later broadly approved.
      const key = callKey(tool.name, args)
      if (gate.declined.has(key)) return userDeclined(tool.name)
      if (!gate.approved.has(tool.name)) {
        const decision = await ctx.confirmTool({ name: tool.name, args })
        if (decision === "deny") {
          gate.declined.add(key)
          return userDeclined(tool.name)
        }
        // "always" broadens consent to the rest of the run; "once" does not.
        if (decision === "always") gate.approved.add(tool.name)
      }
    }
    const result = await tool.run(args, ctx)
    // Normalize a tool's own `{ error }` rejection into the shared ToolFailure
    // shape, so every failure origin — unknown / declined / thrown / rejected —
    // answers `isToolFailure` uniformly.
    return isToolSoftError(result) ? toolRejected(tool.name, result.error) : result
  } catch (err) {
    return toolThrew(tool.name, err)
  }
}


export type RunAgentOptions = {
  userMessage: string
  tools: Tool[]
  llm: LlmClient
  ctx: ToolContext
  system?: string
  /** Prior conversation turns, prepended so the agent remembers the chat. */
  history?: LlmMessage[]
  maxTurns?: number
}


/** Run the agent, yielding events as tools execute and the answer streams. */
export async function* runAgent(opts: RunAgentOptions): AsyncGenerator<AgentEvent> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS
  const defs = toDefs(opts.tools)
  const messages: LlmMessage[] = []
  if (opts.system) messages.push({ role: "system", content: opts.system })
  if (opts.history) messages.push(...opts.history)
  messages.push({ role: "user", content: opts.userMessage })

  // Per-run confirm memory (declined + approved). Spans all turns, so a retry
  // or a follow-up call in a later round respects the earlier decision.
  const gate = newConfirmGate()

  for (let turn = 0; turn < maxTurns; turn += 1) {
    // Prefer streaming: emit cumulative `assistant_text` per delta so the UI
    // renders token-by-token; fall back to a single atomic turn otherwise.
    let result: LlmTurn
    if (opts.llm.completeStream) {
      let acc = ""
      let reasoningAcc = ""
      let final: LlmTurn | null = null
      for await (const ev of opts.llm.completeStream(messages, defs)) {
        if (ev.kind === "delta") {
          acc += ev.text
          yield { type: "assistant_text", text: acc }
        } else if (ev.kind === "reasoning") {
          // Reasoning/thinking streams on its own channel; accumulate + emit
          // cumulatively (like assistant_text). The chat UI gates the Reasoning
          // expander on turn-end, so this fills it once the turn completes.
          reasoningAcc += ev.text
          yield { type: "reasoning", text: reasoningAcc }
        } else if (ev.kind === "tool_start") {
          // Early signal: show the tool the moment its name is known; args are
          // filled in when the call actually runs below.
          yield { type: "tool_start", toolName: ev.name, args: {} }
        } else {
          final = ev.turn
        }
      }
      result = final ?? { kind: "text", text: acc }
    } else {
      result = await opts.llm.complete(messages, defs)
    }

    if (result.kind === "text") {
      messages.push({ role: "assistant", content: result.text })
      yield { type: "assistant_text", text: result.text }
      yield { type: "done" }
      return
    }

    messages.push({ role: "assistant", content: "", toolCalls: result.calls })
    for (const call of result.calls) {
      const args = parseArgs(call.arguments)
      yield { type: "tool_start", toolName: call.name, args }
      // One choke point: unknown-tool guard, the off-board confirm gate, and
      // error normalization all live in executeToolCall, so every outcome —
      // declined, unknown, or thrown — feeds back one consistent structured
      // result and no failure origin aborts the run.
      const output = await executeToolCall(call.name, args, opts.tools, opts.ctx, gate)
      agentLog.tool(call.name, args, output)
      yield { type: "tool_result", toolName: call.name, result: output }
      const keepFull = opts.tools.find((t) => t.name === call.name)?.keepFullResult ?? false
      messages.push({ role: "tool", toolCallId: call.id, content: serializeToolResult(output, keepFull) })
    }
  }

  yield { type: "done" }
}
