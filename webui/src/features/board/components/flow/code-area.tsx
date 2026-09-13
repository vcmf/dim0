import { useCallback, useEffect, useRef } from "react"
import { useTheme } from "@/components/theme-provider"
import { highlightCodeSync, ensureLanguage, type LangValue } from "@/lib/shiki"
import { cn } from "@/lib/utils"


// Any language Shiki knows about. `highlightCodeSync`/`ensureLanguage`
// already guard unknown values back to plaintext, so this is a thin alias.
export type CodeAreaLanguage = LangValue


type CodeAreaProps = {
  value: string
  onChange: (value: string) => void
  language?: CodeAreaLanguage
  placeholder?: string
  /**
   * When true the textarea is non-editable: keystroke handlers no-op and
   * `onChange` never fires. The Shiki backdrop still paints, so the code stays
   * highlighted and scrollable — an inspect-only source view.
   */
  readOnly?: boolean
}


const TAB = "  "


const getLineIndentation = (text: string) => {
  const match = text.match(/^[\t ]*/)
  return match?.[0] ?? ""
}


/**
 * Lightweight code editor: transparent textarea over a Shiki-highlighted
 * backdrop. Syntax colors track the active theme pair via `useTheme()`,
 * so the editor adapts to every app theme + light/dark mode instead of
 * being locked to a single palette. Indentation helpers preserve current
 * line indent on Enter and insert spaces on Tab.
 */
export function CodeArea({
  value,
  onChange,
  language = "python",
  placeholder = "Write code here",
  readOnly = false,
}: CodeAreaProps) {
  const { shikiThemes } = useTheme()
  const highlightedLayerRef = useRef<HTMLDivElement | null>(null)

  // Paint the Shiki backdrop. Sync path is zero-latency when language +
  // theme pair are already loaded — keystrokes never flash to plain text.
  // First-load (or first-time-this-theme) falls back to plain text and
  // upgrades once the async grammar/theme load resolves.
  useEffect(() => {
    const layer = highlightedLayerRef.current
    if (!layer) return
    const html = highlightCodeSync(value, language, shikiThemes)
    if (html != null) {
      layer.innerHTML = html
      return
    }
    layer.textContent = value
    let cancelled = false
    ensureLanguage(language, shikiThemes, () => {
      if (cancelled) return
      const ready = highlightCodeSync(value, language, shikiThemes)
      if (ready != null && highlightedLayerRef.current) {
        highlightedLayerRef.current.innerHTML = ready
      }
    })
    return () => { cancelled = true }
  }, [value, language, shikiThemes])

  /**
   * Insert indentation and preserve current line indentation for new lines.
   */
  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (readOnly) return
    const textarea = event.currentTarget
    const start = textarea.selectionStart ?? 0
    const end = textarea.selectionEnd ?? start

    if (event.key === "Tab") {
      event.preventDefault()
      event.stopPropagation()
      textarea.setRangeText(TAB, start, end, "end")
      const nativeEvent = new Event("input", { bubbles: true })
      textarea.dispatchEvent(nativeEvent)
      return
    }

    if (event.key !== "Enter") return

    event.preventDefault()
    event.stopPropagation()

    const beforeCursor = textarea.value.slice(0, start)
    const currentLine = beforeCursor.slice(beforeCursor.lastIndexOf("\n") + 1)
    const indentation = getLineIndentation(currentLine)
    const trimmedLine = currentLine.trimEnd()
    const extraIndent = language === "python"
      ? (trimmedLine.endsWith(":") ? TAB : "")
      : language === "javascript" || language === "typescript"
        ? (trimmedLine.endsWith("{") ? TAB : "")
        : ""

    textarea.setRangeText(`\n${indentation}${extraIndent}`, start, end, "end")
    const nativeEvent = new Event("input", { bubbles: true })
    textarea.dispatchEvent(nativeEvent)
  }, [language, readOnly])

  /**
   * Keep the highlighted backdrop aligned with the textarea viewport.
   */
  const handleScroll = useCallback((event: React.UIEvent<HTMLTextAreaElement>) => {
    if (!highlightedLayerRef.current) return
    highlightedLayerRef.current.scrollTop = event.currentTarget.scrollTop
    highlightedLayerRef.current.scrollLeft = event.currentTarget.scrollLeft
  }, [])

  return (
    <div
      className="relative h-full text-foreground"
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        ref={highlightedLayerRef}
        aria-hidden="true"
        className={cn(
          "absolute inset-0 overflow-auto scrollbar-thin pointer-events-none font-mono text-sm leading-6",
          // Shiki emits its own <pre>; flatten its chrome so it overlays
          // the textarea pixel-perfect (same font/padding/wrapping).
          "[&>pre]:m-0 [&>pre]:p-4 [&>pre]:font-mono [&>pre]:text-sm [&>pre]:leading-6",
          "[&>pre]:whitespace-pre-wrap [&>pre]:break-words",
        )}
      />
      <textarea
        value={value}
        onChange={readOnly ? undefined : (event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onScroll={handleScroll}
        readOnly={readOnly}
        spellCheck={false}
        className={cn(
          "absolute inset-0 w-full h-full resize-none border-0 bg-transparent p-4 outline-none scrollbar-thin font-mono text-sm leading-6 text-transparent caret-foreground selection:bg-primary/20",
          readOnly && "cursor-default",
        )}
        placeholder={placeholder}
      />
    </div>
  )
}
