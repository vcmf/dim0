import { useEffect, useRef } from "react"
import type { RefObject } from "react"
import { screenToWorld, worldToScreen } from "@canvas-harness/core"
import type { CanvasStore, Node, Vec2 } from "@canvas-harness/core"
import {
  buildInkOutline,
  createInkNode,
  hitTestInkWorld,
  interpolateInkSamples,
  traceSmoothInkOutline,
} from "./ink-geometry"
import type { InkSample } from "./ink-geometry"
import { adaptNodeColors } from "../theme/color-adapter"
import { getBoardThemeMode } from "../theme/theme-mode-ref"
import { isLikelyPalmContact, isPenEraserContact } from "./ink-pointer"


type InkInputLayerProps = {
  store: CanvasStore
  wrapRef: RefObject<HTMLDivElement | null>
  boardId: string | null
  rootId: string | null
  tool: string
  canEdit: boolean
  color: string
  size: number
}


const ERASER_RADIUS_SCREEN = 14
const PALM_REJECTION_GRACE_MS = 700
const MAX_SAMPLE_SPACING_SCREEN = 2


/** Canvas preview and Pointer Events adapter for pressure-aware freehand input. */
export function InkInputLayer({
  store,
  wrapRef,
  boardId,
  rootId,
  tool,
  canEdit,
  color,
  size,
}: InkInputLayerProps) {
  const previewRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    const preview = previewRef.current
    if (!wrap || !preview) return

    let activePointerId: number | null = null
    let activeMode: "ink" | "eraser" | null = null
    let samples: InkSample[] = []
    let erasedIds = new Set<string>()
    let raf = 0
    let previewSize = { width: 0, height: 0, dpr: 1 }
    let lastEraserScreen: Vec2 | null = null
    let lastPenActivityAt = 0
    const suppressedTouchIds = new Set<number>()
    const displayColor = adaptNodeColors(
      { strokeColor: color },
      getBoardThemeMode(),
    ).strokeColor ?? color

    const resizePreview = (): void => {
      const rect = wrap.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      previewSize = { width: rect.width, height: rect.height, dpr }
      preview.width = Math.max(1, Math.round(rect.width * dpr))
      preview.height = Math.max(1, Math.round(rect.height * dpr))
    }

    const clearPreview = (): void => {
      const ctx = preview.getContext("2d")
      if (!ctx) return
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, preview.width, preview.height)
    }

    const drawPreview = (): void => {
      raf = 0
      const ctx = preview.getContext("2d")
      if (!ctx) return
      clearPreview()
      ctx.setTransform(previewSize.dpr, 0, 0, previewSize.dpr, 0, 0)

      if (activeMode === "eraser" && lastEraserScreen) {
        ctx.beginPath()
        ctx.arc(lastEraserScreen.x, lastEraserScreen.y, ERASER_RADIUS_SCREEN, 0, Math.PI * 2)
        ctx.fillStyle = "rgba(239, 68, 68, 0.12)"
        ctx.strokeStyle = "rgba(239, 68, 68, 0.85)"
        ctx.lineWidth = 1.5
        ctx.fill()
        ctx.stroke()
        return
      }

      if (activeMode !== "ink" || samples.length === 0) return
      const camera = store.getCamera()
      const outline = buildInkOutline(samples, size)
      if (outline.length === 0) return
      const screenOutline = outline.map(([x, y]): [number, number] => {
        const point = worldToScreen({ x, y }, camera)
        return [point.x, point.y]
      })
      ctx.beginPath()
      traceSmoothInkOutline(ctx, screenOutline)
      ctx.fillStyle = displayColor
      ctx.fill()
    }

    const schedulePreview = (): void => {
      if (raf !== 0) return
      raf = requestAnimationFrame(drawPreview)
    }

    const eventSamples = (event: PointerEvent): PointerEvent[] => {
      const coalesced = typeof event.getCoalescedEvents === "function"
        ? event.getCoalescedEvents()
        : []
      // Some Safari versions omit the dispatch event itself from the returned
      // coalesced list. Always append it; duplicate coordinates are discarded.
      return coalesced.length > 0 ? [...coalesced, event] : [event]
    }

    const eventToScreen = (event: PointerEvent): Vec2 => {
      const rect = wrap.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }

    const appendInkSamples = (event: PointerEvent): void => {
      const camera = store.getCamera()
      const maxSpacingWorld = MAX_SAMPLE_SPACING_SCREEN / Math.max(0.01, camera.z)
      for (const sample of eventSamples(event)) {
        const world = screenToWorld(eventToScreen(sample), camera)
        const previous = samples[samples.length - 1]
        if (previous && previous.x === world.x && previous.y === world.y) continue
        const pressure = sample.pointerType === "pen"
          ? Math.max(0.05, Math.min(1, sample.pressure || 0.5))
          : 0.5
        const next = { ...world, pressure }
        if (!previous) samples.push(next)
        else samples.push(...interpolateInkSamples(previous, next, maxSpacingWorld))
      }
      schedulePreview()
    }

    const collectErasedNodes = (event: PointerEvent): void => {
      const camera = store.getCamera()
      for (const sample of eventSamples(event)) {
        const screen = eventToScreen(sample)
        const world = screenToWorld(screen, camera)
        lastEraserScreen = screen
        const radiusWorld = ERASER_RADIUS_SCREEN / camera.z
        for (const node of store.getAllNodes()) {
          if (node.type !== "ink" || erasedIds.has(node.id)) continue
          if (hitTestInkWorld(node, world, radiusWorld)) erasedIds.add(node.id)
        }
      }
      schedulePreview()
    }

    const isCanvasSurface = (target: EventTarget | null): boolean =>
      target instanceof Element && target.closest("[data-canvas-host]") !== null

    const acceptsPointer = (event: PointerEvent): boolean =>
      event.pointerType === "pen" || event.pointerType === "mouse"

    const stopCanvasGesture = (event: PointerEvent): void => {
      event.preventDefault()
      event.stopPropagation()
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (event.pointerType === "touch") {
        const suppressTouch = activePointerId !== null ||
          Date.now() - lastPenActivityAt < PALM_REJECTION_GRACE_MS ||
          isLikelyPalmContact(event.width, event.height)
        if (suppressTouch) {
          suppressedTouchIds.add(event.pointerId)
          stopCanvasGesture(event)
        }
        return
      }
      if (!canEdit || !boardId || (tool !== "ink" && tool !== "eraser")) return
      if (!isCanvasSurface(event.target) || !acceptsPointer(event)) return
      if (event.pointerType === "mouse" && event.button !== 0) return

      if (event.pointerType === "pen") lastPenActivityAt = Date.now()

      activePointerId = event.pointerId
      activeMode = isPenEraserContact(event) ? "eraser" : tool
      samples = []
      erasedIds = new Set<string>()
      lastEraserScreen = null
      wrap.setPointerCapture(event.pointerId)
      stopCanvasGesture(event)
      if (activeMode === "ink") appendInkSamples(event)
      else collectErasedNodes(event)
    }

    const onPointerMove = (event: PointerEvent): void => {
      if (event.pointerType === "touch") {
        const suppressTouch = suppressedTouchIds.has(event.pointerId) ||
          activePointerId !== null ||
          Date.now() - lastPenActivityAt < PALM_REJECTION_GRACE_MS ||
          isLikelyPalmContact(event.width, event.height)
        if (suppressTouch) {
          suppressedTouchIds.add(event.pointerId)
          stopCanvasGesture(event)
        }
        return
      }
      if (event.pointerType === "pen") lastPenActivityAt = Date.now()
      if (event.pointerId !== activePointerId || activeMode === null) return
      stopCanvasGesture(event)
      if (activeMode === "ink") appendInkSamples(event)
      else collectErasedNodes(event)
    }

    const resetGesture = (): void => {
      activePointerId = null
      activeMode = null
      samples = []
      erasedIds.clear()
      lastEraserScreen = null
      if (raf !== 0) cancelAnimationFrame(raf)
      raf = 0
      clearPreview()
    }

    const commitGesture = (): void => {
      if (activeMode === "ink" && boardId && samples.length > 0) {
        const node = createInkNode({
          id: store.generateId(),
          boardId,
          parentId: rootId,
          color,
          displayColor,
          size,
          samples,
        })
        if (node) store.addNode(node)
      } else if (activeMode === "eraser" && erasedIds.size > 0) {
        store.batch(() => {
          for (const id of erasedIds) {
            const node = store.getNode(id as Node["id"])
            if (node?.type === "ink") store.removeNode(node.id)
          }
        })
      }
    }

    const onPointerUp = (event: PointerEvent): void => {
      if (event.pointerType === "touch") {
        if (suppressedTouchIds.delete(event.pointerId)) stopCanvasGesture(event)
        return
      }
      if (event.pointerId !== activePointerId) return
      stopCanvasGesture(event)
      if (activeMode === "ink") appendInkSamples(event)
      else collectErasedNodes(event)
      commitGesture()
      if (event.pointerType === "pen") lastPenActivityAt = Date.now()
      if (wrap.hasPointerCapture(event.pointerId)) wrap.releasePointerCapture(event.pointerId)
      resetGesture()
    }

    const onPointerCancel = (event: PointerEvent): void => {
      if (event.pointerType === "touch") {
        if (suppressedTouchIds.delete(event.pointerId)) stopCanvasGesture(event)
        return
      }
      if (event.pointerId !== activePointerId) return
      stopCanvasGesture(event)
      resetGesture()
    }

    const onPointerRawUpdate: EventListener = (event): void => {
      if (event instanceof PointerEvent) onPointerMove(event)
    }

    resizePreview()
    const resizeObserver = new ResizeObserver(resizePreview)
    resizeObserver.observe(wrap)
    wrap.addEventListener("pointerdown", onPointerDown, { capture: true, passive: false })
    wrap.addEventListener("pointermove", onPointerMove, { capture: true, passive: false })
    wrap.addEventListener("pointerrawupdate", onPointerRawUpdate, { capture: true, passive: false })
    wrap.addEventListener("pointerup", onPointerUp, { capture: true, passive: false })
    wrap.addEventListener("pointercancel", onPointerCancel, { capture: true, passive: false })

    return () => {
      resizeObserver.disconnect()
      if (raf !== 0) cancelAnimationFrame(raf)
      wrap.removeEventListener("pointerdown", onPointerDown, true)
      wrap.removeEventListener("pointermove", onPointerMove, true)
      wrap.removeEventListener("pointerrawupdate", onPointerRawUpdate, true)
      wrap.removeEventListener("pointerup", onPointerUp, true)
      wrap.removeEventListener("pointercancel", onPointerCancel, true)
    }
  }, [store, wrapRef, boardId, rootId, tool, canEdit, color, size])

  return (
    <canvas
      ref={previewRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-40 size-full"
    />
  )
}
