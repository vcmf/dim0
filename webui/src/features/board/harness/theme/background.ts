import type { CanvasBackground } from "@canvas-harness/core"
import type { ThemeId } from "@/components/theme-constants"
import { darkModeDisplayHex } from "@/features/board/lib/colors/dark-variants"
import type { BoardBackgroundTexture } from "@/features/board/utils/board-background"
import { blendCssColors, readCssVar, readCssVarMixed } from "@/lib/theme/css-vars"
import { getSwatch, type Mode } from "./tokens"


export type GetBackgroundInput = {
  themeId: ThemeId
  mode: Mode
  /** Per-board user-picked tint from localStorage. `null` → no tint. */
  boardBackground: string | null
  /** Per-board texture pattern from localStorage. Default in dim0 is `"dots"`. */
  boardBackgroundTexture: BoardBackgroundTexture | null
}


/**
 * Resolve the canvas page background for a Dim0 board, matching the
 * existing react-flow path's behavior:
 *
 *   - Default: read `--background` directly so the canvas matches the
 *     rest of the app pixel-for-pixel. Falls back to the theme swatch
 *     if the CSS var isn't resolvable (SSR, unusual host env).
 *   - When `boardBackground` is set, pre-blend the dark-mode-shifted
 *     user color with `--background` at 50% via color-mix and pass the
 *     resulting solid color to canvas-harness. Using rgba(...) here
 *     would blend with the renderer's hardcoded wrap-div bg instead of
 *     the actual page bg the user sees in the rest of the app.
 *
 * Texture pattern follows dim0's existing logic:
 *   - `"dots"`  → `pattern: "dots"`,  patternColor toned down via color-mix
 *   - `"lines"` → `pattern: "grid"`,  patternColor toned down via color-mix
 *
 * `"lines"` maps to canvas-harness's `"grid"` (only naming differs —
 * both render a line-grid pattern).
 */
export const getBackground = ({
  themeId,
  mode,
  boardBackground,
  boardBackgroundTexture,
}: GetBackgroundInput): CanvasBackground => {
  const [swatchBg] = getSwatch(themeId, mode)
  const defaultBg = readCssVar("--background") || swatchBg

  const tinted = boardBackground
    ? blendCssColors(
        mode === "dark"
          ? (darkModeDisplayHex(boardBackground) ?? boardBackground)
          : boardBackground,
        "var(--background)",
        50,
      )
    : null

  const color = tinted ?? defaultBg

  // Texture color picks up the theme via CSS vars but tones down via
  // color-mix so it reads as a subtle pattern, not a solid foreground.
  // canvas-harness paints dots/lines more boldly than react-flow's SVG
  // pattern; without the alpha drop they end up too contrasty.
  let pattern: CanvasBackground["pattern"] = "none"
  let patternColor: string | undefined
  if (boardBackgroundTexture === "dots") {
    pattern = "dots"
    patternColor = readCssVarMixed("--muted-foreground", 25)
  } else if (boardBackgroundTexture === "lines") {
    pattern = "grid"
    patternColor = readCssVarMixed("--muted-foreground", 35)
  }

  return {
    color,
    pattern,
    patternColor,
    gap: 25,
    minZoom: 0.4,
  }
}
