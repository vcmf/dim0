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
    // Fenced in <skill> with an explicit framing so the model treats it as
    // build guidance to FOLLOW, never as content to echo — without this the
    // model has reproduced a skill's own rules (brevity/shape guidance) as
    // board notes when a vague prompt routed it into a build.
    run: async () =>
      `<skill name="${name}">\nThe text below is build guidance for YOU to follow when producing this format. Apply it; do NOT copy, paraphrase, or restate it in note content or in your reply — notes hold the user's subject matter, never these instructions.\n\n${SKILLS[name]}\n</skill>`,
    // The skill prompt must reach the model in FULL — it's the whole point of the
    // call. Several skills exceed the loop's size cap (mini-app ~21k, applet ~18k),
    // so without this they'd be silently truncated mid-guidance and the model would
    // author from a fraction of the instructions. See docs/plans/tool-result-lifecycle.md.
    keepFullResult: true,
  })


export const learnGenerateDiagram = skillTool(
  "learn_generate_diagram",
  "REQUIRED before a multi-note structured answer: call this ONCE to learn the brevity rule and shape vocabulary, then issue the parallel write_note + link_notes calls (mindmap, taxonomy, schema, flowchart).",
)


export const learnGenerateApplet = skillTool(
  "learn_generate_applet",
  'REQUIRED before authoring an applet (the default custom-rendered artifact — chart, dashboard, diagram, flashcard, interactive control): call this first, then write one with write_note(note_type="applet").',
)


export const learnGenerateHtmlWidget = skillTool(
  "learn_generate_html_widget",
  'REQUIRED before authoring a legacy raw-HTML widget: call this first, then write one with write_note(note_type="widget") (legacy — prefer learn_generate_applet).',
)


export const skillTools: Tool[] = [learnGenerateDiagram, learnGenerateApplet, learnGenerateHtmlWidget]
