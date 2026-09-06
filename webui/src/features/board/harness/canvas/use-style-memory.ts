import { useEffect, useMemo, useRef, useState } from "react"
import type {
  CanvasStore,
  EdgeStyle,
  PathStyle,
  Style,
} from "@canvas-harness/core"
import type { LinkEdgeData } from "../convert/link-to-edge"
import type { NoteNodeData } from "../convert/note-to-node"
import {
  applyColorsToEdgeStyle,
  applyColorsToStyle,
  pickStoredEdgeColors,
  type StoredEdgeColors,
} from "../theme/color-adapter"


/**
 * Sticky style memory — every time the user updates a node or edge
 * style (style panel, AI agent, anything routed through the store),
 * the resulting style gets folded into a shared bucket. New shapes /
 * edges created later pull from that bucket so the user's last
 * preferences persist (matches excalidraw / tldraw / figma).
 *
 * One shared bucket for non-custom nodes (rect, ellipse, diamond,
 * text, etc.) — picking a color on a rect carries to the next
 * ellipse. Custom node types (folder, sheet, code-sandbox, widget,
 * document, mini-app) are intentionally excluded both as memory inputs
 * AND outputs: they have a fixed visual identity and shouldn't bleed
 * styles in or out.
 *
 * Persisted to localStorage so preferences survive reloads. Version
 * in the key so we can break the shape later without conflict.
 */

const STORAGE_KEY = "dim0:harness:style-memory:v1"


/** Custom-node types whose styles should not pollute (or read from) the memory. */
const EXCLUDED_TYPES: ReadonlySet<string> = new Set([
  "folder",
  "sheet",
  "code-sandbox",
  "widget",
  "document",
  "mini-app",
  "ink",
  // Icons and images opt out: user-picked color is per-icon, not a
  // sticky session preference, and images don't carry colors anyway.
  // Without this, dropping an icon/image after styling a rectangle
  // would inherit the rectangle's stroke / fill — visually surprising.
  "icon",
  "image",
  // Frames are slide containers (presentation mode). Their chrome is a
  // fixed visual identity — they should never sponge styles from
  // neighboring shapes nor donate styles back.
  "frame",
])


export type EdgeMemory = {
  style?: EdgeStyle
  pathStyle?: PathStyle
}


export type StyleMemory = {
  nodes: Style
  edge: EdgeMemory
}


const emptyMemory = (): StyleMemory => ({ nodes: {}, edge: {} })


const loadFromStorage = (): StyleMemory => {
  if (typeof window === "undefined") return emptyMemory()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyMemory()
    const parsed = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.nodes === "object" &&
      typeof parsed.edge === "object"
    ) {
      return parsed as StyleMemory
    }
  } catch {
    // Corrupt JSON — fall through to fresh memory.
  }
  return emptyMemory()
}


const saveToStorage = (mem: StyleMemory): void => {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(mem))
  } catch {
    // Quota / privacy mode — ignore.
  }
}


export type StyleMemoryApi = {
  getNodeStyle: () => Style | undefined
  getEdgeStyle: () => EdgeStyle | undefined
  getEdgePathStyle: () => PathStyle | undefined
  getEdgeStoredColors: () => StoredEdgeColors | undefined
}


/**
 * Subscribe to style updates on `store` and expose sticky-style
 * accessors. The accessors read the latest memory lazily so callers
 * don't need to re-bind on every change — useful because re-binding
 * the create handlers would re-trigger downstream effects.
 */
export const useStyleMemory = (store: CanvasStore): StyleMemoryApi => {
  const [, force] = useState(0)
  const memoryRef = useRef<StyleMemory>(loadFromStorage())

  useEffect(() => {
    const unsub = store.subscribe("change", (batch) => {
      // Theme-projection batches rewrite every style in the scene with
      // dark-mode display values. Don't sponge those into memory — the
      // user didn't pick those colors. Stored colors don't change, so
      // memory should stay put across a theme flip.
      if (batch.origin === "remote") return
      let dirty = false
      for (const op of batch.ops) {
        if (op.type === "node.update") {
          if (op.patch.style === undefined) continue
          const node = store.getNode(op.id)
          if (!node) continue
          if (EXCLUDED_TYPES.has(node.type)) continue
          // Memory holds stored colors (what the user picked), not the
          // currently-painted display values. Overlay the stored color
          // triplet from `data._storedColors` so a memory captured in
          // dark mode replays correctly in light and vice versa.
          const data = node.data as Partial<NoteNodeData> | undefined
          const styleForMemory = data?._storedColors
            ? applyColorsToStyle(node.style ?? {}, data._storedColors)
            : node.style
          memoryRef.current.nodes = {
            ...memoryRef.current.nodes,
            ...(styleForMemory ?? {}),
          }
          dirty = true
        } else if (op.type === "edge.update") {
          if (op.patch.style === undefined && op.patch.pathStyle === undefined) {
            continue
          }
          const edge = store.getEdge(op.id)
          if (!edge) continue
          if (op.patch.style !== undefined) {
            const data = edge.data as Partial<LinkEdgeData> | undefined
            const styleForMemory = data?._storedColors
              ? applyColorsToEdgeStyle(edge.style ?? {}, data._storedColors)
              : edge.style
            memoryRef.current.edge.style = {
              ...memoryRef.current.edge.style,
              ...(styleForMemory ?? {}),
            }
          }
          if (op.patch.pathStyle !== undefined) {
            memoryRef.current.edge.pathStyle = edge.pathStyle
          }
          dirty = true
        }
      }
      if (dirty) {
        saveToStorage(memoryRef.current)
        // Re-render so consumers of `arrowDefaults` get the fresh value
        // on the next gesture (the hook returns a fresh ArrowToolDefaults
        // by memo-keying off the accessors).
        force((n) => n + 1)
      }
    })
    return unsub
  }, [store])

  // Stable object — accessors close over `memoryRef`, so they always
  // read the latest values without changing identity. Rebinding the
  // returned object would churn every consumer's useCallback deps.
  return useMemo<StyleMemoryApi>(
    () => ({
      getNodeStyle: () => {
        const s = memoryRef.current.nodes
        return Object.keys(s).length === 0 ? undefined : s
      },
      getEdgeStyle: () => memoryRef.current.edge.style,
      getEdgePathStyle: () => memoryRef.current.edge.pathStyle,
      // Canonical (light-space) stroke/label colors the user last picked.
      // `edge.style` already holds canonical colors — the capture path
      // overlays `_storedColors` before folding into memory — so we can
      // pluck them directly. Returns undefined when no color was ever
      // picked (e.g. only width changed) so callers fall back to canonical
      // defaults rather than stamping `undefined` colors.
      getEdgeStoredColors: () => {
        const style = memoryRef.current.edge.style
        if (!style) return undefined
        const colors = pickStoredEdgeColors(style)
        if (colors.strokeColor === undefined && colors.textColor === undefined) {
          return undefined
        }
        return colors
      },
    }),
    [],
  )
}


/** Tools whose new shapes should pick up the remembered style. */
export const isStylableNodeType = (type: string): boolean =>
  !EXCLUDED_TYPES.has(type)
