/**
 * Skill-loading tools (progressive disclosure). Each `learn_generate_*` tool
 * returns a detailed build-guide prompt the model reads before producing that
 * format — mirrors the backend `widget/learn.py`, where the tool's OUTPUT is
 * the skill prompt. Keeps the system prompt lean until a skill is needed.
 */
import { z } from "zod"
import { SKILLS, type SkillName } from "@/features/agent/prompts"
import { defineTool } from "./types"
import type { Tool } from "./types"


const skillTool = (name: SkillName, description: string): Tool =>
  defineTool({
    name,
    description,
    parameters: z.object({}),
    // The guidance text IS the useful output; the loop feeds it back to the model.
    run: async () => SKILLS[name],
  })


export const learnGenerateDiagram = skillTool(
  "learn_generate_diagram",
  "REQUIRED before a multi-note structured answer: call this ONCE to learn the brevity rule and shape vocabulary, then issue the parallel write_note + link_notes calls (mindmap, taxonomy, schema, flowchart).",
)


export const learnGenerateMiniApp = skillTool(
  "learn_generate_mini_app",
  'REQUIRED before authoring a sandboxed interactive React mini-app (the default custom-rendered artifact): call this first, then write one with write_note(note_type="mini-app").',
)


export const learnGenerateHtmlWidget = skillTool(
  "learn_generate_html_widget",
  'REQUIRED before authoring a legacy raw-HTML widget: call this first, then write one with write_note(note_type="widget") (legacy — prefer learn_generate_mini_app).',
)


export const skillTools: Tool[] = [learnGenerateDiagram, learnGenerateMiniApp, learnGenerateHtmlWidget]
