import { useState } from "react"
import { toast } from "sonner"
import { useCanvasStore } from "@canvas-harness/react"
import {
  CancelStatusIcon,
  CheckCircleStatusIcon,
  LoaderRefreshIcon,
} from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { isNodeTypeAtLimit, nodeLimitFor } from "@/features/board/lib/board-limit"
import { useAppStore } from "@/store"
import { useHarnessParseDocument } from "../canvas/use-parse-document"
import { useBoardAppStore } from "../store/board-app-store"


export type DocumentUploadDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}


const LoadingIcon = () => (
  <LoaderRefreshIcon className="size-4 animate-spin [animation-duration:750ms]" />
)


const SuccessIcon = () => <CheckCircleStatusIcon className="size-4 text-foreground" />


const ErrorIcon = () => <CancelStatusIcon className="size-4 text-destructive" />


/**
 * Lazy body — graph subscriptions only spin up while the dialog is
 * open. Closes immediately on submit and surfaces parse progress via
 * toasts (same UX as prod) so a long PDF parse doesn't pin the modal.
 */
const DocumentUploadDialogBody = ({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void
}) => {
  const store = useCanvasStore()
  const boardId = useBoardAppStore((s) => s.boardId)
  const rootId = useBoardAppStore((s) => s.rootId)
  const parseDocument = useHarnessParseDocument(store, boardId, rootId)
  const userPlan = useAppStore((s) => s.userPlan)

  const [file, setFile] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!file || !boardId || submitting) return

    const documentCount = store.getAllNodes().filter((n) => n.type === "document").length
    if (isNodeTypeAtLimit("document", userPlan, documentCount)) {
      toast.error(
        `You've reached this board's document limit (${nodeLimitFor("document", userPlan)}). ` +
        `Upgrade for more.`,
      )
      return
    }

    setSubmitting(true)
    const startedAt = Date.now()
    const formatElapsed = () =>
      `${Math.max(0, Math.floor((Date.now() - startedAt) / 1000))}s`
    const id = toast(`Parsing & Analyzing document… ${formatElapsed()}`, {
      icon: <LoadingIcon />,
      duration: Infinity,
    })
    const timer = window.setInterval(() => {
      toast(`Parsing & Analyzing document… ${formatElapsed()}`, {
        id,
        icon: <LoadingIcon />,
        duration: Infinity,
      })
    }, 1000)
    onOpenChange(false)

    try {
      await parseDocument(file)
      window.clearInterval(timer)
      toast.dismiss(id)
      toast.success(`Document parsed. (${formatElapsed()})`, {
        icon: <SuccessIcon />,
        duration: 3000,
      })
      setFile(null)
    } catch (err) {
      console.error("[harness] document parse failed", err)
      window.clearInterval(timer)
      toast.dismiss(id)
      toast.error(`Failed to parse document. (${formatElapsed()})`, {
        icon: <ErrorIcon />,
        duration: 4000,
      })
    } finally {
      window.clearInterval(timer)
      setSubmitting(false)
    }
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <div className="space-y-2">
        <Input
          type="file"
          accept="application/pdf"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <p className="text-xs text-muted-foreground">PDF files only.</p>
        <p className="text-xs text-muted-foreground">
          Document must stay within both limits: 30 pages max and 5 MB max.
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => onOpenChange(false)}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={!file || !boardId || submitting}>
          {submitting ? "Parsing…" : "Upload & Parse"}
        </Button>
      </div>
    </form>
  )
}


/**
 * Harness port of prod's DocumentUploadDialog. Routes the parsed
 * Notes + Links through `useHarnessParseDocument` so they land on
 * the canvas-harness store (the server has already persisted them).
 */
export const DocumentUploadDialog = ({
  open,
  onOpenChange,
}: DocumentUploadDialogProps) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Upload a document</DialogTitle>
      </DialogHeader>
      {open && <DocumentUploadDialogBody onOpenChange={onOpenChange} />}
    </DialogContent>
  </Dialog>
)
