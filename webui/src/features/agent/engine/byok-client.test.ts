import { describe, expect, it } from "vitest"
import { asNodeId } from "@canvas-harness/core"
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessage,
} from "openai/resources/chat/completions"
import { freshStore } from "@/test/canvas"
import { runAgent } from "./agent-loop"
import type { AgentEvent } from "./types"
import { localTools } from "./tools"
import {
  ByokLlmClient,
  fromOpenAiMessage,
  toOpenAiMessages,
  toOpenAiTools,
  type ChatCompleter,
} from "./byok-client"


const completion = (message: Partial<ChatCompletionMessage>): ChatCompletion =>
  ({
    id: "x",
    created: 0,
    model: "m",
    object: "chat.completion",
    choices: [
      { index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", content: null, refusal: null, ...message } },
    ],
  }) as ChatCompletion


const drain = async (gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> => {
  const out: AgentEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}


describe("byok mapping", () => {
  it("maps our messages to OpenAI shape", () => {
    const out = toOpenAiMessages([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "t", arguments: "{}" }] },
      { role: "tool", toolCallId: "1", content: "r" },
    ])
    expect(out[0]).toEqual({ role: "system", content: "s" })
    expect(out[2]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "1", type: "function", function: { name: "t", arguments: "{}" } }],
    })
    expect(out[3]).toEqual({ role: "tool", tool_call_id: "1", content: "r" })
  })


  it("expands a user message with images to OpenAI content-parts", () => {
    const out = toOpenAiMessages([
      { role: "user", content: "what is this?", images: [{ url: "data:image/png;base64,AAA" }] },
    ])
    expect(out[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      ],
    })
  })


  it("keeps a user message a plain string when it has no images", () => {
    const withEmpty = toOpenAiMessages([{ role: "user", content: "u", images: [] }])
    expect(withEmpty[0]).toEqual({ role: "user", content: "u" })
    const without = toOpenAiMessages([{ role: "user", content: "u" }])
    expect(without[0]).toEqual({ role: "user", content: "u" })
  })


  it("omits the text part when the message content is empty (image-only)", () => {
    const out = toOpenAiMessages([{ role: "user", content: "", images: [{ url: "data:image/png;base64,AAA" }] }])
    expect(out[0]).toEqual({
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }],
    })
  })


  it("maps tool defs to OpenAI function tools", () => {
    const out = toOpenAiTools([{ name: "create_note", description: "d", parameters: { type: "object" } }])
    expect(out[0]).toEqual({ type: "function", function: { name: "create_note", description: "d", parameters: { type: "object" } } })
  })


  it("reads a tool_calls turn", () => {
    const turn = fromOpenAiMessage({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "create_note", arguments: '{"title":"A"}' } }],
    } as ChatCompletionMessage)
    expect(turn).toEqual({ kind: "tool_calls", calls: [{ id: "c1", name: "create_note", arguments: '{"title":"A"}' }] })
  })


  it("reads a text turn", () => {
    expect(fromOpenAiMessage({ role: "assistant", content: "hi" } as ChatCompletionMessage)).toEqual({ kind: "text", text: "hi" })
  })
})


describe("ByokLlmClient", () => {
  it("sends model + tools and returns the mapped turn", async () => {
    const seen: ChatCompletionCreateParamsNonStreaming[] = []
    const completer: ChatCompleter = {
      create: async (p) => {
        seen.push(p)
        return completion({ tool_calls: [{ id: "c1", type: "function", function: { name: "create_note", arguments: "{}" } }] })
      },
    }
    const client = new ByokLlmClient(completer, "gpt-x")

    const turn = await client.complete([{ role: "user", content: "hi" }], [{ name: "create_note", description: "d", parameters: { type: "object" } }])

    expect(seen[0]?.model).toBe("gpt-x")
    expect(seen[0]?.tools).toHaveLength(1)
    expect(turn).toEqual({ kind: "tool_calls", calls: [{ id: "c1", name: "create_note", arguments: "{}" }] })
  })


  it("drives runAgent end-to-end with a faked HTTP layer", async () => {
    const store = freshStore("c")
    let turn = 0
    const completer: ChatCompleter = {
      create: async () =>
        turn++ === 0
          ? completion({ tool_calls: [{ id: "c1", type: "function", function: { name: "create_note", arguments: JSON.stringify({ id: "n1", title: "A" }) } }] })
          : completion({ content: "done" }),
    }
    const client = new ByokLlmClient(completer, "m")

    await drain(runAgent({ userMessage: "x", tools: localTools, llm: client, ctx: { store } }))
    expect(store.getNode(asNodeId("n1"))).toBeDefined()
  })
})
