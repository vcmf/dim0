import { useCallback, useMemo, useRef, useState } from "react"
import { NotepadIcon } from "@phosphor-icons/react"
import type { Editor } from "@tiptap/react"
import { type NodeId } from "@canvas-harness/core"
import { useCanvasStore, useNode } from "@canvas-harness/react"
import { removeNodeSubtree } from "@/features/board/harness/graph/subtree"
import { IconPropertyView } from "@/components/icons/icon-property-view"
import { useTheme } from "@/components/theme-provider"
import { createBoardPageProvider } from "@/features/board/providers/board-page-provider"
import { findFamilyShadeFromHex, toBaseHex } from "@/features/board/lib/colors/tailwind"
import { nodeStamp } from "@/features/board/utils/node-meta"
import { cn } from "@/lib/utils"
import type { NoteNodeData } from "../../convert/note-to-node"
import { computeNodeColorUpdate } from "../../theme/apply-node-colors"
import {
  createDeferredMount,
  NodeTitleCaption,
  NodeTrafficLights,
  useStopCanvasGesture,
} from "../../shared-views"
import { useBoardAppStore } from "../../store/board-app-store"
import { SheetColorPicker } from "./sheet-color-picker"
import { SheetEditorToolbar } from "./sheet-toolbar"
import { SheetInlineEditor } from "./sheet-inline-editor"


// Retention pool for sheet editors — lighter than mini-app iframes (a TipTap
// instance vs a ~5 MB iframe), so a higher cap. Independent pool: sheets and
// mini-apps never evict each other (see createDeferredMount).
const useSheetMount = createDeferredMount({ cap: 12 })


export type SheetViewProps = {
  id: NodeId
}


/** Compact stamp date — "Jun 14", with the year only when it isn't this year. */
const formatStampDate = (iso: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  })
}


/**
 * Sheet inline view — sticky-note style card. The body renders through the
 * *same* TipTap pipeline as the modal editor ({@link SheetInlineEditor}) so
 * the preview is pixel-identical to edit mode (custom nodes, code, math). A
 * double-click flips the card into an editable editor in place; the expand
 * traffic-light still opens the full-screen modal. Editable title sits below.
 *
 * The (heavy) TipTap editor mounts only when the card is in view AND the camera
 * is at rest (deferred-mount) — so panning/scrolling never mounts editors for
 * sheets crossed mid-scroll — plus a bounded LRU keeps recently-seen editors so
 * panning back re-uses them. It always mounts while `editing`. The lib's LOD-zoom
 * gating additionally suppresses the whole React view below the zoom threshold.
 */
export function SheetView({ id }: SheetViewProps) {
  const node = useNode(id)
  const store = useCanvasStore()
  const { resolvedTheme } = useTheme()
  const openNodeSurface = useBoardAppStore((s) => s.openNodeSurface)
  const canEdit = useBoardAppStore((s) => s.canEdit)
  const [editing, setEditing] = useState(false)
  // The inline editor reports its TipTap instance up so the card can render the
  // formatting toolbar as its own bottom flex child (flush at the card edge).
  const [toolbarEditor, setToolbarEditor] = useState<Editor | null>(null)
  // Viewport coords of the double-click that entered edit mode, so the
  // editor can drop the caret where the user clicked (null = caret at end,
  // e.g. when edit is entered via keyboard).
  const [caretCoords, setCaretCoords] = useState<{ x: number; y: number } | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  useStopCanvasGesture(bodyRef)
  // Defer mounting the TipTap editor until the card is in view AND the camera is
  // at rest (never mid-scroll); keep recently-seen editors via the bounded LRU.
  const { shouldMount, isInView } = useSheetMount(id as unknown as string, wrapRef)

  const data = (node?.data ?? {}) as Partial<NoteNodeData>
  const boardId = data.graphUid

  // Backs @-mention / subpage chips in both the preview and edit mode.
  const pageProvider = useMemo(
    () =>
      boardId
        ? createBoardPageProvider({
            boardId,
            parentNoteId: id as unknown as string,
            onNavigate: (nid) => openNodeSurface(nid, "sheet"),
          })
        : null,
    [boardId, id, openNodeSurface],
  )

  const handleSave = useCallback(
    (markdown: string) => {
      store.updateNode(id, { content: markdown })
    },
    [store, id],
  )

  // Background color lives on `style.backgroundColor`, but we only honor it
  // when the canonical (light-space) value is a Tailwind shade-100 — anything
  // else (incl. the legacy BLUE_200 default) falls back to the card surface.
  // Gate on the canonical color (`_storedColors`), paint the theme-projected
  // `node.style.backgroundColor` so dark mode stays consistent.
  const canonicalBg = data._storedColors?.backgroundColor ?? null
  // The shade-100 lookup linearly scans the whole Tailwind palette, so memoize
  // it on the color — SheetView re-renders per keystroke while editing.
  const isShade100 = useMemo(
    () => findFamilyShadeFromHex(toBaseHex(canonicalBg))?.shade === 100,
    [canonicalBg],
  )
  const honoredBg = isShade100 ? node?.style?.backgroundColor ?? null : null

  const handlePickColor = useCallback(
    (hexOrNull: string | null) => {
      const n = store.getNode(id)
      if (!n) return
      const mode = resolvedTheme === "dark" ? "dark" : "light"
      const { style, data: nextData } = computeNodeColorUpdate(
        n,
        { backgroundColor: hexOrNull ?? undefined },
        mode,
      )
      store.updateNode(id, { style, data: nextData })
    },
    [store, id, resolvedTheme],
  )

  if (!node) return null

  const label = data.label?.markdown
  const body = node.content?.trim() ?? ""
  const iconValue = data.properties?.iconData?.icon ?? null
  // Last-modified, falling back to created. Reads canonical `meta` (agent notes)
  // or legacy strings; `edited` picks the prefix.
  const { iso: stampIso, edited } = nodeStamp(data)
  const stampPrefix = edited ? "Edited" : "Created"

  const enterEdit = () => {
    if (canEdit) setEditing(true)
  }

  return (
    <div
      ref={wrapRef}
      className="pointer-events-none relative h-full w-full select-none"
    >
      <div
        ref={bodyRef}
        role={!editing && canEdit ? "button" : undefined}
        tabIndex={!editing && canEdit ? 0 : undefined}
        onClick={(e) => {
          // Swallow the click so it doesn't deselect / reach the canvas; a
          // single click no longer opens the modal (double-click edits; the
          // expand traffic-light still opens the full-screen surface).
          e.stopPropagation()
        }}
        onDoubleClick={(e) => {
          e.stopPropagation()
          // Select the node (show handles) alongside entering edit — the
          // body swallows pointerdown, so the lib's gesture never selects it.
          store.setSelection([id])
          // Remember where the user clicked so the editor can place the caret
          // there instead of jumping to the end.
          setCaretCoords({ x: e.clientX, y: e.clientY })
          enterEdit()
        }}
        onKeyDown={(e) => {
          if (editing) return
          if (!canEdit) return
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            e.stopPropagation()
            setCaretCoords(null)
            enterEdit()
          }
        }}
        className={cn(
          "absolute inset-0 flex flex-col overflow-hidden rounded-xl border border-foreground/40 shadow-sm text-left text-card-foreground",
          honoredBg ? null : "bg-card",
          "pointer-events-auto",
          !editing && canEdit ? "cursor-pointer" : "cursor-default",
        )}
        style={{
          ...(honoredBg ? { backgroundColor: honoredBg } : null),
          // Retained but off-screen: skip rendering the (heavy TipTap) subtree so
          // the browser stops its layout/paint work while the editor stays mounted.
          // Never while editing — don't stop rendering the editor being typed in.
          contentVisibility: shouldMount && !isInView && !editing ? "hidden" : undefined,
        }}
        title={!editing && canEdit ? "Double-click to edit" : undefined}
      >
        <div
          className={cn(
            "min-h-0 flex-1 px-4 pb-3 pt-10 text-sm leading-relaxed text-foreground",
            editing ? "scrollbar-thin overflow-auto" : "overflow-hidden",
            // Fade the text into the card near the bottom edge so a clipped
            // (unfinished) sheet reads as "there's more". Masks the text alpha,
            // so it works on any card color and only shows when text reaches
            // the edge. Skipped while editing (full scroll).
            !editing && body
              ? "[--sheet-fade:linear-gradient(to_bottom,#000_calc(100%-2.75rem),transparent)] [mask-image:var(--sheet-fade)] [-webkit-mask-image:var(--sheet-fade)]"
              : null,
          )}
        >
          {iconValue && (
            <div className="pointer-events-none mb-3">
              <IconPropertyView icon={iconValue} size={44} />
            </div>
          )}
          {editing || (body && shouldMount) ? (
            <div className={editing ? "pointer-events-auto" : "pointer-events-none"}>
              <SheetInlineEditor
                markdown={node.content ?? ""}
                editable={editing}
                onEditor={setToolbarEditor}
                caretCoords={caretCoords}
                pageProvider={pageProvider}
                parentNoteId={id as unknown as string}
                onSave={handleSave}
                onRequestExit={() => setEditing(false)}
              />
            </div>
          ) : body ? (
            // Off-screen: skip the editor mount, show a dimmed placeholder so
            // the card still reads as a sheet at a glance.
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
              <NotepadIcon className="size-5 shrink-0" />
              <span className="text-xs">Sheet paused</span>
            </div>
          ) : (
            <span className="italic text-muted-foreground">Empty sheet</span>
          )}
        </div>

        {!editing && stampIso ? (
          <div className="pointer-events-none absolute bottom-2 right-3 text-[10px] leading-none text-muted-foreground">
            {stampPrefix} {formatStampDate(stampIso)}
          </div>
        ) : null}

        {editing && toolbarEditor ? (
          <SheetEditorToolbar editor={toolbarEditor} />
        ) : null}
      </div>

      <NodeTrafficLights
        onDelete={canEdit ? () => removeNodeSubtree(store, id) : undefined}
        onExpand={canEdit ? () => openNodeSurface(id as unknown as string, "sheet") : undefined}
      />

      {canEdit && (
        <div className="pointer-events-auto absolute right-2 top-2 z-40">
          <SheetColorPicker value={isShade100 ? canonicalBg : null} onPick={handlePickColor} />
        </div>
      )}

      <div className="pointer-events-auto absolute left-1/2 top-full z-20 mt-2 w-full -translate-x-1/2">
        <NodeTitleCaption
          nodeId={id}
          label={label}
          placeholder="Untitled"
          textClassName="text-center text-sm font-handwriting text-foreground"
        />
      </div>
    </div>
  )
}
