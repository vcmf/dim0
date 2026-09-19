// Resolve a color string into a CSS-usable value.
//
// Tokens that match the shadcn theme set in webui/src/index.css are
// rewritten to `var(--X)` so they auto-adapt to light/dark mode.
// Anything else (hex, rgb, hsl, named CSS color) passes through.
//
// We target `--X` (e.g. `--primary`) not `--color-X` (e.g.
// `--color-primary`) on purpose: index.css declares `@theme inline`,
// which inlines theme values into utility classes but does **not**
// emit `--color-*` on `:root`. Only the underlying `--primary`,
// `--card`, `--chart-1`, … variables exist as actual CSS custom
// properties — those are what we can hand to recharts/SVG `fill`.
//
// Shared by <chart> and <graph>.


// The canonical theme-token set lives in lib/theme/resolve-token.ts (shared with the
// canvas renderers); import it here so the SVG and canvas paths can't drift.
import { THEME_TOKEN_NAMES } from "@/lib/theme/resolve-token"


export function resolveColor(input: string | undefined): string {
  if (input == null || input === "") return defaultPaletteColor(0)
  return THEME_TOKEN_NAMES.has(input) ? `var(--${input})` : input
}


// Rotates through the five chart tokens so multiple datasets without an
// explicit color get a consistent palette.
export function defaultPaletteColor(index: number): string {
  return `var(--chart-${(index % 5) + 1})`
}
