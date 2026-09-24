import { useMemo, useState } from "react"
import { ArrowCollapseIcon, ArrowExpandIcon } from "@/components/icons"
import type { ReasoningTextStep } from "../../types/stream"
import { ThinkingDots } from "@/components/animations/thinking-indicator"
import { MarkdownView } from "@/components/markdown/markdown-view"
import { cn } from "@/lib/utils"
import { linkifyDocTitles, type DocSource } from "../../utils/doc-sources"


/**
 * Renders one raw reasoning text step in the merged assistant timeline.
 * `isStreaming` is the whole message's flag; `isActive` marks this step as the
 * one still in progress — only it animates "Thinking", so a reasoning-only step
 * that a tool call has already followed settles to a static label mid-turn.
 * Required so no caller silently falls back to "every step animates".
 */
export const ReasoningStepRow = ({
  step,
  isStreaming,
  isActive,
  docSources,
  messageId,
}: {
  step: ReasoningTextStep
  isStreaming?: boolean
  isActive: boolean
  docSources?: DocSource[]
  messageId?: string
}) => {
  const [viewMore, setViewMore] = useState(false)
  const hasReasoningDetails = !isStreaming && step.reasoning !== ""
  const isSynthesis = step.isSynthesis === true

  // Once the answer is final, turn exact document-title mentions into links to
  // their Sources card. Skipped mid-stream (titles arrive partial; sources
  // aren't final yet), when the turn cited no documents, or with no message id
  // to namespace the anchor.
  const message = useMemo(
    () =>
      !isStreaming && messageId && docSources && docSources.length > 0
        ? linkifyDocTitles(step.message, docSources, messageId)
        : step.message,
    [isStreaming, messageId, docSources, step.message],
  )

  // An empty step renders nothing once it's no longer in progress — mid-turn
  // too, so a placeholder a tool call followed doesn't show a contentless "Thought".
  if (!isActive && step.message === "" && step.reasoning === "") {
    return null
  }

  const divClass = cn(
    "w-full py-1 px-2",
    isSynthesis && "rounded-xl md:p-4 p-2 shadow-sm border border-border/60 bg-card/70",
    !isStreaming && isSynthesis && "max-h-[70vh] overflow-y-auto pr-1 scrollbar-thin"
  )

  return (
    <div
      className={divClass}
    >
      {isSynthesis && (
        <div className='pb-2 text-center text-sm font-medium text-muted-foreground font-mono'>
          Synthesis
        </div>
      )}
      {hasReasoningDetails && (
        <div className='mt-2 mb-2'>
          <button
            className='inline-flex items-center gap-1 text-sm font-normal text-muted-foreground'
            onClick={() => setViewMore((value) => !value)}
          >
            <span>Reasoning</span>
            {viewMore ? (
              <ArrowCollapseIcon
                className='size-4'
                strokeWidth={2}
              />
            ) : (
              <ArrowExpandIcon
                className='size-4'
                strokeWidth={2}
              />
            )}
          </button>
          {viewMore && (
            <div className='mt-2 font-sans text-muted-foreground/80 rounded-lg border border-border p-2 bg-sidebar border-dashed [&_p]:!text-sm [&_li]:!text-sm italic'>
              <MarkdownView content={step.reasoning} />
            </div>
          )}
        </div>
      )}
      {step.message !== "" ? (
        <div
          className="font-sans text-base text-card-foreground"
        >
          <MarkdownView content={message} isStreaming={isStreaming} />
        </div>
      ) : isStreaming ? (
        // Only the in-progress step animates; a finished one settles to a static
        // label, and its hidden reasoning stays hidden until the turn ends (when
        // the "Reasoning" expander takes this slot).
        <span className='inline-flex items-center gap-1 font-mono text-sm font-medium text-muted-foreground'>
          {isActive ? "Thinking" : "Thought"}
          {isActive && <ThinkingDots />}
        </span>
      ) : null}
    </div>
  )
}
