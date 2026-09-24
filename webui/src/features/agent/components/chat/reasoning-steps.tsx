import { useMemo, useState } from "react"
import { ArrowRevealIcon, EllipsisIcon } from "@/components/icons"
import { isReasoningTextStep, isToolCallStep, type AgentResponse, type ReasoningTextStep, type ToolCallStep } from "../../types/stream"
import { ReasoningStepRow } from "./reasoning-step-row"
import { ToolStepRow } from "./tool-step-row"
import { buildToolStepWidgetAttachments, type ToolStepWidgetAttachment } from "./tool-step-widgets"
import type { DocSource } from "../../utils/doc-sources"


type TimelineItem =
  | {
    type: "reasoning"
    key: string
    step: ReasoningTextStep
  }
  | {
    type: "tool"
    key: string
    step: ToolCallStep
    index: number
  }
  | {
    type: "tool_block"
    key: string
    hidden: Array<{ step: ToolCallStep, index: number }>
    visible: { step: ToolCallStep, index: number }
  }


const EMPTY_STEPS: AgentResponse["steps"] = []


/**
 * Renders the collapsed header for a repeated same-tool block.
 */
const CollapsedToolBlockRow = ({
  isExpanded,
  onClick,
}: {
  isExpanded: boolean
  onClick: () => void
}) => {
  return (
    <button
      type='button'
      className='relative w-full p-2 flex flex-row items-start justify-start gap-2 text-muted-foreground'
      onClick={onClick}
      aria-label='Show repeated tool calls'
    >
      <div className='absolute w-[1px] h-full top-0 left-[0.98rem] bg-border' />
      <div className='relative flex-shrink-0'>
        <div className='relative z-20 mt-2 -ml-1 rounded-full bg-background w-6 h-6 flex items-center justify-center'>
          {isExpanded ? (
            <ArrowRevealIcon className='size-4' strokeWidth={2} />
          ) : (
            <EllipsisIcon className='size-4' strokeWidth={2} />
          )}
        </div>
      </div>
      <div className='relative flex-1 min-h-8' />
    </button>
  )
}


/**
 * Renders one consecutive same-tool block with a collapsible dots row.
 */
const ToolStepBlock = ({
  hidden,
  visible,
  isStreaming,
  widgetAttachments,
}: {
  hidden: Array<{ step: ToolCallStep, index: number }>
  visible: { step: ToolCallStep, index: number }
  isStreaming: boolean
  widgetAttachments: Map<number, ToolStepWidgetAttachment>
}) => {
  const [isExpanded, setIsExpanded] = useState(false)

  return (
    <>
      <CollapsedToolBlockRow
        isExpanded={isExpanded}
        onClick={() => setIsExpanded((value) => !value)}
      />
      {isExpanded && hidden.map(({ step, index }) => (
        <ToolStepRow
          key={step.id}
          step={step}
          isStreaming={isStreaming}
          attachment={widgetAttachments.get(index)}
        />
      ))}
      <ToolStepRow
        key={visible.step.id}
        step={visible.step}
        isStreaming={isStreaming}
        attachment={widgetAttachments.get(visible.index)}
      />
    </>
  )
}


export interface ReasoningStepsViewProps {
  isStreaming: boolean
  response?: AgentResponse
  estimatedDurationSeconds?: number
  /** Documents cited this turn — their titles are linkified in the answer text. */
  docSources?: DocSource[]
  /** The owning message id — namespaces the cited-document anchors. */
  messageId?: string
}


/**
 * Renders the assistant process as one ordered merged list.
 */
export const ReasoningStepsView = ({ isStreaming, response, docSources, messageId }: ReasoningStepsViewProps) => {
  const steps = response?.steps ?? EMPTY_STEPS

  const widgetAttachments = useMemo(
    () => buildToolStepWidgetAttachments(steps, isStreaming),
    [isStreaming, steps]
  )

  const timelineItems = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = []

    let index = 0
    while (index < steps.length) {
      const step = steps[index]

      if (isReasoningTextStep(step)) {
        items.push({
          type: "reasoning",
          key: step.id,
          step,
        })
        index += 1
        continue
      }

      const hidden: Array<{ step: ToolCallStep, index: number }> = []
      let end = index

      while (end + 1 < steps.length) {
        const nextStep = steps[end + 1]
        if (!isToolCallStep(nextStep) || nextStep.name !== step.name) {
          break
        }
        hidden.push({ step: steps[end] as ToolCallStep, index: end })
        end += 1
      }

      if (hidden.length > 0) {
        items.push({
          type: "tool_block",
          key: `${step.id}-block`,
          hidden,
          visible: {
            step: steps[end] as ToolCallStep,
            index: end,
          },
        })
      } else {
        items.push({
          type: "tool",
          key: step.id,
          step,
          index,
        })
      }

      index = end + 1
    }

    return items
  }, [steps])

  if (!response) {
    return null
  }

  return (
    <div className='w-full flex flex-col items-start'>
      {timelineItems.map((item, i) => (
        item.type === "reasoning" ? (
          <ReasoningStepRow
            key={item.key}
            step={item.step}
            isStreaming={isStreaming}
            // Only the trailing step can still be in progress; anything followed
            // by a later step (tool call / text) has finished.
            isActive={isStreaming && i === timelineItems.length - 1}
            docSources={docSources}
            messageId={messageId}
          />
        ) : item.type === "tool_block" ? (
          <ToolStepBlock
            key={item.key}
            hidden={item.hidden}
            visible={item.visible}
            isStreaming={isStreaming}
            widgetAttachments={widgetAttachments}
          />
        ) : (
          <ToolStepRow
            key={item.key}
            step={item.step}
            isStreaming={isStreaming}
            attachment={widgetAttachments.get(item.index)}
          />
        )
      ))}
    </div>
  )
}
