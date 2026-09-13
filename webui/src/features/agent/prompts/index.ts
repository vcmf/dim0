import planSystem from "./plan-system.md?raw"
import diagramSkill from "./skills/diagram.md?raw"
import appletSkill from "./skills/applet.md?raw"
import htmlWidgetSkill from "./skills/html-widget.md?raw"
import { renderPrompt } from "./render"


export { renderPrompt }


/** The local agent's system prompt (plan.system), with the current time filled in. */
export const planSystemPrompt = (now: string): string => renderPrompt(planSystem, { time: now })


/**
 * Skill guidance loaded on-demand by the `learn_generate_*` tools (progressive
 * disclosure): the system prompt stays lean and the detailed how-to for a
 * format is fetched only when the agent commits to it. Mirrors the backend's
 * `widget/learn_generate_*` prompts.
 */
export const SKILLS = {
  learn_generate_diagram: diagramSkill,
  learn_generate_applet: appletSkill,
  learn_generate_html_widget: htmlWidgetSkill,
} as const


export type SkillName = keyof typeof SKILLS
