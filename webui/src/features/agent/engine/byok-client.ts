/**
 * BYOK LLM client (A4) — a thin OpenAI-compatible adapter implementing
 * `LlmClient`. One client covers both BYOK providers via a swappable baseURL:
 * OpenAI direct, or OpenRouter (which reaches Claude/Gemini/etc.). The key is
 * the user's; it goes straight to the provider, never to our servers.
 *
 * Non-streaming per turn (matches the `LlmClient` contract). The mapping helpers
 * are exported + unit-tested; the network path is exercised via an injected
 * `ChatCompleter` so tests never hit a real API.
 */
import OpenAI from "openai"
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions"
import type { LlmClient, LlmMessage, LlmStreamEvent, LlmToolCall, LlmToolDef, LlmTurn } from "./types"
import { assembleStreamedTurn } from "./stream-assemble"
import { agentLog } from "./debug"


export type ByokProvider = "openai" | "openrouter"


export type ByokConfig = {
  provider: ByokProvider
  apiKey: string
  model: string
  /** Override the default base URL (e.g. an OpenAI-compatible proxy). */
  baseURL?: string
  /** Custom fetch (e.g. the Tauri CORS-free fetch on desktop). Default: global fetch. */
  fetch?: typeof fetch
}


/** The SDK methods we depend on — injectable so tests avoid the network.
 *  `createStream` is optional: a completer without it just has no streaming. */
export type ChatCompleter = {
  create(params: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion>
  createStream?(
    params: ChatCompletionCreateParamsStreaming,
  ): Promise<AsyncIterable<ChatCompletionChunk>>
}


const BASE_URLS: Record<ByokProvider, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
}


/** Our messages → OpenAI chat message params. */
export const toOpenAiMessages = (messages: LlmMessage[]): ChatCompletionMessageParam[] =>
  messages.map((m): ChatCompletionMessageParam => {
    if (m.role === "system") return { role: "system", content: m.content }
    if (m.role === "user") {
      // With images, expand to OpenAI content-parts (text first, then each image);
      // otherwise keep the plain string. `images` is only ever set on the live
      // turn (never in history), so this branch is a no-op for replayed turns.
      if (!m.images?.length) return { role: "user", content: m.content }
      const parts: ChatCompletionContentPart[] = []
      if (m.content) parts.push({ type: "text", text: m.content })
      for (const img of m.images) parts.push({ type: "image_url", image_url: { url: img.url } })
      return { role: "user", content: parts }
    }
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content }
    return {
      role: "assistant",
      content: m.content,
      ...(m.toolCalls && m.toolCalls.length > 0
        ? {
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          }
        : {}),
    }
  })


/** Our tool defs → OpenAI function tools. */
export const toOpenAiTools = (tools: LlmToolDef[]): ChatCompletionTool[] =>
  tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))


/** An OpenAI assistant message → our turn (tool calls take precedence over text). */
export const fromOpenAiMessage = (message?: ChatCompletionMessage): LlmTurn => {
  const calls: LlmToolCall[] = []
  for (const tc of message?.tool_calls ?? []) {
    if (tc.type === "function") {
      calls.push({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments })
    }
  }
  if (calls.length > 0) return { kind: "tool_calls", calls }
  return { kind: "text", text: message?.content ?? "" }
}


/** Build the injectable completer from BYOK config (creates the OpenAI client). */
export const makeCompleter = (config: ByokConfig): ChatCompleter => {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? BASE_URLS[config.provider],
    dangerouslyAllowBrowser: true,
    ...(config.fetch ? { fetch: config.fetch } : {}),
  })
  return {
    create: (params) => client.chat.completions.create(params),
    createStream: (params) => client.chat.completions.create(params),
  }
}


export class ByokLlmClient implements LlmClient {
  private readonly completer: ChatCompleter
  private readonly model: string


  constructor(completer: ChatCompleter, model: string) {
    this.completer = completer
    this.model = model
  }


  static fromConfig(config: ByokConfig): ByokLlmClient {
    return new ByokLlmClient(makeCompleter(config), config.model)
  }


  async complete(messages: LlmMessage[], tools: LlmToolDef[]): Promise<LlmTurn> {
    const params: ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: toOpenAiMessages(messages),
      ...(tools.length > 0 ? { tools: toOpenAiTools(tools), tool_choice: "auto" } : {}),
    }
    agentLog.llmRequest(this.model, messages, tools)
    try {
      const res = await this.completer.create(params)
      const turn = fromOpenAiMessage(res.choices[0]?.message)
      agentLog.llmResponse(turn)
      return turn
    } catch (err) {
      // Surface the real provider error (bad key, unknown model, rate limit)
      // instead of letting it masquerade as an empty answer upstream.
      agentLog.error(`llm.complete(${this.model})`, err)
      throw err
    }
  }


  /**
   * Streaming turn. Uses the completer's streaming path when available (real
   * provider), else degrades to a single `final` event from `complete` — so the
   * loop can always prefer `completeStream` regardless of the injected completer.
   */
  async *completeStream(
    messages: LlmMessage[],
    tools: LlmToolDef[],
  ): AsyncGenerator<LlmStreamEvent> {
    const shared = {
      model: this.model,
      messages: toOpenAiMessages(messages),
      ...(tools.length > 0 ? { tools: toOpenAiTools(tools), tool_choice: "auto" as const } : {}),
    }
    if (!this.completer.createStream) {
      yield { kind: "final", turn: await this.complete(messages, tools) }
      return
    }
    agentLog.llmRequest(this.model, messages, tools)
    try {
      const stream = await this.completer.createStream({ ...shared, stream: true })
      yield* assembleStreamedTurn(stream)
    } catch (err) {
      agentLog.error(`llm.completeStream(${this.model})`, err)
      throw err
    }
  }
}
