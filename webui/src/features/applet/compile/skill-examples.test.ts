// Guards that every worked `<Widget>` example in the applet authoring skill
// actually compiles under the real grammar. The skill is what the model
// pattern-matches, so an invalid example would teach invalid syntax — this test
// keeps the skill and the compiler in lockstep.

import { describe, expect, it } from "vitest"

import appletSkill from "@/features/agent/prompts/skills/applet.md?raw"

import { compileApplet, validateApplet } from "./index"


/** Extract fenced code blocks whose body is a full `<Widget>` applet. */
function appletExamples(md: string): string[] {
  const blocks: string[] = []
  const fence = /```(?:jsx|tsx|js|ts)?\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = fence.exec(md)) !== null) {
    const code = m[1].trim()
    // Complete worked examples only — skip illustrative snippets that elide with "…".
    if (code.startsWith("<Widget") && !code.includes("…")) blocks.push(code)
  }
  return blocks
}


describe("applet skill worked examples", () => {
  const examples = appletExamples(appletSkill)

  it("the skill contains several full <Widget> examples", () => {
    expect(examples.length).toBeGreaterThanOrEqual(5)
  })

  it.each(examples.map((src, i) => [i, src] as const))("example #%i compiles", (_i, src) => {
    const r = compileApplet(src)
    if (!r.ok) throw new Error(`example failed to compile: ${r.message}${r.line ? ` (line ${r.line})` : ""}\n---\n${src}`)
    expect(r.ok).toBe(true)
  })

  // The agent authors through `validateApplet` (compile + the render smoke-test),
  // so a worked example that compiles but trips the smoke test (e.g. a Chart bound
  // to a non-array) would teach a pattern the write_note gate then rejects.
  it.each(examples.map((src, i) => [i, src] as const))("example #%i passes the render smoke-test", (_i, src) => {
    const r = validateApplet(src)
    if (!r.ok) throw new Error(`example failed validation: ${r.message}\n---\n${src}`)
    expect(r.ok).toBe(true)
  })
})
