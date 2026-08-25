import type { ReasoningStep, ToolCallStep, ToolName } from "@/features/agent/types/stream"
import { normalizeReasoningSteps } from "@/features/agent/types/stream"
import type { ToolOutput, UrlAnnotation } from "@/features/agent/types/tool-outputs"
import type { AgentEvent } from "@/features/agent/engine/types"
import { isToolFailure } from "@/features/agent/engine/tool-result"


const field = (o: unknown, k: string): unknown =>
  o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined


const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)


/** Per-snippet cap for the compact note-citation card — deliberately shorter
 *  than the full snippet the tool feeds the model (SEARCH_SNIPPET_CHARS). */
const NOTE_CARD_SNIPPET_CHARS = 200


/**
 * Map an engine tool name to the UI ToolName the chat renderers switch on. An
 * unmapped tool keeps its own name (rendered as a generic tool card with a
 * humanized title + fallback icon) — NOT `raw_message`, which the UI treats as
 * assistant reasoning text (title "Reasoning") and would mis-render a real tool
 * call as a boxed "Reasoning" step.
 */
const toToolName = (name: string): ToolName => {
  if (name === "create_note" || name === "write_note") return "create_note"
  if (name === "update_note" || name === "edit_note") return "edit_note"
  if (name === "get_note") return "get_note"
  if (name === "link_notes") return "link_notes"
  if (name === "web_search") return "web_search"
  if (name === "code_interpreter") return "code_interpreter"
  if (name === "search_notes") return "memory_search"
  if (name === "fetch") return "fetch"
  if (name === "doc_search") return "doc_search"
  return name as ToolName
}


// Title for the note card: write_note uses `label`, the older create_note `title`.
const noteLabel = (args: unknown): string | null =>
  asStr(field(args, "label")) ?? asStr(field(args, "title")) ?? null


// Build a `UrlAnnotation` from a raw {url, title, content} record, or null when
// it has no usable URL.
const toUrlAnnotation = (raw: unknown): UrlAnnotation | null => {
  const url = asStr(field(raw, "url"))
  if (!url) return null
  const title = asStr(field(raw, "title"))
  const content = asStr(field(raw, "content"))
  return { type: "url", url, ...(title ? { title } : {}), ...(content ? { content } : {}) }
}


/** Build the UI ToolOutput a tool-step renders, from the engine's args + result. */
const toOutput = (name: string, args: unknown, result: unknown, boardId: string): ToolOutput => {
  const id = asStr(field(result, "id")) ?? ""
  if (name === "create_note" || name === "write_note") {
    const noteType = asStr(field(args, "note_type")) ?? "note"
    return { type: "create_note", noteId: id, graphUid: boardId, label: noteLabel(args), noteType }
  }
  if (name === "update_note" || name === "edit_note") {
    return { type: "edit_note", noteId: id, graphUid: boardId, label: noteLabel(args), noteType: "note" }
  }
  if (name === "link_notes") {
    return {
      type: "link_notes",
      linkId: id,
      sourceId: asStr(field(args, "sourceId")) ?? "",
      targetId: asStr(field(args, "targetId")) ?? "",
      graphUid: boardId,
      label: asStr(field(args, "label")) ?? null,
    }
  }
  if (name === "web_search") {
    // Result: { results: [{ url, title, content }] } → structured sources the
    // per-step list + end-of-message "Sources" pill can read (they gate on a
    // web_search-typed output, not a JSON string).
    const raw = field(result, "results")
    const searchResults = (Array.isArray(raw) ? raw : []).map(toUrlAnnotation).filter((r): r is UrlAnnotation => r !== null)
    return { type: "web_search", answer: "", searchResults }
  }
  if (name === "fetch") {
    // Result: { url, title, text } for one page → a single-source web_search
    // output so a fetched link surfaces alongside search sources.
    const ann = toUrlAnnotation(result)
    return ann ? { type: "web_search", answer: "", searchResults: [ann] } : JSON.stringify(result)
  }
  if (name === "doc_search") {
    // Result: { results: [{ chunkId, docId, docTitle, text }] } → structured
    // references the answer's document Sources view reads (keyed by docId).
    const raw = field(result, "results")
    const references = (Array.isArray(raw) ? raw : [])
      .map((r) => ({
        chunkId: asStr(field(r, "chunkId")) ?? "",
        docId: asStr(field(r, "docId")) ?? "",
        docTitle: asStr(field(r, "docTitle")) ?? "",
        text: asStr(field(r, "text")) ?? "",
      }))
      .filter((r) => r.docId !== "")
    return { type: "doc_search", references }
  }
  if (name === "search_notes") {
    // Retrieval hits → structured references the message-level Notes card renders
    // + jumps to (keyed by noteId, with parentId for its layer). Result shape:
    // { results: [{ id, title, content, parentId }] }. get_note is deliberately
    // NOT cited here: a targeted read-by-id is usually read-before-edit, not a
    // source that grounded the answer — a note it read after finding via search
    // is already cited by that search step.
    const rows = Array.isArray(field(result, "results")) ? (field(result, "results") as unknown[]) : []
    const references = rows
      .map((r) => {
        const parent = field(r, "parentId")
        return {
          noteId: asStr(field(r, "id")) ?? "",
          label: asStr(field(r, "title")) ?? "",
          snippet: (asStr(field(r, "content")) ?? "").slice(0, NOTE_CARD_SNIPPET_CHARS),
          parentId: typeof parent === "string" ? parent : null,
        }
      })
      .filter((r) => r.noteId !== "")
    return { type: "note_search", references }
  }
  if (name === "arrange_notes") {
    const n = field(result, "arranged")
    return `Arranged ${typeof n === "number" ? n : 0} notes`
  }
  if (name.startsWith("learn_generate")) {
    return `Loaded ${name.replace("learn_generate_", "").replace(/_/g, " ")} guidance`
  }
  if (name === "save_memory" || name === "update_memory" || name === "delete_memory") {
    // A readable one-liner for the tool card, instead of raw JSON. Over-cap and
    // unavailable cases surface their own message so the model's retry reads clearly.
    if (field(result, "reason") === "over_cap") return asStr(field(result, "message")) ?? "Memory is full — consolidate and retry"
    if (field(result, "error")) return asStr(field(result, "error")) ?? "Memory unavailable"
    const verb = name === "save_memory" ? "Saved to" : name === "update_memory" ? "Updated" : "Removed from"
    const title = asStr(field(args, "title"))
    return `${verb} memory${title ? `: ${title}` : ""}`
  }
  return JSON.stringify(result)
}


/**
 * Accumulate the engine's `AgentEvent` stream into the `ReasoningStep[]` the
 * existing chat UI renders. Pure — re-run over the full event list on each new
 * event (cheap; fresh objects drive React re-renders).
 */
export const stepsFromEvents = (events: AgentEvent[], boardId: string): ReasoningStep[] => {
  const steps: ReasoningStep[] = []
  const openByTool = new Map<string, ToolCallStep>()
  let seq = 0
  for (const ev of events) {
    if (ev.type === "tool_start") {
      // A second tool_start for an already-open tool is the execution filling in
      // the args after the early name-only signal — update, don't duplicate.
      const open = openByTool.get(ev.toolName)
      if (open) {
        if (ev.args && Object.keys(ev.args).length > 0) open.arguments = { input: ev.args }
        continue
      }
      const step: ToolCallStep = {
        type: "tool_call",
        id: `tool-${seq++}`,
        name: toToolName(ev.toolName),
        thought: "",
        output: "",
        state: "started",
        eventMessages: [],
        arguments: { input: ev.args },
      }
      steps.push(step)
      openByTool.set(ev.toolName, step)
    } else if (ev.type === "tool_result") {
      const open = openByTool.get(ev.toolName)
      if (open) {
        // A structured failure (declined / unknown / thrown / rejected) marks the
        // step failed and shows its message; a success builds the UI output.
        if (isToolFailure(ev.result)) {
          open.output = ev.result.message
          open.state = "failed"
        } else {
          open.output = toOutput(ev.toolName, open.arguments?.input, ev.result, boardId)
          open.state = "completed"
        }
        openByTool.delete(ev.toolName)
      }
    } else if (ev.type === "assistant_text") {
      // Streaming emits a cumulative assistant_text per token; coalesce a run of
      // them into ONE step (update its message) instead of a line per token.
      const last = steps[steps.length - 1]
      if (last && last.type === "reasoning_step") last.message = ev.text
      else steps.push({ type: "reasoning_step", id: `text-${seq++}`, reasoning: "", message: ev.text })
    } else if (ev.type === "reasoning") {
      // Reasoning/thinking (cumulative) fills the trailing reasoning_step's
      // `reasoning` slot — the same step whose `message` holds the answer, so the
      // UI's "Reasoning" expander sits above the reply. A run of tool calls splits
      // it into pre-tool and post-tool reasoning steps (chain-of-thought order).
      const last = steps[steps.length - 1]
      if (last && last.type === "reasoning_step") last.reasoning = ev.text
      else steps.push({ type: "reasoning_step", id: `reason-${seq++}`, reasoning: ev.text, message: "" })
    }
  }
  // Match the online path: fold text-like "tool" steps (raw_message / synthesizer
  // / answer_reformulate) into reasoning_steps so the UI renders them as text,
  // not as tool rows — keeping the reasoning-vs-tool differentiation consistent.
  return normalizeReasoningSteps(steps)
}


/** The latest assistant text across the event stream (the answer body), if any. */
export const latestAssistantText = (events: AgentEvent[]): string => {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]
    if (ev.type === "assistant_text") return ev.text
  }
  return ""
}
