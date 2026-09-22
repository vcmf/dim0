import { useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/api"
import { useAppStore } from "@/store"
import { useBoardAppStore } from "../harness/store/board-app-store"
import { listBoards, type BoardListItem } from "./list-boards"
import { boardLimitForPlan, countOwnedBoards, isBoardCreationLimited } from "../lib/board-limit"
import { toast } from "sonner"


/**
 * Thrown (as an Error message) when board creation is blocked by the plan's
 * synced-board cap — either the client pre-check or the backend's atomic 402.
 * Callers switch on this to open the upgrade/local-board dialog.
 */
export const BOARD_LIMIT_REACHED = "board_limit_reached"


/**
 * Create a new board for the user. Normalizes the backend's atomic cap rejection
 * (HTTP 402) into the `BOARD_LIMIT_REACHED` sentinel so callers handle a stale
 * client count and a server-side cap hit the same way.
 */
export async function createBoard(): Promise<string> {
  try {
    const res = await apiFetch<{ data: { graph_id: string } }>({
      path: "/boards",
      method: "PUT"
    })
    return res.data.graph_id
  } catch (err) {
    // apiFetch throws `Error("402 Payment Required - ...")` for the synced-board cap.
    if (err instanceof Error && err.message.startsWith("402 ")) {
      throw new Error(BOARD_LIMIT_REACHED)
    }
    throw err
  }
}


/**
 * Custom hook to create a new board for the user.
 *
 * @returns An object containing the createBoard function and its mutation state.
 */
export const useCreateBoard = () => {
  const queryClient = useQueryClient()
  const userId = useAppStore(s => s.userId)
  const userPlan = useAppStore(s => s.userPlan)

  const setBoardScope = useBoardAppStore((s) => s.setBoardScope)

  const mutation = useMutation({
    mutationFn: async () => {
      const cachedBoards = queryClient.getQueryData<BoardListItem[]>(["listBoards", userId])
      const boards = cachedBoards ?? await listBoards()

      // Fast-fail before the network call. Counts OWNED boards only (shared-with-me
      // don't count — mirrors the backend synced-board cap + useIsBoardCreationLimited).
      // Keep the toast here: this mutation has several callers (dashboard card,
      // save-as-note, composer) that rely on it for feedback. The sidebar pre-gates
      // and shows its own dialog, so it reaches this branch only in a rare stale-count
      // race (toast + dialog both fire then, an accepted edge).
      if (isBoardCreationLimited(userPlan, countOwnedBoards(boards))) {
        toast.error(`You've reached your plan's board limit (${boardLimitForPlan(userPlan)}). Upgrade for more.`)
        throw new Error(BOARD_LIMIT_REACHED)
      }

      const boardId = await createBoard()
      // Optimistic insert MUST carry `role: "owner"` — the sidebar
      // splits on this field to bucket into "My boards" vs "Shared
      // with me". Without it, a freshly-created board appears under
      // "Shared with me" until the next listBoards refetch.
      queryClient.setQueryData<BoardListItem[]>(
        ["listBoards", userId],
        (oldBoards) => {
          const newBoard: BoardListItem = {
            uid: boardId,
            type: "graph",
            readonly: false,
            visibility: "private",
            createdAt: new Date().toISOString(),
            role: "owner",
          }
          return [newBoard, ...(oldBoards ?? [])]
        },
      )
      // Pre-set the harness scope so subsequent navigation onto /boards/:id
      // hydrates the new (empty) board without a flash.
      setBoardScope({ boardId, rootId: null })
      // Refetch in the background so the optimistic row reconciles
      // with the server's truth (label, createdAt, etc.) without
      // blocking the navigation above.
      queryClient.invalidateQueries({ queryKey: ["listBoards", userId] })
      return boardId
    }
  })

  return {
    createBoard: mutation.mutate,
    createBoardAsync: mutation.mutateAsync,
    ...mutation
  }
}
