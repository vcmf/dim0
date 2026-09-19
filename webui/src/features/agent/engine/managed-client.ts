/**
 * Managed LLM client (G2) — the agent's LLM turn routed through OUR server.
 *
 * Instead of calling a provider directly (BYOK), a managed turn hits `/ai/llm`
 * (non-streaming) or `/ai/llm/stream` (NDJSON deltas), which forward to the
 * provider with our keys and resolve the model (multi-provider, `"auto"`, tier
 * gating). The wire is OpenAI-shaped, so message/tool mapping is reused from the
 * BYOK client — only the transport differs. Metering (per run) lands in G4.
 */
import type { ChatCompletionMessage } from "openai/resources/chat/completions"
import { fromOpenAiMessage, toOpenAiMessages, toOpenAiTools } from "./byok-client"
import { agentLog } from "./debug"
import { runIdHeaders } from "./services/run"
import { servicesPost, servicesStream } from "./services/transport"
import type { LlmClient, LlmMessage, LlmStreamEvent, LlmToolDef, LlmTurn } from "./types"


type ManagedRequest = { model: string; messages: unknown; tools?: unknown }


/** POST one turn to `/ai/llm`; returns the OpenAI-shaped choices. Injectable for tests. */
export type LlmTurnPost = (
  body: ManagedRequest,
) => Promise<{ choices: { message: ChatCompletionMessage }[] }>


/** One line of the `/ai/llm/stream` NDJSON: a text delta, a reasoning delta
 *  (thinking models), an early tool-start (name known before args finish), or
 *  the final message. */
export type ManagedStreamLine =
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_start"; name: string; id?: string }
  | { type: "final"; message: ChatCompletionMessage }


/** POST one turn to `/ai/llm/stream`; yields NDJSON lines. Injectable for tests. */
export type LlmStreamPost = (body: ManagedRequest) => AsyncIterable<ManagedStreamLine>


const makeDefaultPost = (runId?: string): LlmTurnPost => (body) =>
  servicesPost<{ choices: { message: ChatCompletionMessage }[] }>("/ai/llm", body, runIdHeaders(runId))


const makeDefaultStreamPost = (runId?: string): LlmStreamPost => (body) =>
  servicesStream<ManagedStreamLine>("/ai/llm/stream", body, runIdHeaders(runId))


export class ManagedLlmClient implements LlmClient {
  private readonly model: string
  private readonly post: LlmTurnPost
  private readonly streamPost: LlmStreamPost

  constructor(model: string, post: LlmTurnPost, streamPost: LlmStreamPost) {
    this.model = model
    this.post = post
    this.streamPost = streamPost
  }

  private body(messages: LlmMessage[], tools: LlmToolDef[]): ManagedRequest {
    return {
      model: this.model,
      messages: toOpenAiMessages(messages),
      ...(tools.length > 0 ? { tools: toOpenAiTools(tools) } : {}),
    }
  }

  async complete(messages: LlmMessage[], tools: LlmToolDef[]): Promise<LlmTurn> {
    agentLog.llmRequest(this.model, messages, tools)
    try {
      const result = await this.post(this.body(messages, tools))
      const turn = fromOpenAiMessage(result.choices[0]?.message)
      agentLog.llmResponse(turn)
      return turn
    } catch (err) {
      agentLog.error(`llm.complete(${this.model})`, err)
      throw err
    }
  }

  async *completeStream(
    messages: LlmMessage[],
    tools: LlmToolDef[],
  ): AsyncGenerator<LlmStreamEvent> {
    agentLog.llmRequest(this.model, messages, tools)
    try {
      for await (const line of this.streamPost(this.body(messages, tools))) {
        if (line.type === "delta") yield { kind: "delta", text: line.text }
        else if (line.type === "reasoning") yield { kind: "reasoning", text: line.text }
        else if (line.type === "tool_start") yield { kind: "tool_start", name: line.name, id: line.id }
        else yield { kind: "final", turn: fromOpenAiMessage(line.message) }
      }
    } catch (err) {
      agentLog.error(`llm.completeStream(${this.model})`, err)
      throw err
    }
  }
}


/**
 * Build a managed LLM client. `model` is a canonical catalog id or `"auto"`; the
 * SERVER resolves it to a concrete provider model within the plan's tiers.
 * `runId` tags the whole run for metering; `post`/`streamPost` override the
 * transport in tests.
 */
export const managedLlmClient = (
  model: string,
  opts: { runId?: string; post?: LlmTurnPost; streamPost?: LlmStreamPost } = {},
): LlmClient =>
  new ManagedLlmClient(
    model,
    opts.post ?? makeDefaultPost(opts.runId),
    opts.streamPost ?? makeDefaultStreamPost(opts.runId),
  )
