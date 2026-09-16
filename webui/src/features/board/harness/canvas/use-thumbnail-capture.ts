import { useEffect, useRef } from "react"
import { renderMinimapContent, sceneBounds, type CanvasStore } from "@canvas-harness/core"
import { saveThumbnail } from "@/features/board/api/save-thumbnail"
import type { MinimapColors } from "../theme/tokens"
import { canvasToBlob } from "./canvas-blob"


/** Where a captured thumbnail goes — the backend API, or a local sink. */
export type ThumbnailSink = (args: { boardId: string; blob: Blob }) => Promise<unknown>


const THUMBNAIL_W = 320
const THUMBNAIL_H = 240
/** rIC timeout — fire even if the browser stays busy past this. */
const IDLE_TIMEOUT_MS = 2000


type RICHandle = number


/**
 * Schedule a callback for browser idle time, with a 2× RAF fallback
 * for Safari (which doesn't ship `requestIdleCallback`). Returned
 * handle is opaque — pass to `cancel` to abort.
 */
const scheduleIdle = (
  cb: () => void,
): { cancel: () => void } => {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => RICHandle
    cancelIdleCallback?: (h: RICHandle) => void
  }
  if (typeof w.requestIdleCallback === "function") {
    const id = w.requestIdleCallback(cb, { timeout: IDLE_TIMEOUT_MS })
    return {
      cancel: () => {
        w.cancelIdleCallback?.(id)
      },
    }
  }
  // RAF fallback — two frames so we land after the first hydration paint.
  let raf1: number | null = null
  let raf2: number | null = null
  raf1 = window.requestAnimationFrame(() => {
    raf2 = window.requestAnimationFrame(cb)
  })
  return {
    cancel: () => {
      if (raf1 !== null) window.cancelAnimationFrame(raf1)
      if (raf2 !== null) window.cancelAnimationFrame(raf2)
    },
  }
}


/**
 * Paint a thumbnail of the current scene into an offscreen canvas
 * using the lib's `renderMinimapContent`. Returns the PNG `Blob`, or
 * `null` if the scene is empty (no bounds → nothing to capture).
 */
const captureSceneThumbnail = async (
  store: CanvasStore,
  minimap: MinimapColors,
): Promise<Blob | null> => {
  if (!sceneBounds(store)) return null

  const dpr = window.devicePixelRatio || 1
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(THUMBNAIL_W * dpr)
  canvas.height = Math.round(THUMBNAIL_H * dpr)
  const ctx = canvas.getContext("2d")
  if (!ctx) return null
  ctx.scale(dpr, dpr)

  const painted = renderMinimapContent(ctx, store, THUMBNAIL_W, THUMBNAIL_H, {
    backgroundColor: minimap.backgroundColor,
    defaultNodeColor: minimap.defaultNodeColor,
  })
  if (!painted) return null

  return canvasToBlob(canvas)
}


/**
 * Capture a thumbnail of the board once per scope, after hydrate. Fires
 * during browser idle time so we don't compete with the first paint
 * frame. Re-fires when `boardId` / `rootId` change (different scope =
 * different thumbnail).
 *
 * Uses the lib's `renderMinimapContent` for the draw — same code path
 * the live minimap uses, so visual fidelity matches without a second
 * code path. Empty scenes are skipped (no bounds → no upload).
 *
 * Network errors are swallowed (best-effort). A failed thumbnail
 * shouldn't surface a toast or block the board open.
 *
 * `save` is the sink — defaults to the backend API; local boards pass a sink
 * that stores the thumbnail in IndexedDB instead.
 */
export const useThumbnailCapture = (
  store: CanvasStore,
  boardId: string | null,
  ready: boolean,
  minimap: MinimapColors,
  save: ThumbnailSink = saveThumbnail,
): void => {
  // Keep latest minimap colors + sink in refs so we don't re-trigger capture on
  // theme toggle / identity change — only scope + ready should drive a re-shoot.
  const minimapRef = useRef(minimap)
  minimapRef.current = minimap
  const saveRef = useRef(save)
  saveRef.current = save

  useEffect(() => {
    if (!ready || !boardId) return
    let cancelled = false

    const handle = scheduleIdle(() => {
      if (cancelled) return
      void (async () => {
        try {
          const blob = await captureSceneThumbnail(store, minimapRef.current)
          if (cancelled || !blob) return
          await saveRef.current({ boardId, blob })
        } catch (err) {
          // Best-effort — log once, never surface.
          console.warn("[harness] thumbnail capture failed", err)
        }
      })()
    })

    return () => {
      cancelled = true
      handle.cancel()
    }
  }, [store, boardId, ready])
}
