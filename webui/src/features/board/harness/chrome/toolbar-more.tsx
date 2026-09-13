import { ChartLineIcon } from "@phosphor-icons/react"
import { useCanvasStore } from "@canvas-harness/react"

import {
  CodeFileIcon,
  DocumentFileIcon,
  EllipsisIcon,
  FolderPlusActionIcon,
  ImageStackIcon,
  PuzzlePieceIcon,
} from "@/components/icons"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { nodeLimitFor } from "@/features/board/lib/board-limit"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/store"
import { useLocalDocUpload, type LocalDocUpload } from "@/features/agent/local/use-local-doc-upload"
import { useNodeTypeCount } from "../canvas/use-node-type-count"
import { useBoardAppStore } from "../store/board-app-store"
import { DocumentUploadDialog } from "./document-upload-dialog"
import { IconSearchDialog } from "./icon-search-dialog"
import { ImageSearchDialog } from "./image-search-dialog"


// Always-present transparent border so the hover border doesn't shift the icon;
// the fill change alone is near-invisible against the tray (see toolbar.tsx).
const moreButtonClass =
  "transition-colors !p-2.5 rounded-lg flex items-center justify-center gap-2 border border-transparent text-card-foreground hover:bg-secondary hover:text-secondary-foreground hover:border-secondary-foreground/30"


/**
 * `{count}` or `{count}/{limit}` badge in a menu item's right slot. Shows the
 * denominator only when a limit applies (per-plan limits vanish in OSS mode);
 * turns destructive once the limit is reached.
 */
const NodeLimitBadge = ({ count, limit }: { count: number; limit: number | null }) => (
  <DropdownMenuShortcut
    className={cn("tabular-nums", limit !== null && count >= limit && "text-destructive")}
  >
    {limit == null ? count : `${count}/${limit}`}
  </DropdownMenuShortcut>
)


/**
 * Menu body — mounted only while the dropdown is open (Radix unmounts content
 * on close), so the per-type node counters subscribe to the store only then
 * and the always-mounted toolbar never re-renders on canvas changes.
 */
const MoreMenuItems = ({
  localUpload,
  upload,
}: {
  localUpload: boolean
  upload: LocalDocUpload
}) => {
  const store = useCanvasStore()
  const userPlan = useAppStore((s) => s.userPlan)
  const setTool = useBoardAppStore((s) => s.setTool)
  const setChromeDialog = useBoardAppStore((s) => s.setChromeDialog)

  const folderCount = useNodeTypeCount(store, "folder")
  const documentCount = useNodeTypeCount(store, "document")
  const codeSandboxCount = useNodeTypeCount(store, "code-sandbox")
  const appletCount = useNodeTypeCount(store, "applet")

  return (
    <>
      <DropdownMenuItem onSelect={() => setChromeDialog("icon-search")} className="gap-2 text-sm">
        <PuzzlePieceIcon className="size-4 shrink-0" />
        <span>Icons</span>
        <DropdownMenuShortcut>G</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => setChromeDialog("image-search")} className="gap-2 text-sm">
        <ImageStackIcon className="size-4 shrink-0" />
        <span>Images</span>
        <DropdownMenuShortcut>I</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => setTool("folder")} className="gap-2 text-sm">
        <FolderPlusActionIcon className="size-4 shrink-0" />
        <span>Sub-board</span>
        <NodeLimitBadge count={folderCount} limit={nodeLimitFor("folder", userPlan)} />
      </DropdownMenuItem>
      <DropdownMenuItem
        // Local boards use the offline pipeline (OCR → chunks → doc node); the
        // legacy server dialog is for synced/backend boards only. Grey out when
        // parsing is unavailable (no managed access and no BYOK Mistral key).
        onSelect={() => (localUpload ? upload.pick() : setChromeDialog("document-upload"))}
        disabled={localUpload && !upload.canParse}
        title={localUpload && !upload.canParse ? "Sign in or add a Mistral key to upload documents" : undefined}
        className="gap-2 text-sm"
      >
        <DocumentFileIcon className="size-4 shrink-0" />
        <span>Document</span>
        <NodeLimitBadge count={documentCount} limit={nodeLimitFor("document", userPlan)} />
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => setTool("code-sandbox")} className="gap-2 text-sm">
        <CodeFileIcon className="size-4 shrink-0" />
        <span>Code sandbox</span>
        <NodeLimitBadge count={codeSandboxCount} limit={nodeLimitFor("code-sandbox", userPlan)} />
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => setTool("applet")} className="gap-2 text-sm">
        <ChartLineIcon className="size-4 shrink-0" />
        <span>Applet</span>
        <NodeLimitBadge count={appletCount} limit={nodeLimitFor("applet", userPlan)} />
      </DropdownMenuItem>
    </>
  )
}


/**
 * Overflow menu mounted at the right edge of the harness toolbar.
 * Mirrors prod's `⋯` More dropdown: Icons / Images / Sub-board /
 * Document / Code sandbox / Applet. Sub-board / code-sandbox / applet
 * set `tool` so the next canvas click materializes the node; each create-able
 * type shows its per-board `{count}/{limit}` counter.
 */
export function HarnessToolbarMore({ local = false }: { local?: boolean } = {}) {
  const chromeDialog = useBoardAppStore((s) => s.chromeDialog)
  const setChromeDialog = useBoardAppStore((s) => s.setChromeDialog)
  const boardId = useBoardAppStore((s) => s.boardId) ?? ""

  // Local boards upload documents through the offline pipeline (same hook as the
  // chat attach button); synced boards keep the legacy server dialog.
  const upload = useLocalDocUpload(boardId)
  const localUpload = local && !!boardId

  const openImageSearch = chromeDialog === "image-search"
  const openIconSearch = chromeDialog === "icon-search"
  const openDocumentUpload = chromeDialog === "document-upload"

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="More actions"
                className={cn(moreButtonClass)}
              >
                <EllipsisIcon className="size-4 shrink-0" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={10}>More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="end"
          side="bottom"
          sideOffset={8}
          className="min-w-[190px]"
        >
          <MoreMenuItems localUpload={localUpload} upload={upload} />
        </DropdownMenuContent>
      </DropdownMenu>

      {localUpload && upload.elements}

      <ImageSearchDialog
        open={openImageSearch}
        onOpenChange={(open) => setChromeDialog(open ? "image-search" : null)}
      />
      <IconSearchDialog
        open={openIconSearch}
        onOpenChange={(open) => setChromeDialog(open ? "icon-search" : null)}
      />
      <DocumentUploadDialog
        open={openDocumentUpload}
        onOpenChange={(open) => setChromeDialog(open ? "document-upload" : null)}
      />
    </>
  )
}
