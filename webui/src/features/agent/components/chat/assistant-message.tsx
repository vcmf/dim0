import { ReasoningStepsView } from "./reasoning-steps"
import type { ChatMessage } from "../../types/chat"
import { ResponseActions } from "./actions/response-actions"
import { useMemo } from "react"
import { isReasoningTextStep, type ReasoningStep, type ReasoningTextStep } from "../../types/stream"
import { SourcesView } from "./sources-view"
import { DocSourcesView } from "./doc-sources-view"
import { extractDocSources } from "../../utils/doc-sources"
import { NoteSourcesView } from "./note-sources-view"
import { extractNoteSources } from "../../utils/note-sources"


const EMPTY_STEPS: ReasoningStep[] = []


/**
 * Renders the assistant message as a single merged process view.
 */
export const AssistantMessage = ({
  message,
}: {
  message: ChatMessage
}) => {
  const steps: ReasoningStep[] = message.properties.reasoning?.reasoning ?? EMPTY_STEPS
  const resp = { steps, sentAt: message.sentAt, isDeepResearch: message.isDeepResearch }

  const responseMarkdown = useMemo(
    () => steps.filter(isReasoningTextStep).map((step: ReasoningTextStep) => step.message).join(""),
    [steps]
  )

  // Documents cited this turn — used to linkify their titles inline in the answer
  // (their exact-title occurrences become links to the Sources card below).
  const docSources = useMemo(() => extractDocSources({ steps }), [steps])
  // Board notes the agent surfaced this turn (search_notes / get_note) — rendered
  // as a Notes card whose entries jump to the node on the board.
  const noteSources = useMemo(() => extractNoteSources({ steps }), [steps])

  return (
    <div className='w-full space-y-2'>
      <ReasoningStepsView
        response={resp}
        isStreaming={message.streaming || false}
        docSources={docSources}
        messageId={message.id}
      />
      {!message.streaming && <SourcesView answer={resp} />}
      {!message.streaming && <DocSourcesView sources={docSources} messageId={message.id} />}
      {!message.streaming && <NoteSourcesView sources={noteSources} />}
      {!message.streaming && responseMarkdown && (
        <ResponseActions
          message={responseMarkdown}
        />
      )}
    </div>
  )
}
