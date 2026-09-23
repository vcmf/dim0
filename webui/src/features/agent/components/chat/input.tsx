import { useState, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import { useChatStore } from '../../store/chat-store'
import { SendMessageError } from '../../api/send-message'
import { useChatSubmit } from '../../hooks/use-chat-submit'
import { useActiveChatId, useChatStreaming } from '../../hooks/use-chat-messages'
import { buildMessageContext } from '../../hooks/use-message-context'
import { useAppStore } from '@/store'
import type { BillingPlan } from '@/lib/decode-jwt'
import { SendButton } from './send-button'
import TextareaAutosize from 'react-textarea-autosize'
import { useChat } from '../../hooks/chat-context'
import { useBoardAppStore } from '@/features/board/harness/store/board-app-store'
import { useNavigate } from '@tanstack/react-router'
import { SettingsBillingUrl } from '@/routes'
import { WelcomeMessage } from './welcome-message'
import { StarterPromptPills } from './starter-prompts'
import { MessageBoardContextChoiceMenu } from './input-settings/message-board-context'
import { SettingsButton } from '@/features/agent/settings/settings-button'
import { MemoryButton } from './memory-button'
import { boardLimitForPlan, useIsBoardCreationLimited } from '@/features/board/lib/board-limit'
import { BOARD_LIMIT_REACHED } from '@/features/board/api/create-board'
import { BoardLimitDialog } from '@/features/board/components/board-limit-dialog'
import { useLocalBoards } from '@/features/board/local/use-local-boards'
import { isLocalAgentOnSynced } from '../../local/local-agent-flag'
import { usePendingPromptStore } from '../../store/pending-prompt-store'

// shadcn/ui
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { AlertIcon } from '@/components/icons'
import { toast } from 'sonner'

export interface InputBarProps {
  attachedBoardId?: string
  layout?: "floating" | "docked"
  preferChatRoute?: boolean
  enableSelectionContext?: boolean
  /** When true (e.g. on home), submitting creates a fresh board and routes to it. */
  autoCreateBoard?: boolean
}


/**
 * Formats a Retry-After duration into a short user-facing hint.
 */
const formatRetryAfter = (retryAfter?: number) => {
  if (!retryAfter || retryAfter <= 0) return null
  if (retryAfter < 60) return `Try again in ${retryAfter}s.`
  const minutes = Math.ceil(retryAfter / 60)
  return `Try again in ${minutes} min.`
}

/**
 * Builds a friendlier quota description for long-lived limit toasts.
 */
const buildLimitDescription = ({
  userPlan,
  retryAfter,
}: {
  userPlan: BillingPlan
  retryAfter?: number
}) => {
  const resetHint = retryAfter && retryAfter >= 60 * 60 * 8
    ? "It should reset automatically tomorrow."
    : retryAfter && retryAfter >= 60 * 60
      ? "It should reset automatically later today."
      : formatRetryAfter(retryAfter) ?? "It should reset automatically soon."

  if (userPlan === "free") {
    return `Your free plan includes a limited number of AI requests. ${resetHint} Upgrade to Plus for unlimited requests and frontier models.`
  }

  return `You've used your plan's AI requests for now. ${resetHint} Upgrade for more headroom.`
}

type ComposerBoardLimitDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The composer's current text, carried to the local board if chosen. */
  prompt: string
  onPromptCarried: () => void
}


/**
 * The sidebar's board-limit dialog, for the home composer. "Create a local-only
 * board" creates one and queues the typed prompt so its browser agent runs it on
 * arrival. Split out so only the home composer pays for `useLocalBoards`.
 */
const ComposerBoardLimitDialog = ({ open, onOpenChange, prompt, onPromptCarried }: ComposerBoardLimitDialogProps) => {
  const navigate = useNavigate()
  const userPlan = useAppStore((s) => s.userPlan)
  const setPendingPrompt = usePendingPromptStore((s) => s.setPending)
  const { createBoard } = useLocalBoards()

  const handleCreateLocal = async () => {
    const meta = await createBoard('Untitled board')
    if (!meta) {
      toast.error("Couldn't create a board. Please try again.")
      return
    }
    const trimmed = prompt.trim()
    if (trimmed) {
      setPendingPrompt(meta.id, trimmed)
      onPromptCarried()
    }
    void navigate({ to: '/local/$boardId', params: { boardId: meta.id } })
  }

  return (
    <BoardLimitDialog
      open={open}
      onOpenChange={onOpenChange}
      planLimit={boardLimitForPlan(userPlan)}
      onCreateLocal={() => void handleCreateLocal()}
    />
  )
}


/**
 * Input bar with Deep Research confirmation using ONLY `input` state.
 * If `useDeepResearch` is enabled, pressing Enter/Send opens a dialog that:
 *  - Explains it will create a NEW chat
 *  - Lets the user edit the SAME input
 *  - Confirms to send & create a new chat
 */
export const InputBar = ({
  attachedBoardId,
  layout = "floating",
  preferChatRoute = false,
  enableSelectionContext = false,
  autoCreateBoard = false,
}: InputBarProps) => {
  const { local } = useChat()
  const chatId = useActiveChatId()
  const boardId = useBoardAppStore((s) => s.boardId)

  const userPlan = useAppStore((state) => state.userPlan)

  const isStreaming = useChatStreaming()
  const useDeepResearch = useChatStore((state) => state.useDeepResearch)

  const [input, setInput] = useState<string>('')

  // Deep Research dialog state
  const [showDRDialog, setShowDRDialog] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [limitDialogCopy, setLimitDialogCopy] = useState<{
    title: string
    description: string
  } | null>(null)

  const submit = useChatSubmit()
  const navigate = useNavigate()
  const [showBoardLimitDialog, setShowBoardLimitDialog] = useState(false)

  const isBoardCreationLimited = useIsBoardCreationLimited()
  // Only the home composer (autoCreateBoard) is gated by the limit; existing
  // boards can still receive new chats even when the user is at the cap.
  const showBoardLimitGate = autoCreateBoard && isBoardCreationLimited
  const showBoardChip = autoCreateBoard || Boolean(attachedBoardId)
  // Single boolean: re-renders only when the dialog opens or closes,
  // not on title/content changes. Cheap.
  const hasActiveSurface = useBoardAppStore((s) => Boolean(s.activeNodeSurface))
  const placeholder = showBoardLimitGate
    ? "You've reached your plan's board limit"
    : autoCreateBoard
      ? 'Start a new board with a question…'
      : 'Ask anything...'

  const proceedSend = async (text: string, forceNewChat = false) => {
    const trimmed = text.trim()
    if (!trimmed) return

    // At the plan's synced-board cap, offer the same choice as the sidebar
    // (upgrade, or a local-only board) instead of creating a board. The text
    // stays in the composer so nothing is lost if the dialog is dismissed.
    if (showBoardLimitGate) {
      setShowBoardLimitDialog(true)
      return
    }

    setInput('')

    try {
      await submit(trimmed, {
        forceNewChat,
        attachedBoardId,
        preferChatRoute,
        messageContext: buildMessageContext({ enabled: enableSelectionContext }),
        autoCreateBoard,
      })
    } catch (error) {
      if (error instanceof Error && error.message === BOARD_LIMIT_REACHED) {
        // Stale client count or the backend's atomic cap hit: same dialog.
        setInput(trimmed)
        setShowBoardLimitDialog(true)
        return
      }
      if (error instanceof SendMessageError && error.status === 429) {
        setLimitDialogCopy({
          title: "You’ve reached your AI request limit for now.",
          description: buildLimitDescription({ userPlan, retryAfter: error.retryAfter }),
        })
      } else {
        const message = error instanceof Error ? error.message : "Could not send message."
        toast.error(message)
      }
      throw error
    }
  }

  // The home composer hands its prompt to the new board's browser agent, which
  // has no Deep Research (backend-only), so skip that confirmation there.
  const deepResearchApplies = !local && useDeepResearch && !(autoCreateBoard && isLocalAgentOnSynced())

  const handlePrimarySend = async () => {
    if (isStreaming) return
    if (deepResearchApplies) {
      setShowDRDialog(true)
      return
    }
    await proceedSend(input, false)
  }

  /**
   * Send a predefined starter prompt through the normal first-message flow.
   */
  const handleStarterPromptSelect = async (prompt: string) => {
    if (isStreaming) return
    if (deepResearchApplies) {
      setInput(prompt)
      setShowDRDialog(true)
      return
    }
    await proceedSend(prompt, false)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handlePrimarySend()
    }
  }

  const confirmDeepResearch = async () => {
    const trimmed = input.trim()
    if (!trimmed) return
    try {
      setIsSubmitting(true)
      setShowDRDialog(false)
      await proceedSend(trimmed, true /* force new chat */)
    } finally {
      setIsSubmitting(false)
    }
  }

  const commandIconClass = clsx(
    'ml-auto !p-2 !size-8',
    isStreaming ? 'cursor-not-allowed' : 'cursor-pointer'
  )

  const isFloating = layout === "floating"

  const className = clsx(
    'transition-all flex flex-col items-center bg-transparent',
    isFloating
      ? clsx(
        'absolute inset-x-0 p-2 pb-0 sm:pb-0 sm:p-4 z-20 gap-12',
        chatId ? 'bottom-0' : 'bottom-1/2 transform translate-y-1/2'
      )
      : clsx(
        'w-full gap-4 px-4 pb-4',
        chatId ? 'mt-auto' : 'flex-1 justify-center'
      )
  )

  const inboxClass = clsx(
    'rounded-2xl relative flex flex-col text-card-foreground text-base p-3 gap-2 border transition-[box-shadow,border-color,opacity]',
    'bg-card backdrop-blur-md backdrop-saturate-150 supports-[backdrop-filter]:bg-card/70 shadow-md',
    'border-border hover:border-secondary-foreground/50',
    'focus-within:border-secondary-foreground/50 focus-within:ring-4 focus-within:ring-secondary-foreground/10',
  )
  const showStarterPrompts = !chatId && !isStreaming && Boolean(attachedBoardId) && !showBoardLimitGate

  const inboxBody = (
    <div className={inboxClass}>
      <div className="flex items-start gap-2 p-0">
        {showBoardChip && (
          <span className="mt-1 shrink-0 rounded bg-secondary px-2 py-0.5 font-mono text-xs text-secondary-foreground">
            {hasActiveSurface ? "@page" : "@board"}
          </span>
        )}
        <TextareaAutosize
          onKeyDown={handleKeyDown}
          onChange={(e) => setInput(e.target.value)}
          value={input}
          minRows={1}
          maxRows={15}
          placeholder={placeholder}
          className="flex-1 min-w-0 resize-none border-none outline-none bg-transparent text-base"
          autoFocus
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <SettingsButton />
          {local && boardId && <MemoryButton boardId={boardId} />}
          {!local && enableSelectionContext && <MessageBoardContextChoiceMenu />}
        </div>

        <div className="flex items-center gap-2">
          <span className="hidden select-none px-1 font-mono text-sm text-muted-foreground/70 sm:inline">
            ⌘↵
          </span>
          <SendButton
            loadingStatus={isStreaming ? 'loading' : 'loaded'}
            disabled={isStreaming}
            onClick={handlePrimarySend}
            className={commandIconClass}
          />
        </div>
      </div>
    </div>
  )

  return (
    <div className={className}>
      {!chatId && (
        <WelcomeMessage
          afterContent={showStarterPrompts ? <StarterPromptPills onSelect={handleStarterPromptSelect} /> : undefined}
        />
      )}

      <div className={clsx(
        "flex flex-col space-y-2 w-full items-center justify-center",
        isFloating ? '' : 'max-w-[900px] mx-auto'
      )}>
        <div className="relative w-full max-w-[800px] mx-auto">
          {inboxBody}

          <p className="p-1.5 sm:p-2 text-center text-[11px] text-muted-foreground/80 bg-auto">
            AI can make mistakes. Verify important details carefully.
          </p>
        </div>
      </div>

      {/* Deep Research Confirmation Dialog (uses the SAME `input`) */}
      <Dialog open={showDRDialog} onOpenChange={setShowDRDialog}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>Start a Deep Research in a new chat?</DialogTitle>
            <DialogDescription>
              Deep Research runs longer, may use more tools, and will be created in a <strong>separate chat</strong>. Edit your prompt below before starting.
            </DialogDescription>
          </DialogHeader>

          <div className="grid w-full gap-2 py-2">
            <Label htmlFor="dr-prompt">Your prompt</Label>
            <TextareaAutosize
              id="dr-prompt"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              minRows={4}
              maxRows={18}
              className="w-full resize-none rounded-md border border-border/50 shadow-sm bg-background px-3 py-2 text-base outline-none"
              placeholder="Refine your prompt here..."
              autoFocus
            />
          </div>

          <DialogFooter className="gap-2 sm:gap-3">
            <Button variant="ghost" onClick={() => setShowDRDialog(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button onClick={confirmDeepResearch} disabled={isSubmitting || !input.trim()}>
              {isSubmitting ? 'Starting…' : 'Start Deep Research'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {autoCreateBoard && (
        <ComposerBoardLimitDialog
          open={showBoardLimitDialog}
          onOpenChange={setShowBoardLimitDialog}
          prompt={input}
          onPromptCarried={() => setInput('')}
        />
      )}

      <Dialog open={limitDialogCopy !== null} onOpenChange={(open) => {
        if (!open) setLimitDialogCopy(null)
      }}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertIcon className="size-5 shrink-0 text-secondary-foreground" strokeWidth={2} />
              <span>{limitDialogCopy?.title}</span>
            </DialogTitle>
            <DialogDescription className="text-sm leading-7 text-foreground/80">
              {limitDialogCopy?.description}
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="gap-2 sm:gap-3">
            <Button variant="ghost" onClick={() => setLimitDialogCopy(null)}>
              Close
            </Button>
            <Button
              onClick={() => {
                setLimitDialogCopy(null)
                void navigate({ to: SettingsBillingUrl })
              }}
            >
              Upgrade
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
