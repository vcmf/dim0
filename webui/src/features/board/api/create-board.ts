import { useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/api"
import { useAppStore } from "@/store"
import { useBoardAppStore } from "../harness/store/board-app-store"
import { listBoards, type BoardListItem } from "./list-boards"
import { boardLimitForPlan, isBoardCreationLimited } from "../lib/board-limit"
import { toast } from "sonner"


/**
 * Create a new board for the user.
 */
export async function createBoard(): Promise<string> {
  const res = await apiFetch<{ data: { graph_id: string } }>({
    path: "/boards",
    method: "PUT"
  })
  return res.data.graph_id
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

      if (isBoardCreationLimited(userPlan, boards.length)) {
        toast.error(`You've reached your plan's board limit (${boardLimitForPlan(userPlan)}). Upgrade for more.`)
        throw new Error("board_limit_reached")
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
