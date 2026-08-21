import { describe, expect, it } from "vitest"
import type { AgentEvent } from "@/features/agent/engine/types"
import { ToolNameIcon } from "@/features/agent/types/stream"
import { latestAssistantText, stepsFromEvents } from "./agent-event-to-step"


describe("stepsFromEvents", () => {
  it("maps a create_note call to a completed tool step + reasoning text", () => {
    const events: AgentEvent[] = [
      { type: "tool_start", toolName: "create_note", args: { title: "A" } },
      { type: "tool_result", toolName: "create_note", result: { id: "n1" } },
      { type: "assistant_text", text: "Done." },
      { type: "done" },
    ]
    const steps = stepsFromEvents(events, "board-1")

    expect(steps).toHaveLength(2)
    const tool = steps[0]
    expect(tool.type).toBe("tool_call")
    if (tool.type === "tool_call") {
      expect(tool.name).toBe("create_note")
      expect(tool.state).toBe("completed")
      expect(tool.output).toEqual({ type: "create_note", noteId: "n1", graphUid: "board-1", label: "A", noteType: "note" })
    }
    expect(steps[1]).toMatchObject({ type: "reasoning_step", message: "Done." })
  })


  it("marks a step failed and shows the message when the result is a ToolFailure", () => {
    const events: AgentEvent[] = [
      { type: "tool_start", toolName: "web_search", args: { query: "x" } },
      {
        type: "tool_result",
        toolName: "web_search",
        result: { ok: false, error: "user_declined", tool: "web_search", message: "The user declined this request." },
      },
    ]
    const [tool] = stepsFromEvents(events, "b")
    expect(tool.type).toBe("tool_call")
    if (tool.type === "tool_call") {
      expect(tool.state).toBe("failed")
      expect(tool.output).toBe("The user declined this request.")
    }
  })


  it("maps update_note → edit_note and link_notes correctly", () => {
    const events: AgentEvent[] = [
      { type: "tool_start", toolName: "update_note", args: { id: "n1", title: "B" } },
      { type: "tool_result", toolName: "update_note", result: { id: "n1" } },
      { type: "tool_start", toolName: "link_notes", args: { sourceId: "n1", targetId: "n2" } },
      { type: "tool_result", toolName: "link_notes", result: { id: "e1" } },
    ]
    const steps = stepsFromEvents(events, "b")

    const edit = steps[0]
    const link = steps[1]
    expect(edit.type === "tool_call" && edit.name).toBe("edit_note")
    if (edit.type === "tool_call") expect(edit.output).toMatchObject({ type: "edit_note", noteId: "n1", label: "B" })
    expect(link.type === "tool_call" && link.name).toBe("link_notes")
    if (link.type === "tool_call") {
      expect(link.output).toEqual({ type: "link_notes", linkId: "e1", sourceId: "n1", targetId: "n2", graphUid: "b", label: null })
    }
  })


  it("leaves an in-flight tool step in the started state", () => {
    const steps = stepsFromEvents([{ type: "tool_start", toolName: "create_note", args: {} }], "b")
    expect(steps[0]).toMatchObject({ type: "tool_call", state: "started" })
  })


  it("maps local-engine tools to icon'd UI names (no undefined-icon crash)", () => {
    // search_notes / fetch used to fall through to raw_message, which has no
    // icon in ToolNameIcon → the ProgressLine 'Element type is invalid' crash.
    const cases: [string, string][] = [
      ["search_notes", "memory_search"],
      ["web_search", "web_search"],
      ["code_interpreter", "code_interpreter"],
      ["fetch", "fetch"],
    ]
    for (const [toolName, expected] of cases) {
      const [step] = stepsFromEvents([{ type: "tool_start", toolName, args: {} }], "b")
      expect(step.type === "tool_call" && step.name).toBe(expected)
      // …and every mapped name must resolve to a real icon (else the row crashes).
      expect(ToolNameIcon[expected as keyof typeof ToolNameIcon]).toBeDefined()
    }
  })


  it("coalesces the early name-only tool_start with the execution one (args) into a single step", () => {
    const steps = stepsFromEvents(
      [
        { type: "tool_start", toolName: "write_note", args: {} }, // early: name known, no args yet
        { type: "tool_start", toolName: "write_note", args: { content: "hi", label: "N" } }, // execution: args
        { type: "tool_result", toolName: "write_note", result: { id: "n1" } },
      ],
      "b",
    )
    const tools = steps.filter((s) => s.type === "tool_call")
    expect(tools).toHaveLength(1) // not duplicated by the two tool_starts
    const tool = tools[0]
    expect(tool.type === "tool_call" && tool.state).toBe("completed")
    expect(tool.type === "tool_call" && tool.arguments?.input).toEqual({ content: "hi", label: "N" })
  })


  it("an unmapped tool stays a tool (keeps its name), never a fake 'Reasoning' step", () => {
    // list_boards / any future tool must render as a boxed tool card, NOT fall
    // through to raw_message (whose title is "Reasoning") — that was the bug.
    for (const toolName of ["list_boards", "totally_unknown_tool"]) {
      const [step] = stepsFromEvents(
        [
          { type: "tool_start", toolName, args: {} },
          { type: "tool_result", toolName, result: { ok: true } },
        ],
        "b",
      )
      expect(step.type).toBe("tool_call")
      expect(step.type === "tool_call" && step.name).toBe(toolName)
      expect(step.type === "tool_call" && step.name).not.toBe("raw_message")
    }
    // raw_message still has an icon as a safety net (online engine can emit it).
    expect(ToolNameIcon.raw_message).toBeDefined()
  })


  it("maps a web_search result to a structured web_search output (sources surface)", () => {
    const steps = stepsFromEvents(
      [
        { type: "tool_start", toolName: "web_search", args: { query: "napoleon" } },
        {
          type: "tool_result",
          toolName: "web_search",
          result: {
            results: [
              { url: "https://a.com", title: "A", content: "ca" },
              { url: "https://b.com", title: "B" },
              { title: "no url — dropped" },
            ],
          },
        },
      ],
      "b",
    )
    const step = steps[0]
    expect(step.type === "tool_call" && step.name).toBe("web_search")
    if (step.type === "tool_call" && typeof step.output !== "string") {
      expect(step.output).toEqual({
        type: "web_search",
        answer: "",
        searchResults: [
          { type: "url", url: "https://a.com", title: "A", content: "ca" },
          { type: "url", url: "https://b.com", title: "B" },
        ],
      })
    } else {
      throw new Error("expected a structured web_search output, got a string")
    }
  })


  it("maps a fetch result to a single-source web_search output (fetch)", () => {
    const [step] = stepsFromEvents(
      [
        { type: "tool_start", toolName: "fetch", args: { url: "https://a.com" } },
        { type: "tool_result", toolName: "fetch", result: { url: "https://a.com", title: "A", text: "body" } },
      ],
      "b",
    )
    expect(step.type === "tool_call" && step.name).toBe("fetch")
    if (step.type === "tool_call" && typeof step.output !== "string") {
      expect(step.output).toEqual({
        type: "web_search",
        answer: "",
        searchResults: [{ type: "url", url: "https://a.com", title: "A" }],
      })
    } else {
      throw new Error("expected a structured web_search output, got a string")
    }
  })


  it("maps a doc_search result to a structured doc_search output (docId-keyed refs)", () => {
    const [step] = stepsFromEvents(
      [
        { type: "tool_start", toolName: "doc_search", args: { query: "revenue" } },
        {
          type: "tool_result",
          toolName: "doc_search",
          result: {
            results: [
              { chunkId: "A#0", docId: "A", docTitle: "Report.pdf", text: "revenue grew" },
              { chunkId: "x", docId: "", docTitle: "No.pdf", text: "dropped (no docId)" },
            ],
          },
        },
      ],
      "b",
    )
    expect(step.type === "tool_call" && step.name).toBe("doc_search")
    if (step.type === "tool_call" && typeof step.output !== "string") {
      expect(step.output).toEqual({
        type: "doc_search",
        references: [{ chunkId: "A#0", docId: "A", docTitle: "Report.pdf", text: "revenue grew" }],
      })
    } else {
      throw new Error("expected a structured doc_search output")
    }
  })


  it("coalesces a run of cumulative streaming deltas into ONE reasoning step", () => {
    const events: AgentEvent[] = [
      { type: "assistant_text", text: "Nap" },
      { type: "assistant_text", text: "Napoleon" },
      { type: "assistant_text", text: "Napoleon was" },
      { type: "assistant_text", text: "Napoleon was both" },
    ]
    const steps = stepsFromEvents(events, "b")
    expect(steps).toHaveLength(1) // not one line per token
    expect(steps[0]).toMatchObject({ type: "reasoning_step", message: "Napoleon was both" })
  })


  it("keeps assistant_text runs separated by a tool call", () => {
    const events: AgentEvent[] = [
      { type: "assistant_text", text: "thinking" },
      { type: "assistant_text", text: "thinking hard" },
      { type: "tool_start", toolName: "write_note", args: { label: "N" } },
      { type: "tool_result", toolName: "write_note", result: { id: "n1" } },
      { type: "assistant_text", text: "done" },
      { type: "assistant_text", text: "done now" },
    ]
    const reasoning = stepsFromEvents(events, "b").filter((s) => s.type === "reasoning_step")
    expect(reasoning.map((s) => (s.type === "reasoning_step" ? s.message : ""))).toEqual(["thinking hard", "done now"])
  })


  it("latestAssistantText returns the last assistant message", () => {
    expect(
      latestAssistantText([
        { type: "assistant_text", text: "first" },
        { type: "tool_start", toolName: "create_note", args: {} },
        { type: "assistant_text", text: "second" },
      ]),
    ).toBe("second")
  })


  it("reasoning fills the same step whose message holds the answer", () => {
    const events: AgentEvent[] = [
      { type: "reasoning", text: "First I consider X." },
      { type: "assistant_text", text: "The answer is X." },
    ]
    expect(stepsFromEvents(events, "b")).toEqual([
      { type: "reasoning_step", id: expect.any(String), reasoning: "First I consider X.", message: "The answer is X." },
    ])
  })


  it("splits reasoning around a tool call into pre-tool and post-tool steps", () => {
    const events: AgentEvent[] = [
      { type: "reasoning", text: "I should search." },
      { type: "tool_start", toolName: "search_notes", args: { query: "x" } },
      { type: "tool_result", toolName: "search_notes", result: { results: [] } },
      { type: "reasoning", text: "Nothing found, I'll answer." },
      { type: "assistant_text", text: "No matches." },
    ]
    const steps = stepsFromEvents(events, "b")
    expect(steps.map((s) => s.type)).toEqual(["reasoning_step", "tool_call", "reasoning_step"])
    expect(steps[0]).toMatchObject({ reasoning: "I should search.", message: "" })
    expect(steps[2]).toMatchObject({ reasoning: "Nothing found, I'll answer.", message: "No matches." })
  })


  it("renders a save_memory call as a readable memory step (not raw JSON)", () => {
    const steps = stepsFromEvents(
      [
        { type: "tool_start", toolName: "save_memory", args: { scope: "board", title: "Prefers dark mode" } },
        { type: "tool_result", toolName: "save_memory", result: { ok: true, id: "m1", title: "Prefers dark mode" } },
      ],
      "b",
    )
    const step = steps[0]
    expect(step.type === "tool_call" && step.output).toBe("Saved to memory: Prefers dark mode")
  })


  it("surfaces the over-cap message on a rejected save_memory", () => {
    const steps = stepsFromEvents(
      [
        { type: "tool_start", toolName: "save_memory", args: { title: "x" } },
        { type: "tool_result", toolName: "save_memory", result: { ok: false, reason: "over_cap", message: "Memory is full for this scope. Delete or merge an entry below, then retry." } },
      ],
      "b",
    )
    const step = steps[0]
    expect(step.type === "tool_call" && step.output).toMatch(/Memory is full/)
  })


  it("maps search_notes hits to a note_search output with node ids + parentId (not a JSON string)", () => {
    const steps = stepsFromEvents(
      [
        { type: "tool_start", toolName: "search_notes", args: { query: "cats" } },
        {
          type: "tool_result",
          toolName: "search_notes",
          result: { results: [{ id: "n1", title: "Cats", content: "meow", parentId: "folder-1", graphUid: "board-1" }] },
        },
      ],
      "board-1",
    )
    const step = steps[0]
    expect(step.type === "tool_call" && typeof step.output !== "string" && step.output).toEqual({
      type: "note_search",
      references: [{ noteId: "n1", graphUid: "board-1", label: "Cats", snippet: "meow", parentId: "folder-1" }],
    })
  })


  it("maps a get_note result to a single note_search reference", () => {
    const [step] = stepsFromEvents(
      [
        { type: "tool_start", toolName: "get_note", args: { note_id: "n9" } },
        { type: "tool_result", toolName: "get_note", result: { id: "n9", label: "Root note", content: "body", parentId: null, graphUid: "board-1" } },
      ],
      "board-1",
    )
    expect(step.type === "tool_call" && typeof step.output !== "string" && step.output).toEqual({
      type: "note_search",
      references: [{ noteId: "n9", graphUid: "board-1", label: "Root note", snippet: "body", parentId: null }],
    })
  })


  it("latestAssistantText ignores reasoning (answer body only)", () => {
    expect(
      latestAssistantText([
        { type: "reasoning", text: "thinking…" },
        { type: "assistant_text", text: "the answer" },
      ]),
    ).toBe("the answer")
  })
})
