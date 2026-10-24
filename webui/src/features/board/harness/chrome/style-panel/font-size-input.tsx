import { getFontSizePx, MAX_FONT_SIZE_PX, MIN_FONT_SIZE_PX } from "@canvas-harness/core"
import { useEffect, useState } from "react"
import { Input } from "@/components/ui/input"
import type { FontSize } from "@/features/board/types/style"
import { normalizeFontSizeInput } from "./font-size"


/** Edit an explicit font size locally, committing only on blur or Enter. */
export function FontSizeInput({
  fontSize,
  onCommit,
}: {
  fontSize?: FontSize
  onCommit: (fontSize: number) => void
}) {
  const resolved = Math.round(getFontSizePx(fontSize ?? "M"))
  const [draft, setDraft] = useState(String(resolved))

  useEffect(() => setDraft(String(resolved)), [resolved])

  const commit = () => {
    const next = normalizeFontSizeInput(draft)
    if (next === null) {
      setDraft(String(resolved))
      return
    }
    setDraft(String(next))
    if (next !== resolved) onCommit(next)
  }

  return (
    <div className="flex items-center gap-1">
      <Input
        type="number"
        min={MIN_FONT_SIZE_PX}
        max={MAX_FONT_SIZE_PX}
        step={1}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            commit()
          }
        }}
        aria-label="Custom font size in pixels"
        className="h-9 w-20"
      />
      <span className="text-xs text-muted-foreground">px</span>
    </div>
  )
}
