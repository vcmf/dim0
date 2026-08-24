import { useCallback } from "react"
import { useNavigate } from "@tanstack/react-router"
import { generateUuid } from "@/lib/common"
import { getCanvasStoreRef } from "@/features/board/harness/canvas-store-ref"
import { arrangeCreatedNodes } from "@/features/board/harness/agent/arrange-created-nodes"
import { getSearchIndexRef } from "@/features/board/search/search-index-ref"
import { runAgent } from "@/features/agent/engine/agent-loop"
import { linkNotes, writeNote } from "@/features/agent/engine/tools"
import { StoreMutator } from "@/features/agent/engine/board-mutator"
import { resolveAgentLlm } from "@/features/agent/engine/services/local-llm"
import type { AgentEvent } from "@/features/agent/engine/types"
import { useByokStore } from "@/features/agent/byok/byok-store"
import { useChatStore } from "@/features/agent/store/chat-store"
import { byokModelForId } from "@/features/agent/types/model-catalog"
import { useBoardAppStore } from "@/features/board/harness/store/board-app-store"
import { useIsSignedIn } from "@/lib/auth"
import { transformSystemPrompt, type MindmapTransformKind } from "./transforms"


/** Kinds a local transform can run: a verbatim note, or an agent-built mindmap. */
export type LocalTransformKind = "notify" | MindmapTransformKind


export type LocalTransformResult = { ok: boolean; createdIds: string[] }


/**
 * Local (in-browser) analog of the backend `/tools/mindmaps:*` transforms.
 *
 * `notify` writes the source text as one note verbatim (no LLM). The mindmap
 * kinds run the local agent with a per-kind system prompt so it builds notes +
 * links on the live canvas, then arrange + recenter — reusing the exact submit
 * machinery so results match the normal agent path. Returns the created node ids.
 */
export function useLocalTransform() {
  const asConfig = useByokStore((s) => s.asConfig)
  const llmModel = useChatStore((s) => s.llmModel)
  const llmCatalog = useChatStore((s) => s.llmCatalog)
  const signedIn = useIsSignedIn()
  const navigate = useNavigate()

  return useCallback(
    async (kind: LocalTransformKind, sourceText: string): Promise<LocalTransformResult> => {
      const store = getCanvasStoreRef()
      if (!store || !sourceText.trim()) return { ok: false, createdIds: [] }
      const rootId = useBoardAppStore.getState().rootId
      const search = getSearchIndexRef() ?? undefined
      const ctx = { store, rootId, search, board: new StoreMutator(store, rootId) }

      const recenter = (ids: string[]): void => {
        if (ids.length === 0) return
        void navigate({
          to: ".",
          replace: true,
          search: (prev: Record<string, unknown>) => ({ ...prev, center: ids.join(",") }),
        })
      }

      // notify: save the text as one note, verbatim — no model call.
      if (kind === "notify") {
        const res = (await writeNote.run({ content: sourceText, note_type: "sheet" }, ctx)) as {
          id?: string
        }
        const ids = res.id ? [res.id] : []
        recenter(ids)
        return { ok: ids.length > 0, createdIds: ids }
      }

      const config = asConfig()
      const runId = generateUuid()
      const byokModel =
        config && llmModel && llmModel !== "auto"
          ? byokModelForId(llmCatalog, llmModel, config.provider)
          : undefined
      const llm = resolveAgentLlm(config, { signedIn, runId, model: llmModel, byokModel })
      if (!llm) return { ok: false, createdIds: [] }

      const createdIds: string[] = []
      const events: AgentEvent[] = []
      for await (const ev of runAgent({
        system: transformSystemPrompt(kind),
        userMessage: sourceText,
        // Build-only: create + connect notes. Deliberately no edit_note/get_note
        // so a transform can't mutate the user's existing notes as a side effect.
        tools: [writeNote, linkNotes],
        llm,
        ctx,
      })) {
        // The build-only transform inspects tool_result and never renders text;
        // don't accumulate the cumulative reasoning token stream (pure bloat here).
        if (ev.type === "reasoning") continue
        events.push(ev)
        if (
          ev.type === "tool_result" &&
          (ev.toolName === "write_note" || ev.toolName === "create_note") &&
          ev.result && typeof ev.result === "object" && "id" in ev.result &&
          (ev.result as { created?: unknown }).created === true
        ) {
          createdIds.push(String((ev.result as { id: unknown }).id))
        }
      }

      await arrangeCreatedNodes(store, createdIds)
      recenter(createdIds)
      return { ok: createdIds.length > 0, createdIds }
    },
    [asConfig, llmModel, llmCatalog, signedIn, navigate],
  )
}
