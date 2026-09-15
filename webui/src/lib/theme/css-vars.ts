// Read theme CSS custom properties as CONCRETE colors at runtime — the only robust
// way to concretize this app's oklch / `color-mix` tokens for a `<canvas>` context
// (canvas `fillStyle` can't resolve `var(--x)`). Shared by the board canvas-harness
// AND the applet canvas renderers (Chart/Graph/Map); lives in `lib/` so it's not
// board-coupled. See docs/plans/applet-chartjs-migration.md §5.

/**
 * Read a CSS custom property from `:root`. Returns the trimmed
 * computed value (resolved at call time) or `""` if the property is
 * unset or we're outside a browser context.
 */
export const readCssVar = (name: string): string => {
  if (typeof window === "undefined") return ""
  return window
    .getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
}


/**
 * Concretize ANY CSS color string to the browser-computed `rgb(...)`/`rgba(...)`
 * via a hidden DOM probe. Handles `var(--x)`, `color-mix(...)`, `oklch(...)`, hex,
 * and named colors uniformly — the single probe the two helpers below reuse. Use it
 * when a color arrives as an arbitrary CSS string (e.g. a layout that already resolved
 * tokens to `var()`/`color-mix()`) and a `<canvas>` needs a concrete color. Returns
 * the input unchanged outside a browser context.
 *
 * SCOPE: the probe is attached to `document.body`, so `var()`/`color-mix()` resolve
 * against the `:root`-level theme — correct for this app (themed via `data-theme`/
 * `data-mode` on `<html>`), but it would NOT pick up a subtree-scoped token override.
 */
export const readComputedColor = (cssColor: string): string => {
  if (typeof window === "undefined") return cssColor
  const probe = document.createElement("div")
  probe.style.position = "absolute"
  probe.style.visibility = "hidden"
  probe.style.color = cssColor
  document.body.appendChild(probe)
  const resolved = window.getComputedStyle(probe).color
  document.body.removeChild(probe)
  return resolved || cssColor
}


/**
 * Read a CSS custom property mixed with transparency via `color-mix`.
 * `percent` is the source color's strength (0–100). 100 = opaque,
 * 0 = fully transparent. Works for any CSS color format the var resolves
 * to. Returns `""` outside a browser context.
 */
export const readCssVarMixed = (name: string, percent: number): string => {
  if (typeof window === "undefined") return ""
  return readComputedColor(`color-mix(in oklch, var(${name}) ${percent}%, transparent)`)
}


/**
 * Blend two CSS colors at the given ratio via `color-mix` in oklch
 * space. `aPercent` is the weight of `a` (0–100); the remainder comes
 * from `b`.
 *
 * Use to pre-compute a SOLID color when canvas-harness needs an opaque
 * fill — translucent rgba would blend with the renderer's hardcoded
 * wrap-div background, not the page bg the user expects.
 *
 *   blendCssColors("#fff", "var(--background)", 50)
 *
 * Returns `a` unchanged outside a browser context.
 */
export const blendCssColors = (
  a: string,
  b: string,
  aPercent: number,
): string => {
  if (typeof window === "undefined") return a
  return readComputedColor(`color-mix(in oklch, ${a} ${aPercent}%, ${b})`)
}
