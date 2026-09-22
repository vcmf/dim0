import { useNavigate } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { SettingsBillingUrl } from "@/routes"


type BoardLimitDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The current plan's synced-board cap, shown in the copy. */
  planLimit: number
  /** Drop down to an unlimited on-device board instead of upgrading. */
  onCreateLocal: () => void
}


/**
 * Shown when a signed-in user hits their plan's synced-board cap while creating a
 * board. Offers the two sanctioned paths — upgrade for more synced boards, or
 * create an unlimited local-only board — so the wall is a choice, never a dead end.
 */
export function BoardLimitDialog({ open, onOpenChange, planLimit, onCreateLocal }: BoardLimitDialogProps) {
  const navigate = useNavigate()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>You've reached your plan's board limit</DialogTitle>
          <DialogDescription className="text-sm leading-6 text-foreground/80">
            Your plan includes {planLimit} synced boards, backed up and shareable across your
            devices. Upgrade for unlimited synced boards, or create a local-only board that stays
            on this device.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-3">
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false)
              onCreateLocal()
            }}
          >
            Create a local-only board
          </Button>
          <Button
            onClick={() => {
              onOpenChange(false)
              void navigate({ to: SettingsBillingUrl })
            }}
          >
            Upgrade
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
