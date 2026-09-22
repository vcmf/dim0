import { describe, expect, it } from "vitest"
import { SKILLS, planSystemPrompt } from "./index"
import { renderPrompt } from "./render"


describe("prompts", () => {
  it("renderPrompt fills {{ vars }} and blanks unknowns", () => {
    expect(renderPrompt("hi {{ name }} ({{ x }})", { name: "Ada" })).toBe("hi Ada ()")
  })


  it("system prompt fills the time and keeps the local toolset", () => {
    const p = planSystemPrompt("Mon 1pm")
    expect(p).toContain("Mon 1pm")
    expect(p).not.toContain("{{")
    expect(p).toContain("write_note")
    expect(p).toContain("learn_generate_applet")
  })


  it("system prompt drops backend-only tools", () => {
    const p = planSystemPrompt("now")
    for (const tool of ["web_search", "memory_search", "code_interpreter", "image_generation", "display_stock_widget"]) {
      expect(p).not.toContain(tool)
    }
  })


  it("ships the three skill prompts as non-trivial text", () => {
    for (const key of ["learn_generate_diagram", "learn_generate_applet", "learn_generate_html_widget"] as const) {
      expect(SKILLS[key].length).toBeGreaterThan(200)
    }
  })


  it("no skill contains the </skill> delimiter that would break its XML fence", () => {
    // skillTool wraps each result in <skill>…</skill>; a literal closing tag in
    // the guidance would close the fence early and spill un-fenced instructions.
    for (const key of Object.keys(SKILLS) as (keyof typeof SKILLS)[]) {
      expect(SKILLS[key].toLowerCase()).not.toContain("</skill>")
    }
  })
})
