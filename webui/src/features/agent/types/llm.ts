import type { AppIconComponent } from "@/components/icons"
import {
  ClaudeBrandIcon,
  DeepSeekBrandIcon,
  Dim0Icon,
  GeminiBrandIcon,
  MistralBrandIcon,
  MoonshotBrandIcon,
  OpenAIBrandIcon,
  QwenBrandIcon,
  ZAiBrandIcon,
} from "@/components/icons"

// A model is identified by its canonical catalog id (e.g. "claude-opus-4.6"),
// plus the synthetic "auto" option. The available models and their metadata are
// served by the backend (GET /utils/services), so this is an open string rather
// than a hardcoded union.
export type LlmModel = string


// Provider family, used for grouping and brand icons. Open string: unknown
// families coming from the backend fall back to a generic icon/label.
export type LlmFamily = string


// Known brand icons by family. Unknown families fall back via familyIcon().
export const LlmFamilyIcon: Record<string, AppIconComponent> = {
  dim0: Dim0Icon,
  openai: OpenAIBrandIcon,
  google: GeminiBrandIcon,
  anthropic: ClaudeBrandIcon,
  mistralai: MistralBrandIcon,
  deepseek: DeepSeekBrandIcon,
  "z-ai": ZAiBrandIcon,
  qwen: QwenBrandIcon,
  moonshotai: MoonshotBrandIcon,
}


// Pretty labels by family; unknown families fall back to the raw family string.
export const LlmFamilyLabel: Record<string, string> = {
  dim0: "Dim0",
  openai: "OpenAI",
  google: "Google Gemma",
  anthropic: "Anthropic Claude",
  mistralai: "Mistral",
  deepseek: "DeepSeek",
  "z-ai": "Z.ai",
  qwen: "Qwen",
  moonshotai: "Moonshot",
}


/**
 * Resolve a family's brand icon, falling back to the Dim0 icon when unknown.
 */
export function familyIcon(family: string): AppIconComponent {
  return LlmFamilyIcon[family] ?? Dim0Icon
}


/**
 * Resolve a family's display label, falling back to the raw family string.
 */
export function familyLabel(family: string): string {
  return LlmFamilyLabel[family] ?? family
}
