import { describe, expect, it } from "vitest"
import type { ReasoningStep } from "../types/stream"
import type { NoteRef } from "../types/tool-outputs"
import { extractNoteSources } from "./note-sources"


const noteSearchStep = (refs: NoteRef[]): ReasoningStep =>
  ({ type: "tool_call", id: `t-${refs[0]?.noteId ?? "x"}`, name: "memory_search", thought: "", state: "completed", eventMessages: [], output: { type: "note_search", references: refs } }) as ReasoningStep


const ref = (over: Partial<NoteRef> = {}): NoteRef =>
  ({ noteId: "n1", label: "Cats", snippet: "meow", parentId: "f1", ...over })


describe("extractNoteSources", () => {
  it("collects note references from note_search steps", () => {
    const sources = extractNoteSources({ steps: [noteSearchStep([ref({ noteId: "n1", label: "Cats" }), ref({ noteId: "n2", label: "Dogs" })])] })
    expect(sources.map((s) => s.noteId)).toEqual(["n1", "n2"])
    expect(sources[0]).toMatchObject({ label: "Cats", parentId: "f1", snippets: ["meow"] })
  })


  it("dedupes by noteId across steps, merging snippets in first-seen order", () => {
    const sources = extractNoteSources({
      steps: [
        noteSearchStep([ref({ noteId: "n1", snippet: "first" })]),
        noteSearchStep([ref({ noteId: "n1", snippet: "second" }), ref({ noteId: "n3", snippet: "s3" })]),
      ],
    })
    expect(sources.map((s) => s.noteId)).toEqual(["n1", "n3"]) // n1 not duplicated
    expect(sources[0].snippets).toEqual(["first", "second"]) // merged
  })


  it("ignores non-note_search steps and empty ids", () => {
    const webStep = { type: "tool_call", id: "t-w", name: "web_search", thought: "", state: "completed", eventMessages: [], output: { type: "web_search", answer: "", searchResults: [] } } as ReasoningStep
    const sources = extractNoteSources({ steps: [webStep, noteSearchStep([ref({ noteId: "" })])] })
    expect(sources).toEqual([])
  })
})
