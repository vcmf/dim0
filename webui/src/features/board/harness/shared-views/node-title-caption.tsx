import { memo, useCallback, useEffect, useRef, useState } from "react"
import clsx from "clsx"
import { useQueryClient } from "@tanstack/react-query"
import type { NodeId } from "@canvas-harness/core"
import { useCanvasStore } from "@canvas-harness/react"
import { applyTitleUpdateToBoardContents } from "@/features/board/api/apply-title-update-to-board-contents"
import type { BoardContentItem } from "@/features/board/api/list-board-contents"
import { useBoardAppStore } from "../store/board-app-store"
import { useStopCanvasDblClick, useStopCanvasGesture } from "./use-stop-canvas-gesture"


type NodeTitleCaptionProps = {
  nodeId: NodeId
  label?: string
  placeholder?: string
  className?: string
  textClassName?: string
  emptyTextClassName?: string
  textStyle?: React.CSSProperties
  maxLines?: number
  onEditingChange?: (editing: boolean) => void
}


const INPUT_BASE_CLS =
  "w-full bg-transparent border-0 border-b border-foreground/30 focus:border-secondary-foreground focus:outline-none px-0 py-0.5"
const BUTTON_BASE_CLS =
  "block w-full whitespace-normal break-words hover:underline"


/**
 * Shared click-to-edit title/caption for custom canvas nodes — port
 * of dim0's NodeTitleCaption, wired to the canvas-harness store.
 *
 * Reads `note.label.markdown` via the `label` prop (caller pulls it
 * from useNode). Writes via store.updateNode with `data.label` patched.
 * Layout owned by the caller through className / textClassName so the
 * caption can sit below the node card, beside an icon, etc.
 *
 * A native-phase stop on the outer wrapper keeps clicks on the title
 * from reaching canvas-harness's pointerdown + dblclick listeners,
 * which would otherwise drag-select the board or spawn a phantom text
 * node (see use-stop-canvas-gesture.ts for the why). Display mode wraps
 * to `maxLines` with ellipsis; edit mode is always a single-line input.
 */
export const NodeTitleCaption = memo(function NodeTitleCaption({
  nodeId,
  label,
  placeholder = "Untitled",
  className,
  textClassName,
  emptyTextClassName,
  textStyle,
  maxLines = 3,
  onEditingChange,
}: NodeTitleCaptionProps) {
  const store = useCanvasStore()
  const queryClient = useQueryClient()
  const canEdit = useBoardAppStore((s) => s.canEdit)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(label ?? "")
  const inputRef = useRef<HTMLInputElement | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  // Canvas-harness installs native pointerdown + dblclick listeners on
  // its wrap div. React's synthetic handlers fire too late to stop those
  // — without a native-phase stop, dbl-clicks on the title (positioned
  // outside the node's hit-test rect) fall through to canvas-harness's
  // "empty space" branch and spawn a phantom text node.
  //
  // Both stops sit on a STABLE parent (the wrapper div): `editing` flips
  // between the button and the input, so a ref on either would only
  // catch one of them — useEffect deps don't track ref.current
  // mutations. The wrapper is mounted for the component's lifetime, so
  // events from either child bubble through it reliably.
  //
  // The dblclick stop is safe here specifically because neither the
  // button nor the input has a meaningful React onDoubleClick — only
  // stopPropagation. Sheet/code-sandbox bodies, by contrast, depend on
  // React onDoubleClick (enterEdit, open-panel) reaching the React root,
  // so they only get the pointerdown stop.
  useStopCanvasGesture(wrapperRef)
  useStopCanvasDblClick(wrapperRef)

  const storedTitle = label?.trim() ?? ""
  const displayTitle = storedTitle || placeholder

  useEffect(() => {
    if (editing) return
    setDraft(label ?? "")
  }, [label, editing])

  useEffect(() => {
    if (!editing) return
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [editing])

  useEffect(() => {
    onEditingChange?.(editing)
  }, [editing, onEditingChange])

  const commitTitle = useCallback(
    (nextRaw: string) => {
      const next = nextRaw.trim()
      const prev = label?.trim() ?? ""
      if (next === prev) return
      const node = store.getNode(nodeId)
      if (!node) return
      const prevData = (node.data ?? {}) as Record<string, unknown>
      store.updateNode(nodeId, {
        data: {
          ...prevData,
          label: next ? { markdown: next } : undefined,
        },
      })
      // The list view reads this node live from the store (updated above);
      // the sidebar reads the ["localBoardContents", boardId] cache, so patch it
      // optimistically too — otherwise a canvas rename leaves the sidebar
      // stale until a refetch. Mirror of the icon path.
      const boardId = (prevData.graphUid as string | undefined) ?? undefined
      if (boardId) {
        queryClient.setQueriesData<BoardContentItem[]>(
          { queryKey: ["localBoardContents", boardId] },
          (old) =>
            applyTitleUpdateToBoardContents(old, nodeId as unknown as string, next || null),
        )
      }
    },
    [nodeId, label, store, queryClient],
  )

  const stopEdit = useCallback(
    (save: boolean) => {
      if (save) commitTitle(draft)
      else setDraft(label ?? "")
      setEditing(false)
    },
    [commitTitle, draft, label],
  )

  const displayClamp: React.CSSProperties | undefined =
    maxLines && maxLines > 1
      ? {
          display: "-webkit-box",
          WebkitLineClamp: maxLines,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }
      : undefined

  return (
    <div ref={wrapperRef} className={className}>
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => stopEdit(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              stopEdit(true)
            }
            if (event.key === "Escape") {
              event.preventDefault()
              stopEdit(false)
            }
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          className={clsx(INPUT_BASE_CLS, textClassName)}
          style={textStyle}
          placeholder={placeholder}
        />
      ) : (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            if (!canEdit) return
            setEditing(true)
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          className={clsx(
            BUTTON_BASE_CLS,
            maxLines === 1 && "truncate",
            storedTitle ? textClassName : (emptyTextClassName ?? textClassName),
          )}
          style={{ ...textStyle, ...displayClamp }}
          title={displayTitle}
        >
          {displayTitle}
        </button>
      )}
    </div>
  )
})
