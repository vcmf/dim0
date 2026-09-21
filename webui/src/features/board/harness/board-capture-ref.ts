/**
 * Module-level reference to a "capture the current board viewport as a PNG"
 * function. Mirrors `canvas-store-ref` so code outside the React canvas tree
 * (the agent submit path) can grab a screenshot without importing the component.
 *
 * `HarnessCanvas` registers a closure in a `useEffect` (closing over the store,
 * renderer asset cache, wrap div, and theme) and clears it on unmount. The
 * closure resolves to `null` when a capture isn't possible (no renderer yet,
 * empty scene, or any render error) — callers must handle `null` and never let
 * a failed capture abort their work.
 */
export type BoardCapture = () => Promise<Blob | null>


let _capture: BoardCapture | null = null


export const setBoardCaptureRef = (capture: BoardCapture | null): void => {
  _capture = capture
}


export const getBoardCaptureRef = (): BoardCapture | null => _capture
