import type { CanvasStore } from "@canvas-harness/core"
import { modelSupportsVision, type PublicModel } from "@/features/agent/types/model-catalog"
import { isVisionBoardContextEnabled } from "./vision-context-flag"


/**
 * Whether to attach a board-viewport screenshot to this turn.
 *
 * Cheap pre-check on the submit path: the flag is on, the resolved model accepts
 * images, and the board has something to show. The capture itself is
 * viewport-scoped and resolves null on failure, so this stays a coarse gate; a
 * finer heuristic (visual-node-only / message intent / first turn) is a
 * documented follow-up.
 */
export const shouldAttachBoardImage = (
  store: CanvasStore,
  llmCatalog: PublicModel[],
  llmModel: string,
): boolean =>
  isVisionBoardContextEnabled() &&
  modelSupportsVision(llmCatalog, llmModel) &&
  store.getAllNodes().length > 0
