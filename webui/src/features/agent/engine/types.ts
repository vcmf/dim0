/**
 * Frontend agent engine types (A4).
 *
 * `LlmClient` is the swappable boundary: a scripted mock (tests) and a real
 * BYOK OpenAI-compatible client both implement it, so the loop + tools are
 * tested with zero network. Tools are OURS and run LOCALLY against the canvas
 * store; the loop emits `AgentEvent`s the UI maps onto its stream.
 */
import { z } from "zod"
import type { CanvasStore, Node } from "@canvas-harness/core"
import type { BoardRegistry } from "@/features/board/persist/local/board-registry"
import type { MemoryRepo } from "@/features/board/persist/local/memory-repo"
import type { LocalSearchIndex } from "@/features/board/search/local-index"


/**
 * Off-board tools gated by the confirm dialog — network egress + code execution.
 * The single source of truth: the loop's gate (`CONFIRM_TOOLS`) and the settings
 * trust store both derive from this, so a new gated tool is added in one place.
 */
export const CONFIRM_TOOL_NAMES = ["web_search", "fetch", "code_interpreter"] as const


/** A gated off-board tool name. */
export type ConfirmToolName = (typeof CONFIRM_TOOL_NAMES)[number]


/**
 * The user's answer to a confirm prompt: `deny` (don't run — the exact call is
 * remembered and won't re-prompt), `once` (run this call only), `always` (run +
 * auto-approve further calls to the same tool this run).
 */
export type ToolConfirmDecision = "deny" | "once" | "always"


export type LlmToolCall = { id: string; name: string; arguments: string }


export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; content: string }


/** One model turn: either a final answer or a set of tool calls. */
export type LlmTurn =
  | { kind: "text"; text: string }
  | { kind: "tool_calls"; calls: LlmToolCall[] }


export type LlmToolDef = {
  name: string
  description: string
  parameters: Record<string, unknown>
}


/** A streamed model turn: text deltas as they arrive, an early `tool_start` the
 *  moment a tool call's name is known (before its arguments finish streaming),
 *  then the final turn. */
export type LlmStreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_start"; name: string; id?: string }
  | { kind: "final"; turn: LlmTurn }


export interface LlmClient {
  /** One turn, resolved atomically (used by tests + as the non-streaming fallback). */
  complete(messages: LlmMessage[], tools: LlmToolDef[]): Promise<LlmTurn>
  /**
   * Optional streaming variant: yields text deltas then a `final` turn. When a
   * client implements it, the agent loop prefers it so the answer renders
   * token-by-token; otherwise the loop falls back to `complete`.
   */
  completeStream?(messages: LlmMessage[], tools: LlmToolDef[]): AsyncIterable<LlmStreamEvent>
}


/** Capabilities a tool may need. Search/registry are optional (board-scoped). */
export type ToolContext = {
  store: CanvasStore
  /**
   * Current folder layer new notes/links belong to (null = root). Tools stamp
   * it as `parentId` AT CREATION — the local analog of the backend passing
   * `root_id` to `build_note`, so a note is born in the right sub-board rather
   * than relying on a post-hoc rescope.
   */
  rootId?: string | null
  /** The board this run acts on — memory tools bind board-scoped writes to it. */
  boardId?: string
  search?: LocalSearchIndex
  /**
   * Whole-board id→node lookup (ALL layers), built per turn from persistence.
   * `search`/`get_note` resolve a hit through this so a cross-folder note (absent
   * from the layer-scoped `store`) still yields its title/body. Falls back to
   * `store` for the freshest current-layer edits.
   */
  boardNotes?: ReadonlyMap<string, Node>
  registry?: BoardRegistry
  /** Durable agent memory (board + global facts); absent in tests/headless. */
  memory?: MemoryRepo
  /**
   * Optional gate for side-effecting / off-board tools (network egress, code
   * execution). The loop calls it before running such a tool; the decision is
   * `deny` (model gets a "declined" result and adapts), `once` (run this call),
   * or `always` (run + auto-approve further calls to the same tool this run).
   * When absent (tests / headless), gated tools run unprompted — the gate is a
   * UI concern wired only by the local submit path.
   */
  confirmTool?: (req: { name: string; args: Record<string, unknown> }) => Promise<ToolConfirmDecision>
}


export type Tool = {
  name: string
  description: string
  /** Zod schema for the arguments; the agent loop converts it to JSON Schema for the LLM. */
  parameters: z.ZodType
  run: (args: unknown, ctx: ToolContext) => Promise<unknown>
}


/**
 * Define a tool from a Zod parameter schema — the single source of truth. The
 * schema types `run`'s args, validates the model's tool call at runtime, and (via
 * the agent loop) becomes the JSON Schema the LLM sees. Invalid arguments return a
 * structured error instead of throwing, so the model can correct itself next turn.
 * This mirrors how the mainstream TS agent frameworks (Vercel AI SDK, OpenAI
 * Agents SDK) define tools.
 */
export const defineTool = <S extends z.ZodType>(def: {
  name: string
  description: string
  parameters: S
  run: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>
}): Tool => ({
  name: def.name,
  description: def.description,
  parameters: def.parameters,
  run: async (args, ctx) => {
    const parsed = def.parameters.safeParse(args)
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
      return { error: `invalid arguments: ${detail}` }
    }
    return def.run(parsed.data, ctx)
  },
})


export type AgentEvent =
  | { type: "tool_start"; toolName: string; args: unknown }
  | { type: "tool_result"; toolName: string; result: unknown }
  | { type: "assistant_text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "done" }
