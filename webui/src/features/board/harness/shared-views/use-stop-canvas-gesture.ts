import { useEffect, type RefObject } from "react"


/**
 * Attach a native `pointerdown` listener that stops propagation. Used
 * on interactive elements (buttons, inputs) that sit INSIDE a node's
 * bounding box — without this, canvas-harness's gesture hook captures
 * the pointer on body-hit (see use-interaction-gesture.ts:319-347) and
 * the click event never fires on the element.
 *
 * Must be a native listener via ref: React's `onPointerDown` runs at
 * the React root level (event delegation), which is ABOVE the
 * canvas-harness wrap div in the DOM, so by the time React's handler
 * fires the wrap's native listener has already captured the pointer.
 *
 * `enabled` (default true) gates the listener. Pass a flag for an element
 * that is only sometimes interactive (e.g. an applet body that should pass
 * clicks through to SELECT the node when unselected, and only trap them
 * once selected) — gating here is robust regardless of what `pointer-events`
 * its (author-controlled) descendants set, since a `pointer-events:auto`
 * child would otherwise still bubble a `pointerdown` up to this listener.
 */
export const useStopCanvasGesture = (
  ref: RefObject<HTMLElement | null>,
  enabled = true,
): void => {
  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    const stop = (e: PointerEvent): void => e.stopPropagation()
    el.addEventListener("pointerdown", stop)
    return () => el.removeEventListener("pointerdown", stop)
  }, [ref, enabled])
}


/**
 * Stop native `dblclick` from bubbling past this element. Use sparingly:
 * React 17+ delegates events at the root, so a native stopPropagation
 * here ALSO blocks React's synthetic `onDoubleClick` handlers on any
 * descendant. Safe only when no descendant has a meaningful React
 * onDoubleClick that needs to fire.
 *
 * The dim0 case: the title caption sits outside a custom node's canvas
 * hit-test rect, so when the user dbl-clicks it the native event would
 * otherwise reach canvas-harness's empty-space branch and spawn a
 * phantom text node. The button/input inside the caption have only
 * `stopPropagation` in their React onDoubleClick, so stopping at the
 * caption's wrapper is harmless.
 */
export const useStopCanvasDblClick = (
  ref: RefObject<HTMLElement | null>,
): void => {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const stop = (e: MouseEvent): void => e.stopPropagation()
    el.addEventListener("dblclick", stop)
    return () => el.removeEventListener("dblclick", stop)
  }, [ref])
}
