import { MAX_FONT_SIZE_PX, MIN_FONT_SIZE_PX } from "@canvas-harness/core"


/** Parse and clamp a numeric font-size draft for a single commit. */
export function normalizeFontSizeInput(value: string): number | null {
  if (!value.trim()) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return Math.min(MAX_FONT_SIZE_PX, Math.max(MIN_FONT_SIZE_PX, Math.round(parsed)))
}
