import {
  FONT_FAMILY_MAP,
  getFontSizePx,
  getLineHeightPx,
  handleEnter,
  insertLink,
  toggleBold,
  toggleCode,
  toggleItalic,
  toggleStrike,
  toggleUnderline,
  type EditorAdapter,
  type EditorAdapterFactory,
} from "@canvas-harness/core"


/**
 * Custom in-place editor adapter for canvas-harness. Behaviour matches
 * the lib's `createDefaultTextareaEditor` (autosize, markdown shortcuts,
 * commit on Esc / Cmd+Enter / blur) with one tweak: when the node's
 * background is transparent (text nodes default to that), the editor
 * wrap uses `var(--card)` so the textarea has an opaque surface that
 * hides whatever's painted under it. Without this, the canvas-rendered
 * text bleeds through and is hard to read while typing.
 */


/** True for any hex / keyword that paints zero opacity. */
const isTransparent = (color: string | undefined): boolean => {
  if (!color) return true
  if (color === "transparent") return true
  if (color.length === 9 && color.startsWith("#") && color.slice(7, 9).toLowerCase() === "00") {
    return true
  }
  if (color.length === 5 && color.startsWith("#") && color[4] === "0") return true
  return false
}


export const createHarnessTextareaEditor: EditorAdapterFactory = ({
  node,
  container,
  camera,
  onCommit,
  onCancel,
}): EditorAdapter => {
  void onCancel
  const style = node.style ?? {}
  const fontSize = style.fontSize ?? "M"
  const fontFamily = style.fontFamily ?? "handwriting"
  const align = style.textAlign ?? "center"
  // Theme-aware foreground so dark mode doesn't render text in near-
  // invisible on the card surface.
  const color = style.textColor && !isTransparent(style.textColor)
    ? style.textColor
    : "var(--card-foreground)"

  const fontPx = getFontSizePx(fontSize)
  const lineHeightPx = getLineHeightPx(fontSize)

  const screenX = (node.x - camera.x) * camera.z
  const screenY = (node.y - camera.y) * camera.z
  const screenW = node.w * camera.z
  const screenH = node.h * camera.z

  const alignToFlex: Record<string, string> = {
    left: "flex-start",
    center: "center",
    right: "flex-end",
  }

  // Solid surface — use the node's bg when it has one, otherwise fall
  // back to `var(--card)`. The transparent fallback is the one that
  // matters in practice (text nodes), but routing all "no bg" nodes
  // through bg-card also helps shapes that ship with transparent fills.
  const wrapBg = isTransparent(style.backgroundColor)
    ? "var(--card)"
    : style.backgroundColor

  const wrap = document.createElement("div")
  wrap.style.position = "absolute"
  wrap.style.left = `${screenX}px`
  wrap.style.top = `${screenY}px`
  wrap.style.width = `${screenW}px`
  wrap.style.minHeight = `${screenH}px`
  wrap.style.display = "flex"
  wrap.style.flexDirection = "column"
  wrap.style.justifyContent = "center"
  wrap.style.alignItems = alignToFlex[align] ?? "center"
  wrap.style.boxSizing = "border-box"
  wrap.style.border = "1px solid var(--ring, #3b82f6)"
  wrap.style.borderRadius = "4px"
  wrap.style.background = wrapBg ?? "var(--card)"
  wrap.style.zIndex = "20"
  // EditorMount's host div is `pointer-events: none` so the canvas
  // behind still receives pan/select events while editing; the
  // editor adapter has to opt back in. Without this, mouse clicks
  // pass through and the caret can't be positioned by clicking —
  // only arrow keys work. Mirrors `createDefaultTextareaEditor` in
  // canvas-harness.
  wrap.style.pointerEvents = "auto"

  const ta = document.createElement("textarea")
  ta.value = node.content ?? ""
  ta.spellcheck = false
  ta.style.width = "100%"
  ta.style.padding = "6px"
  ta.style.margin = "0"
  ta.style.boxSizing = "border-box"
  ta.style.border = "none"
  ta.style.outline = "none"
  ta.style.resize = "none"
  ta.style.overflow = "hidden"
  ta.style.background = "transparent"
  ta.style.color = color
  ta.style.fontFamily = FONT_FAMILY_MAP[fontFamily]
  ta.style.fontSize = `${fontPx * camera.z}px`
  ta.style.lineHeight = `${lineHeightPx * camera.z}px`
  ta.style.textAlign = align
  ta.style.whiteSpace = "pre-wrap"
  ta.style.wordBreak = "break-word"

  const autosize = (): void => {
    // Collapse to 0 before measuring — a bare <textarea> defaults to
    // rows=2, so `height: auto` keeps a 2-row floor and `scrollHeight`
    // over-reports by a blank line for short content (which then sits
    // high in the vertically-centered wrap). Matches the lib's
    // createDefaultTextareaEditor.
    ta.style.height = "0px"
    ta.style.height = `${ta.scrollHeight}px`
  }

  const commitNow = (): void => onCommit(ta.value)

  const applyTransform = (t: { value: string; selStart: number; selEnd: number }): void => {
    ta.value = t.value
    ta.setSelectionRange(t.selStart, t.selEnd)
    autosize()
  }

  const onInput = (): void => autosize()
  const onBlur = (): void => commitNow()
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault()
      commitNow()
      return
    }
    const meta = e.metaKey || e.ctrlKey
    if (meta && e.key === "Enter") {
      e.preventDefault()
      commitNow()
      return
    }
    if (meta && !e.shiftKey && (e.key === "b" || e.key === "B")) {
      e.preventDefault()
      applyTransform(toggleBold(ta.value, ta.selectionStart, ta.selectionEnd))
      return
    }
    if (meta && !e.shiftKey && (e.key === "i" || e.key === "I")) {
      e.preventDefault()
      applyTransform(toggleItalic(ta.value, ta.selectionStart, ta.selectionEnd))
      return
    }
    if (meta && !e.shiftKey && (e.key === "u" || e.key === "U")) {
      e.preventDefault()
      applyTransform(toggleUnderline(ta.value, ta.selectionStart, ta.selectionEnd))
      return
    }
    if (meta && e.shiftKey && (e.key === "x" || e.key === "X")) {
      e.preventDefault()
      applyTransform(toggleStrike(ta.value, ta.selectionStart, ta.selectionEnd))
      return
    }
    if (meta && !e.shiftKey && (e.key === "e" || e.key === "E")) {
      e.preventDefault()
      applyTransform(toggleCode(ta.value, ta.selectionStart, ta.selectionEnd))
      return
    }
    if (meta && !e.shiftKey && (e.key === "k" || e.key === "K")) {
      e.preventDefault()
      const url = window.prompt("URL") ?? ""
      applyTransform(insertLink(ta.value, ta.selectionStart, ta.selectionEnd, url))
      return
    }
    if (e.key === "Enter" && !e.shiftKey && !meta) {
      const t = handleEnter(ta.value, ta.selectionStart, ta.selectionEnd)
      if (t) {
        e.preventDefault()
        applyTransform(t)
      }
    }
  }

  ta.addEventListener("input", onInput)
  ta.addEventListener("blur", onBlur)
  ta.addEventListener("keydown", onKeyDown)
  wrap.appendChild(ta)
  container.appendChild(wrap)
  requestAnimationFrame(() => {
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
    autosize()
  })

  return {
    focus: () => ta.focus(),
    getValue: () => ta.value,
    setValue: (text: string) => {
      ta.value = text
      autosize()
    },
    destroy: () => {
      ta.removeEventListener("input", onInput)
      ta.removeEventListener("blur", onBlur)
      ta.removeEventListener("keydown", onKeyDown)
      wrap.remove()
    },
  }
}
