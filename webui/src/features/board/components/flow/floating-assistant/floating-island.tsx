import { useState, type KeyboardEvent } from "react"
import TextareaAutosize from "react-textarea-autosize"
import { toast } from "sonner"
import { SparklesIcon } from "@/components/icons"
import { ThinkingIndicator } from "@/components/animations/thinking-indicator"
import { cn } from "@/lib/utils"
import { SendMessageError } from "@/features/agent/api/send-message"
import { useChatSubmit } from "@/features/agent/hooks/use-chat-submit"
import { useChat } from "@/features/agent/hooks/chat-context"
import { DocAttachButton } from "@/features/agent/components/chat/doc-attach"
import { buildMessageContext, useHasMessageContext } from "@/features/agent/hooks/use-message-context"
import { SettingsButton } from "@/features/agent/settings/settings-button"
import { useHasUsableModel } from "@/features/agent/services/use-agent-availability"
import { ProgressLine } from "./progress-line"
import { useCurrentAssistantMessage } from "./use-current-assistant-message"
import { useBoardAppStore } from "../../../harness/store/board-app-store"


export interface FloatingIslandProps {
  boardId: string
  onOpenFullSheet: () => void
}


/**
 * Floating composer pill anchored at the bottom-center of the board.
 * Shares the active board chat via useSubmitPrompt; errors surface as toasts.
 */
export const FloatingIsland = ({ boardId, onOpenFullSheet }: FloatingIslandProps) => {
  const [input, setInput] = useState("")
  const latestAssistantMessage = useCurrentAssistantMessage()
  const isStreaming = latestAssistantMessage?.streaming === true
  const submit = useChatSubmit()
  // Document Q&A lives on the local (in-browser) agent only.
  const { local } = useChat()
  const hasMessageContext = useHasMessageContext()
  // Single boolean derivation — only re-renders when a surface opens or
  // closes, never when its content/title changes. Cheap.
  const hasActiveSurface = useBoardAppStore((s) => Boolean(s.activeNodeSurface))
  // The agent can't run without a usable model (managed when signed in, or a
  // BYOK model key). When absent we dim the composer and light the key icon.
  const hasModel = useHasUsableModel()

  const handleSubmit = async () => {
    if (isStreaming || !hasModel) return
    const trimmed = input.trim()
    if (!trimmed) return
    setInput("")
    try {
      const messageContext = buildMessageContext()
      await submit(trimmed, { attachedBoardId: boardId, messageContext })
    } catch (error) {
      const message = error instanceof SendMessageError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Could not send message."
      toast.error(message)
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void handleSubmit()
    }
  }

  return (
    <div data-coachmark='ai-island' className='absolute bottom-1 left-1/2 -translate-x-1/2 z-[60] w-[min(580px,calc(100vw-4rem))] pointer-events-auto hidden md:flex flex-col gap-1.5'>
      <div className={cn(
        "bg-sidebar/80 backdrop-blur-md backdrop-saturate-150",
        "border rounded-2xl flex flex-col",
        "shadow-[0_12px_32px_-4px_rgba(0,0,0,0.28),0_2px_8px_-2px_rgba(0,0,0,0.12)]",
        "dark:shadow-[0_16px_36px_-4px_rgba(0,0,0,0.55),0_2px_8px_-2px_rgba(0,0,0,0.3)]",
        "transition-[box-shadow,border-color] focus-within:border-secondary-foreground/50",
        "focus-within:ring-4 focus-within:ring-secondary-foreground/20",
        isStreaming ? "border-secondary-foreground/50 animate-ring-pulse-soft" : "border-border",
      )}>
        <ProgressLine />
        <div className='flex items-center gap-2 p-3'>
          <div className={cn(
            'flex flex-1 min-w-0 items-center gap-2',
            !hasModel && 'pointer-events-none select-none opacity-40',
          )}>
          {isStreaming ? (
            <button
              type='button'
              onClick={onOpenFullSheet}
              title='Open full chat'
              aria-label='Open full chat'
              className='inline-flex items-center shrink-0 rounded-md cursor-pointer transition hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-secondary-foreground/30'
            >
              <ThinkingIndicator className='text-xs text-foreground/70' iconSize={14} />
            </button>
          ) : (
            <button
              type='button'
              onClick={onOpenFullSheet}
              title='Open full chat'
              aria-label='Open full chat'
              className='flex items-center justify-center rounded-md bg-gradient-to-br from-wiki-link to-secondary-foreground size-7 shrink-0 shadow-sm cursor-pointer transition hover:brightness-110 focus-visible:outline-none'
            >
              <SparklesIcon className='size-3.5 text-primary-foreground' weight='fill' />
            </button>
          )}
          <span className='text-xs font-mono px-2 py-0.5 rounded bg-secondary text-secondary-foreground shrink-0'>
            {hasActiveSurface ? "@page" : "@board"}
          </span>
          {hasMessageContext && (
            <span
              className='text-xs font-mono px-2 py-0.5 rounded bg-secondary/60 text-secondary-foreground/80 shrink-0'
              title='Selected nodes included as context'
            >
              · selected
            </span>
          )}
          <TextareaAutosize
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={hasModel ? 'Ask about this board, or give a task…' : 'Set a model key to start'}
            minRows={1}
            maxRows={4}
            disabled={isStreaming || !hasModel}
            className='flex-1 min-w-0 bg-transparent text-sm outline-none resize-none py-1 placeholder:text-muted-foreground scrollbar-thin'
          />
          <span className='shrink-0 text-sm text-muted-foreground/70 font-mono px-1 select-none hidden sm:inline'>
            ⌘↵
          </span>
          </div>
          {local && <DocAttachButton boardId={boardId} />}
          <SettingsButton emphasize={!hasModel} />
        </div>
      </div>
      <p className='text-center text-[11px] text-muted-foreground/70 px-3'>
        AI can make mistakes. Verify important details carefully.
      </p>
    </div>
  )
}
