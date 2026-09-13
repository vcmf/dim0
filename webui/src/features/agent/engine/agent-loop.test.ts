import { beforeEach, describe, expect, it } from "vitest"
import { asNodeId } from "@canvas-harness/core"
import type { Edge } from "@canvas-harness/core"
import type { DimNodeData } from "@/features/board/model"
import { labelText } from "@/features/board/model"
import { BoardRegistry, newLocalBoard } from "@/features/board/persist/local/board-registry"
import { LocalSearchIndex } from "@/features/board/search/local-index"
import { addNode, freshStore, resetIdb } from "@/test/canvas"
import { ScriptedLlm, toolTurn } from "@/test/llm"
import { z } from "zod"
import { executeToolCall, newConfirmGate, runAgent } from "./agent-loop"
import { isToolFailure } from "./tool-result"
import { resolveConfirmDecision } from "./tool-confirm-store"
import { defineTool } from "./types"
import type { AgentEvent, LlmClient, LlmMessage, Tool, ToolContext } from "./types"
import { createNote, editNote, getNote, linkNotes, listBoards, localTools, searchNotes, updateNote, writeNote } from "./tools"
import { learnGenerateMiniApp, skillTools } from "./skills"


const drain = async (gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> => {
  const out: AgentEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}


const endNode = (end: Edge["source"]): string => ("nodeId" in end ? String(end.nodeId) : "free")


const titleOf = (data: unknown): string => labelText((data as DimNodeData | undefined)?.label)


beforeEach(() => {
  resetIdb()
})


describe("runAgent (scripted LLM)", () => {
  it("creates 3 notes and links them into a chain", async () => {
    const store = freshStore("c")
    const llm = new ScriptedLlm([
      toolTurn("create_note", { id: "n1", title: "A" }),
      toolTurn("create_note", { id: "n2", title: "B" }),
      toolTurn("create_note", { id: "n3", title: "C" }),
      toolTurn("link_notes", { sourceId: "n1", targetId: "n2" }),
      toolTurn("link_notes", { sourceId: "n2", targetId: "n3" }),
      { kind: "text", text: "Created 3 linked notes." },
    ])

    const events = await drain(runAgent({ userMessage: "build it", tools: localTools, llm, ctx: { store } }))

    expect(store.getAllNodes().map((n) => titleOf(n.data)).sort()).toEqual(["A", "B", "C"])
    const pairs = store.getAllEdges().map((e) => `${endNode(e.source)}->${endNode(e.target)}`).sort()
    expect(pairs).toEqual(["n1->n2", "n2->n3"])
    expect(events.at(-1)).toEqual({ type: "done" })
    expect(events.some((e) => e.type === "assistant_text")).toBe(true)
  })


  it("reports a throwing tool as a tool error and keeps the run going", async () => {
    const store = freshStore("c")
    const exploding = defineTool({
      name: "explode",
      description: "always throws",
      parameters: z.object({}),
      run: async () => {
        throw new Error("boom")
      },
    })
    const llm = new ScriptedLlm([
      toolTurn("explode", {}),
      { kind: "text", text: "recovered without the tool" },
    ])

    const events = await drain(runAgent({ userMessage: "go", tools: [exploding], llm, ctx: { store } }))

    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      type: "tool_result",
      toolName: "explode",
      result: { ok: false, error: "tool_error", tool: "explode", message: expect.stringContaining("boom") },
    })
    expect(events.some((e) => e.type === "assistant_text" && e.text === "recovered without the tool")).toBe(true)
    expect(events.at(-1)).toEqual({ type: "done" })
  })


  it("INV-8: an agent action is one undoable batch", async () => {
    const store = freshStore("c")
    const llm = new ScriptedLlm([toolTurn("create_note", { id: "n1", title: "A" }), { kind: "text", text: "ok" }])

    await drain(runAgent({ userMessage: "x", tools: localTools, llm, ctx: { store } }))
    expect(store.getAllNodes()).toHaveLength(1)
    expect(store.canUndo()).toBe(true)

    store.undo()
    expect(store.getAllNodes()).toHaveLength(0)
  })


  it("prepends prior history before the new user message", async () => {
    const store = freshStore("c")
    let seen: LlmMessage[] = []
    const llm: LlmClient = {
      async complete(messages) {
        seen = [...messages]
        return { kind: "text", text: "ok" }
      },
    }
    const history: LlmMessage[] = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ]

    await drain(runAgent({ userMessage: "follow up", history, tools: localTools, llm, ctx: { store } }))

    expect(seen.map((m) => m.role)).toEqual(["user", "assistant", "user"])
    expect(seen.map((m) => ("content" in m ? m.content : ""))).toEqual([
      "first question",
      "first answer",
      "follow up",
    ])
  })


  it("reports unknown tools without crashing the loop", async () => {
    const store = freshStore("c")
    const llm = new ScriptedLlm([toolTurn("nope", {}), { kind: "text", text: "done" }])
    const events = await drain(runAgent({ userMessage: "x", tools: localTools, llm, ctx: { store } }))
    const result = events.find((e) => e.type === "tool_result")
    expect(result).toMatchObject({ result: { ok: false, error: "unknown_tool", tool: "nope" } })
  })
})


describe("runAgent — off-board tool confirmation gate", () => {
  const spyTool = (name: string, ran: { value: boolean }) =>
    defineTool({
      name,
      description: name,
      parameters: z.object({ url: z.string().optional(), code: z.string().optional() }),
      run: async () => {
        ran.value = true
        return { ok: true }
      },
    })

  const resultOf = (events: AgentEvent[]) => events.find((e) => e.type === "tool_result")

  it("runs a gated tool when the user allows", async () => {
    const ran = { value: false }
    const seen: { name: string; args: Record<string, unknown> }[] = []
    const llm = new ScriptedLlm([toolTurn("fetch", { url: "https://x" }), { kind: "text", text: "done" }])
    const events = await drain(
      runAgent({
        userMessage: "go",
        tools: [spyTool("fetch", ran)],
        llm,
        ctx: { store: freshStore("c"), confirmTool: async (r) => (seen.push(r), "once") },
      }),
    )
    expect(seen).toEqual([{ name: "fetch", args: { url: "https://x" } }])
    expect(ran.value).toBe(true)
    expect(resultOf(events)).toMatchObject({ result: { ok: true } })
  })

  it("declines a gated tool and feeds an error back to the model (tool not run)", async () => {
    const ran = { value: false }
    const llm = new ScriptedLlm([toolTurn("fetch", { url: "https://evil/x" }), { kind: "text", text: "ok without it" }])
    const events = await drain(
      runAgent({
        userMessage: "go",
        tools: [spyTool("fetch", ran)],
        llm,
        ctx: { store: freshStore("c"), confirmTool: async () => "deny" },
      }),
    )
    expect(ran.value).toBe(false)
    expect(resultOf(events)).toMatchObject({
      toolName: "fetch",
      result: { ok: false, error: "user_declined", tool: "fetch", message: expect.stringContaining("declined") },
    })
    expect(events.some((e) => e.type === "assistant_text" && e.text === "ok without it")).toBe(true)
  })

  it("gates code_interpreter too", async () => {
    const ran = { value: false }
    const llm = new ScriptedLlm([toolTurn("code_interpreter", { code: "fetch('x')" }), { kind: "text", text: "d" }])
    await drain(
      runAgent({
        userMessage: "go",
        tools: [spyTool("code_interpreter", ran)],
        llm,
        ctx: { store: freshStore("c"), confirmTool: async () => "deny" },
      }),
    )
    expect(ran.value).toBe(false)
  })

  it("gates web_search too", async () => {
    const ran = { value: false }
    const llm = new ScriptedLlm([toolTurn("web_search", { query: "secrets on the board" }), { kind: "text", text: "d" }])
    await drain(
      runAgent({
        userMessage: "go",
        tools: [spyTool("web_search", ran)],
        llm,
        ctx: { store: freshStore("c"), confirmTool: async () => "deny" },
      }),
    )
    expect(ran.value).toBe(false)
  })

  it("runs a gated tool unprompted when no confirmTool is wired (headless/tests)", async () => {
    const ran = { value: false }
    const llm = new ScriptedLlm([toolTurn("fetch", { url: "https://x" }), { kind: "text", text: "d" }])
    await drain(runAgent({ userMessage: "go", tools: [spyTool("fetch", ran)], llm, ctx: { store: freshStore("c") } }))
    expect(ran.value).toBe(true)
  })

  it("a throwing confirmer becomes a tool error, not a run abort", async () => {
    const ran = { value: false }
    const llm = new ScriptedLlm([toolTurn("fetch", { url: "https://x" }), { kind: "text", text: "recovered" }])
    const events = await drain(
      runAgent({
        userMessage: "go",
        tools: [spyTool("fetch", ran)],
        llm,
        ctx: {
          store: freshStore("c"),
          confirmTool: async () => {
            throw new Error("boom")
          },
        },
      }),
    )
    expect(ran.value).toBe(false)
    expect(resultOf(events)).toMatchObject({
      toolName: "fetch",
      result: { ok: false, error: "tool_error", tool: "fetch", message: expect.stringContaining("boom") },
    })
    expect(events.some((e) => e.type === "assistant_text" && e.text === "recovered")).toBe(true)
  })

  it("does NOT prompt for non-gated tools (note tools auto-run)", async () => {
    const ran = { value: false }
    let prompted = false
    const llm = new ScriptedLlm([toolTurn("noop", {}), { kind: "text", text: "d" }])
    await drain(
      runAgent({
        userMessage: "go",
        tools: [spyTool("noop", ran)],
        llm,
        ctx: { store: freshStore("c"), confirmTool: async () => ((prompted = true), "once") },
      }),
    )
    expect(prompted).toBe(false)
    expect(ran.value).toBe(true)
  })
})


describe("tools", () => {
  it("create_note then update_note changes title and body", async () => {
    const store = freshStore("c")
    await createNote.run({ id: "n1", title: "old", body: "b1" }, { store })
    await updateNote.run({ id: "n1", title: "new", body: "b2" }, { store })

    const node = store.getNode(asNodeId("n1"))
    expect(titleOf(node?.data)).toBe("new")
    expect(node?.content).toBe("b2")
  })


  it("update_note on a missing note returns an error", async () => {
    const store = freshStore("c")
    expect(await updateNote.run({ id: "ghost" }, { store })).toEqual({ error: "note not found" })
  })


  it("search_notes finds notes via the local index", async () => {
    const store = freshStore("c")
    const search = new LocalSearchIndex()
    search.attach(store)
    addNode(store, "n1", "hello world")
    await search.idle()

    const res = (await searchNotes.run({ query: "hello" }, { store, search })) as { results: { id: string }[] }
    expect(res.results.map((r) => r.id)).toContain("n1")
  })


  it("list_boards lists from the registry", async () => {
    const registry = new BoardRegistry()
    await registry.init()
    await registry.createBoard(newLocalBoard("Ideas", 1000))
    const store = freshStore("c")

    const res = (await listBoards.run({}, { store, registry })) as { boards: { title: string }[] }
    expect(res.boards.map((b) => b.title)).toEqual(["Ideas"])
    registry.close()
  })


  it("write_note creates a typed node (mini-app)", async () => {
    const store = freshStore("c")
    const { id } = (await writeNote.run(
      { note_id: "m1", label: "Chart", content: "function Widget() { return null }", note_type: "mini-app" },
      { store },
    )) as { id: string }
    const node = store.getNode(asNodeId(id))
    expect(node?.type).toBe("mini-app")
    expect(titleOf(node?.data)).toBe("Chart")
    // Custom types must be born with grow-to-fit OFF (mirrors note_to_wire).
    expect(node?.style?.autoFit).toBe(false)
  })


  it("write_note leaves a rectangle's autoFit unset (it should grow-to-fit)", async () => {
    const store = freshStore("c")
    await writeNote.run({ note_id: "r1", content: "hi", note_type: "rectangle" }, { store })
    expect(store.getNode(asNodeId("r1"))?.style?.autoFit).not.toBe(false)
  })


  it("write_note stamps a random Tailwind-200 fill (theme source-of-truth)", async () => {
    const store = freshStore("c")
    await writeNote.run({ note_id: "n1", content: "x", note_type: "rectangle" }, { store })
    const data = store.getNode(asNodeId("n1"))?.data as { _storedColors?: { backgroundColor?: string; textColor?: string } }
    expect(data._storedColors?.backgroundColor).toMatch(/^#/)
    expect(data._storedColors?.textColor).toBe("#000000")
  })


  it("link_notes attaches at node centers (so auto-clip hits the borders)", async () => {
    const store = freshStore("c")
    await writeNote.run({ note_id: "a", content: "a", note_type: "rectangle" }, { store })
    await writeNote.run({ note_id: "b", content: "b", note_type: "rectangle" }, { store })
    await linkNotes.run({ sourceId: "a", targetId: "b" }, { store })

    const a = store.getNode(asNodeId("a"))!
    const edge = store.getAllEdges()[0]
    const src = edge.source
    expect("nodeId" in src && src.localOffset).toEqual({ x: a.w / 2, y: a.h / 2 })
  })


  it("write_note rejects a malformed mini-app without creating a node", async () => {
    const store = freshStore("c")
    const res = await writeNote.run({ note_id: "bad", content: "const x = 1", note_type: "mini-app" }, { store })
    expect(res).toMatchObject({ error: expect.stringContaining("mini-app invalid") })
    expect(store.getNode(asNodeId("bad"))).toBeUndefined()
  })


  it("write_note(note_id) rewrites an existing note", async () => {
    const store = freshStore("c")
    await writeNote.run({ note_id: "n1", content: "v1", note_type: "rectangle" }, { store })
    await writeNote.run({ note_id: "n1", content: "v2", note_type: "sheet" }, { store })
    const node = store.getNode(asNodeId("n1"))
    expect(node?.content).toBe("v2")
    expect(node?.type).toBe("sheet")
    expect(store.getAllNodes()).toHaveLength(1)
  })


  it("get_note reads label, content, and type", async () => {
    const store = freshStore("c")
    await writeNote.run({ note_id: "n1", label: "T", content: "body", note_type: "sheet" }, { store })
    const res = (await getNote.run({ note_id: "n1" }, { store })) as { label: string; content: string; note_type: string }
    expect(res).toMatchObject({ label: "T", content: "body", note_type: "sheet" })
  })


  it("edit_note replaces a unique snippet and rejects ambiguous ones", async () => {
    const store = freshStore("c")
    await writeNote.run({ note_id: "n1", content: "alpha beta alpha", note_type: "rectangle" }, { store })

    expect(await editNote.run({ note_id: "n1", field: "content", old: "alpha", new: "X" }, { store })).toMatchObject({
      error: expect.stringContaining("multiple times"),
    })
    await editNote.run({ note_id: "n1", field: "content", old: "beta", new: "Y" }, { store })
    expect(store.getNode(asNodeId("n1"))?.content).toBe("alpha Y alpha")
  })
})


describe("skills", () => {
  it("learn_generate_* tools return their guidance text", async () => {
    const out = (await learnGenerateMiniApp.run({}, { store: freshStore("c") })) as string
    expect(typeof out).toBe("string")
    expect(out.length).toBeGreaterThan(200)
  })

  it("exposes the three skill loaders", () => {
    expect(skillTools.map((t) => t.name).sort()).toEqual([
      "learn_generate_diagram",
      "learn_generate_html_widget",
      "learn_generate_mini_app",
    ])
  })
})


describe("executeToolCall (tool execution choke point)", () => {
  const stubTool = (name: string, run: Tool["run"] = async () => ({ ok: true })): Tool =>
    defineTool({ name, description: name, parameters: z.object({ url: z.string().optional() }), run })

  const ctxWith = (confirmTool?: ToolContext["confirmTool"]): ToolContext =>
    ({ store: freshStore("c"), rootId: null, confirmTool })

  it("returns an unknown_tool failure when the tool isn't in the set", async () => {
    const out = await executeToolCall("nope", {}, [stubTool("fetch")], ctxWith(), newConfirmGate())
    expect(out).toMatchObject({ ok: false, error: "unknown_tool", tool: "nope" })
  })

  it("runs a non-gated tool without consulting the confirmer", async () => {
    let asked = false
    const out = await executeToolCall(
      "create_note", {}, [stubTool("create_note", async () => ({ id: "n1" }))],
      ctxWith(async () => ((asked = true), "once")), newConfirmGate(),
    )
    expect(asked).toBe(false)
    expect(out).toEqual({ id: "n1" })
  })

  it("runs a gated tool on allow-once but does NOT auto-approve the next call", async () => {
    const gate = newConfirmGate()
    const out = await executeToolCall("fetch", { url: "x" }, [stubTool("fetch")], ctxWith(async () => "once"), gate)
    expect(out).toEqual({ ok: true })
    expect(gate.approved.has("fetch")).toBe(false) // "once" is not remembered
  })

  it("returns user_declined and records the tool when refused", async () => {
    const gate = newConfirmGate()
    const out = await executeToolCall("fetch", {}, [stubTool("fetch")], ctxWith(async () => "deny"), gate)
    expect(out).toMatchObject({ ok: false, error: "user_declined", tool: "fetch" })
    // Recorded by CALL key (name + args), not the bare tool name.
    expect(gate.declined.has("fetch:{}")).toBe(true)
    expect(gate.declined.has("fetch")).toBe(false)
  })

  it("re-declines the SAME call without re-prompting, but a DIFFERENT call still prompts", async () => {
    const gate = newConfirmGate()
    let prompts = 0
    const tools = [stubTool("web_search")]
    const ctx = ctxWith(async () => (prompts += 1, "deny"))

    // Deny query "a".
    await executeToolCall("web_search", { query: "a" }, tools, ctx, gate)
    expect(prompts).toBe(1)

    // Same call again → auto-declined, no new prompt.
    const repeat = await executeToolCall("web_search", { query: "a" }, tools, ctx, gate)
    expect(prompts).toBe(1)
    expect(repeat).toMatchObject({ ok: false, error: "user_declined", tool: "web_search" })

    // A DIFFERENT query is a different call → prompts again (the bug fix).
    await executeToolCall("web_search", { query: "b" }, tools, ctx, gate)
    expect(prompts).toBe(2)
  })

  it("keys the decline by args order-independently (same args, different key order)", async () => {
    const gate = newConfirmGate()
    let prompts = 0
    const tools = [stubTool("fetch")]
    const ctx = ctxWith(async () => (prompts += 1, "deny"))
    await executeToolCall("fetch", { url: "x", note: "n" }, tools, ctx, gate)
    await executeToolCall("fetch", { note: "n", url: "x" }, tools, ctx, gate) // reordered
    expect(prompts).toBe(1) // recognized as the same call
  })

  it("'allow for this request' records approval and skips the prompt on the next call", async () => {
    const gate = newConfirmGate()
    let prompts = 0
    const tool = [stubTool("web_search")]
    const ctx = ctxWith(async () => (prompts += 1, "always"))

    const first = await executeToolCall("web_search", { query: "a" }, tool, ctx, gate)
    expect(first).toEqual({ ok: true })
    expect(gate.approved.has("web_search")).toBe(true)

    const second = await executeToolCall("web_search", { query: "b" }, tool, ctx, gate)
    expect(second).toEqual({ ok: true })
    expect(prompts).toBe(1) // approved for the run — the second call didn't prompt
  })

  it("normalizes a thrown tool into a tool_error (never propagates)", async () => {
    const out = await executeToolCall(
      "fetch", {}, [stubTool("fetch", async () => { throw new Error("kaboom") })], ctxWith(async () => "once"), newConfirmGate(),
    )
    expect(out).toMatchObject({ ok: false, error: "tool_error", tool: "fetch" })
    expect((out as { message: string }).message).toContain("kaboom")
  })

  it("normalizes a tool's own {error} rejection into a tool_rejected failure", async () => {
    const out = await executeToolCall(
      "create_note", {}, [stubTool("create_note", async () => ({ error: "note not found" }))], ctxWith(), newConfirmGate(),
    )
    expect(out).toMatchObject({ ok: false, error: "tool_rejected", tool: "create_note", message: "note not found" })
    expect(isToolFailure(out)).toBe(true) // uniform failure signal, not a bare {error}
  })

  it("passes a tool's success output through unchanged", async () => {
    const out = await executeToolCall(
      "create_note", {}, [stubTool("create_note", async () => ({ id: "n1", created: true }))], ctxWith(), newConfirmGate(),
    )
    expect(out).toEqual({ id: "n1", created: true })
    expect(isToolFailure(out)).toBe(false)
  })

  it("gates run without a confirmer wired (headless): the tool runs", async () => {
    let ran = false
    await executeToolCall("fetch", {}, [stubTool("fetch", async () => ((ran = true), { ok: true }))], ctxWith(), newConfirmGate())
    expect(ran).toBe(true)
  })

  it("'allow for this request' is per-tool — approving one gated tool doesn't approve another", async () => {
    const gate = newConfirmGate()
    const tools = [stubTool("web_search"), stubTool("fetch")]
    let fetchPrompts = 0
    const ctx = ctxWith(async (r) => (r.name === "fetch" ? (fetchPrompts += 1) : 0, "always"))

    await executeToolCall("web_search", { query: "a" }, tools, ctx, gate)
    expect(gate.approved.has("web_search")).toBe(true)

    // A different gated tool still prompts despite web_search being approved.
    await executeToolCall("fetch", { url: "u" }, tools, ctx, gate)
    expect(fetchPrompts).toBe(1)
    expect(gate.approved.has("fetch")).toBe(true)
  })

  it("a persistent grant revoked mid-run re-prompts on the next call (real wiring)", async () => {
    // Exercises the confirmTool wiring use-local-submit-prompt uses: the grant
    // (isAutoAllowed) and dialog are both read per call, so a revoke applies next.
    const gate = newConfirmGate()
    const tools = [stubTool("web_search")]
    let granted = true
    let dialogPrompts = 0
    const ctx = ctxWith(() =>
      resolveConfirmDecision("web_search", () => granted, async () => (dialogPrompts += 1, "deny")),
    )

    // Granted → runs via "once", never opens the dialog, never sticks in approved.
    const first = await executeToolCall("web_search", { query: "a" }, tools, ctx, gate)
    expect(first).toEqual({ ok: true })
    expect(dialogPrompts).toBe(0)
    expect(gate.approved.has("web_search")).toBe(false)

    // Revoke mid-run → next call defers to the dialog and is declined.
    granted = false
    const second = await executeToolCall("web_search", { query: "b" }, tools, ctx, gate)
    expect(dialogPrompts).toBe(1)
    expect(second).toMatchObject({ ok: false, error: "user_declined" })
  })
})


describe("runAgent — declined off-board tool is not re-prompted across turns", () => {
  const searchSpy = (ran: { value: number }) =>
    defineTool({
      name: "web_search",
      description: "web_search",
      parameters: z.object({ query: z.string().optional() }),
      run: async () => ((ran.value += 1), { ok: true }),
    })

  it("prompts once then auto-declines a retry of the IDENTICAL call (nag protection)", async () => {
    let prompts = 0
    const ran = { value: 0 }
    const llm = new ScriptedLlm([
      toolTurn("web_search", { query: "a" }),
      toolTurn("web_search", { query: "a" }), // same query — stubborn retry
      { kind: "text", text: "fine, answering without it" },
    ])
    const events = await drain(
      runAgent({
        userMessage: "go",
        tools: [searchSpy(ran)],
        llm,
        ctx: { store: freshStore("c"), rootId: null, confirmTool: async () => (prompts += 1, "deny") },
      }),
    )
    expect(prompts).toBe(1) // identical retry didn't re-prompt
    expect(ran.value).toBe(0)
    const declines = events.filter(
      (e) => e.type === "tool_result" && (e.result as { error?: string }).error === "user_declined",
    )
    expect(declines).toHaveLength(2)
  })

  it("prompts again for a DIFFERENT query — declining one search doesn't ban the next", async () => {
    // The reported bug: allow #1, deny #2, and #3 (a distinct query) was
    // auto-declined. Each distinct search must get its own prompt.
    const prompts: string[] = []
    const ran = { value: 0 }
    const llm = new ScriptedLlm([
      toolTurn("web_search", { query: "a" }),
      toolTurn("web_search", { query: "b" }),
      toolTurn("web_search", { query: "c" }),
      { kind: "text", text: "done" },
    ])
    await drain(
      runAgent({
        userMessage: "go",
        tools: [searchSpy(ran)],
        llm,
        ctx: {
          store: freshStore("c"),
          rootId: null,
          // allow "a", deny "b", allow "c"
          confirmTool: async (r) => {
            const q = String((r.args as { query?: string }).query)
            prompts.push(q)
            return q === "b" ? "deny" : "once"
          },
        },
      }),
    )
    expect(prompts).toEqual(["a", "b", "c"]) // every distinct query prompted
    expect(ran.value).toBe(2) // "a" and "c" ran; "b" was declined
  })

  it("prompts once on 'allow for this request', then runs later calls unprompted", async () => {
    let prompts = 0
    const ran = { value: 0 }
    const spy = defineTool({
      name: "web_search",
      description: "web_search",
      parameters: z.object({ query: z.string().optional() }),
      run: async () => ((ran.value += 1), { ok: true }),
    })
    const llm = new ScriptedLlm([
      toolTurn("web_search", { query: "a" }),
      toolTurn("web_search", { query: "b" }),
      { kind: "text", text: "done" },
    ])
    await drain(
      runAgent({
        userMessage: "go",
        tools: [spy],
        llm,
        ctx: { store: freshStore("c"), rootId: null, confirmTool: async () => (prompts += 1, "always") },
      }),
    )
    expect(prompts).toBe(1) // approved for the request — only the first call prompted
    expect(ran.value).toBe(2) // both searches ran
  })
})


describe("runAgent tool-result view (fresh results kept full)", () => {
  // A client that requests one tool call, then captures the messages it's given
  // on the follow-up round — i.e. the derived model view, where the tool result
  // rides as a `tool` message.
  const captureAfterTool = (toolName: string) => {
    let captured: LlmMessage[] | null = null
    const llm: LlmClient = {
      complete: async (messages) => {
        if (messages.some((m) => m.role === "tool")) {
          captured = messages
          return { kind: "text", text: "done" }
        }
        return { kind: "tool_calls", calls: [{ id: "c1", name: toolName, arguments: "{}" }] }
      },
    }
    return { llm, toolMessage: () => captured?.find((m) => m.role === "tool") }
  }


  it("keeps a FRESH bulky result (under the non-skill tier) in full — the model still needs it", async () => {
    const big = "y".repeat(15000) // > bulky threshold (8k) but < the 20k non-skill tier
    const bigTool: Tool = { name: "fetch", description: "d", parameters: z.object({}), run: async () => big }
    const cap = captureAfterTool("fetch")
    await drain(runAgent({ userMessage: "fetch it", tools: [bigTool], llm: cap.llm, ctx: {} as ToolContext }))
    const content = cap.toolMessage()?.content ?? ""
    expect(content).toBe(JSON.stringify(big)) // full, byte-for-byte
    expect(content).not.toContain("cleared")
    expect(content).not.toContain("omitted")
  })


  it("leaves a small tool result untouched", async () => {
    const smallTool: Tool = { name: "get_note", description: "d", parameters: z.object({}), run: async () => ({ id: "n1", ok: true }) }
    const cap = captureAfterTool("get_note")
    await drain(runAgent({ userMessage: "read", tools: [smallTool], llm: cap.llm, ctx: {} as ToolContext }))
    expect(cap.toolMessage()?.content).toBe(JSON.stringify({ id: "n1", ok: true }))
  })


  it("never elides a keepFullResult tool (e.g. a skill), even past the bulky threshold", async () => {
    const big = "y".repeat(20000)
    const skill: Tool = { name: "learn_generate_applet", description: "d", parameters: z.object({}), run: async () => big, keepFullResult: true }
    const cap = captureAfterTool("learn_generate_applet")
    await drain(runAgent({ userMessage: "learn", tools: [skill], llm: cap.llm, ctx: {} as ToolContext }))
    expect(cap.toolMessage()?.content).toBe(JSON.stringify(big))
  })


  it("substitutes a sentinel only for an absent (undefined) tool result", async () => {
    const emptyTool: Tool = { name: "noop", description: "d", parameters: z.object({}), run: async () => undefined }
    const cap = captureAfterTool("noop")
    await drain(runAgent({ userMessage: "x", tools: [emptyTool], llm: cap.llm, ctx: {} as ToolContext }))
    expect(cap.toolMessage()?.content).toBe("(noop completed with no output)")
  })

  it("passes a meaningful null result through unchanged (not the no-output sentinel)", async () => {
    const nullTool: Tool = { name: "lookup", description: "d", parameters: z.object({}), run: async () => null }
    const cap = captureAfterTool("lookup")
    await drain(runAgent({ userMessage: "x", tools: [nullTool], llm: cap.llm, ctx: {} as ToolContext }))
    expect(cap.toolMessage()?.content).toBe("null")
  })


  it("stores the tool name on the tool message (for per-tool view policy)", async () => {
    const t: Tool = { name: "fetch", description: "d", parameters: z.object({}), run: async () => "ok" }
    const cap = captureAfterTool("fetch")
    await drain(runAgent({ userMessage: "x", tools: [t], llm: cap.llm, ctx: {} as ToolContext }))
    const m = cap.toolMessage()
    expect(m && "toolName" in m ? m.toolName : undefined).toBe("fetch")
  })
})
