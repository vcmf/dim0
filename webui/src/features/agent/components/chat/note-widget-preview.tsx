import { useEffect, useRef, useState } from "react"
import { Link, useSearch } from "@tanstack/react-router"
import { ExternalLinkIcon, LoaderIcon, WarningIcon } from "@/components/icons"

import { useGetNote } from "@/features/board/api/get-note"
import { WidgetIframe } from "@/features/board/components/flow/widget-iframe"
import { BoardUrl } from "@/routes"
import { useChat } from "../../hooks/chat-context"


const WIDGET_PREVIEW_HEIGHT = 260
const VIEWPORT_BUFFER_PX = 300

type NoteWidgetPreviewProps = {
  boardId: string
  noteId: string
  pending?: boolean
}


/**
 * Renders a streaming shimmer for widget notes and a final iframe once the note is available.
 */
export const NoteWidgetPreview = ({
  boardId,
  noteId,
  pending = false,
}: NoteWidgetPreviewProps) => {
  const { chatId } = useChat()
  const { rootId } = useSearch({
    from: BoardUrl,
    select: (s: { root_id?: string }) => ({ rootId: s.root_id }),
    shouldThrow: false,
  }) ?? {}
  const { data: note, isLoading, isError } = useGetNote({
    boardId,
    noteId,
    enabled: !pending,
  })

  if (pending) {
    return (
      <div className='relative h-[260px] w-full overflow-hidden rounded-xl bg-muted/50'>
        <div className='skeleton-shimmer absolute inset-0' />
        <div className='relative z-10 flex h-full w-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground'>
          <LoaderIcon className='size-5 animate-spin' />
          <span>Generating widget preview</span>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className='flex h-[260px] w-full items-center justify-center rounded-xl bg-muted/40 text-sm text-muted-foreground'>
        <LoaderIcon className='mr-2 size-4 animate-spin' />
        Loading widget preview
      </div>
    )
  }

  if (isError || !note || note.style.type !== "widget" || !note.content?.markdown?.trim()) {
    return (
      <div className='flex h-[260px] w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/60 bg-muted/30 px-4 text-center text-sm text-muted-foreground'>
        <WarningIcon className='size-5' />
        <span>Widget preview unavailable</span>
        <Link
          to='/boards/$id'
          params={{ id: boardId }}
          search={{
            center: noteId, // the param useCenterFromUrl consumes (center_around had no reader)
            current_chat_id: chatId || undefined,
            root_id: rootId || undefined,
          }}
          className='inline-flex items-center gap-1 text-xs font-medium text-secondary-foreground hover:underline'
        >
          Open on board
          <ExternalLinkIcon className='size-3.5' />
        </Link>
      </div>
    )
  }

  return (
    <LazyMountedWidgetIframe
      html={note.content.markdown}
      title={note.label?.markdown || "Widget preview"}
    />
  )
}


type LazyMountedWidgetIframeProps = {
  html: string
  title: string
}


/**
 * Mounts the widget iframe only when the container intersects the viewport
 * (with a buffer). Off-screen widgets unmount, terminating their iframe
 * scripts via WidgetIframe's own cleanup. Reserves the iframe's minimum
 * height as placeholder space so scroll position stays stable across
 * mount/unmount transitions.
 */
const LazyMountedWidgetIframe = ({ html, title }: LazyMountedWidgetIframeProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (!entry) return
        setInView(entry.isIntersecting)
      },
      { rootMargin: `${VIEWPORT_BUFFER_PX}px`, threshold: 0 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={containerRef}
      className='w-full overflow-hidden rounded-xl bg-background'
      style={{ minHeight: WIDGET_PREVIEW_HEIGHT }}
    >
      {inView ? (
        <WidgetIframe
          html={html}
          title={title}
          autoHeight
          maxHeight={1200}
          minHeight={WIDGET_PREVIEW_HEIGHT}
          className='w-full border-0 bg-transparent rounded-sm'
        />
      ) : (
        <div style={{ height: WIDGET_PREVIEW_HEIGHT }} aria-hidden />
      )}
    </div>
  )
}
