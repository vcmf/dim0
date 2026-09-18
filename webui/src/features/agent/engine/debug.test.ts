import { beforeEach, describe, expect, it } from "vitest"
import { agentLog, clearAgentLog, getAgentLog } from "./debug"


beforeEach(() => clearAgentLog())


describe("agent debug log", () => {
  it("records llm requests, responses, tools, and errors in order", () => {
    agentLog.llmRequest("gpt-5.4", [{ role: "user", content: "hi" }], [{ name: "write_note", description: "", parameters: {} }])
    agentLog.llmResponse({ kind: "text", text: "yo" })
    agentLog.tool("write_note", { content: "x" }, { id: "n1" })
    agentLog.error("llm.complete", new Error("boom"))

    expect(getAgentLog().map((e) => e.kind)).toEqual(["llm_request", "llm_response", "tool", "error"])
  })


  it("records reasoning steps, and skips empty ones", () => {
    agentLog.reasoning("let me think about this")
    agentLog.reasoning("") // empty → not recorded
    const entries = getAgentLog()
    expect(entries.map((e) => e.kind)).toEqual(["reasoning"])
    expect(entries[0]?.data).toBe("let me think about this")
  })


  it("serializes API-style errors with status + provider detail", () => {
    agentLog.error("llm.complete", { name: "APIError", message: "model not found", status: 404, error: { code: "model_not_found" } })
    const entry = getAgentLog().at(-1)?.data as { error: Record<string, unknown> }
    expect(entry.error).toMatchObject({ status: 404, message: "model not found" })
  })


  it("clears the buffer", () => {
    agentLog.llmResponse({ kind: "text", text: "x" })
    clearAgentLog()
    expect(getAgentLog()).toHaveLength(0)
  })
})
