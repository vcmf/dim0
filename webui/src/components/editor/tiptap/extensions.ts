import StarterKit from "@tiptap/starter-kit"
import Placeholder from "@tiptap/extension-placeholder"
import CharacterCount from "@tiptap/extension-character-count"
import TaskList from "@tiptap/extension-task-list"
import TaskItem from "@tiptap/extension-task-item"
import Link from "@tiptap/extension-link"
import Typography from "@tiptap/extension-typography"
import { Markdown } from "tiptap-markdown"
import { Extension } from "@tiptap/core"
import { Blockquote } from "@tiptap/extension-blockquote"
import Suggestion from "@tiptap/suggestion"
import { keymap } from "@tiptap/pm/keymap"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { sinkListItem, liftListItem } from "@tiptap/pm/schema-list"
import type { EditorState } from "@tiptap/pm/state"
import type { Node as PMNode } from "@tiptap/pm/model"
import { HighlightMarkdown } from "./highlight/highlight-extension"
import { DetailsMarkdown, DetailsSummaryMarkdown, DetailsContentMarkdown } from "./toggle/toggle-extensions"
import { TableKit } from "@tiptap/extension-table"
import { ShikiCodeBlock } from "./code-block/code-block-extension"
import { InlineMathMarkdown, BlockMathMarkdown } from "./math/math-extensions"
import { openMathEditor } from "./math/math-edit-trigger"
import { ImageWithDrop } from "./image/image-extension"
import { TocBlock } from "./toc/toc-block-extension"
import { PageProviderExtension } from "./page/page-extension"
import { PageRef } from "./page/page-ref-extension"
import { PageMention } from "./page/page-mention-extension"
import { Subpage } from "./page/subpage-extension"
import type { PageProvider } from "./page/types"
import { TagDecoration } from "./tag/tag-decoration"
import { slashSuggestion } from "./slash-command/suggestion"
import "katex/dist/katex.min.css"

const slashSuggestionKey = new PluginKey("slashSuggestion")


const SlashCommand = Extension.create({
  name: "slashCommand",
  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: slashSuggestionKey,
        ...slashSuggestion,
      }),
    ]
  },
})

const CODE_INDENT = "  "
const BRACE_INDENT_LANGS = new Set([
  "typescript", "javascript", "tsx", "jsx",
  "java", "c", "cpp", "csharp", "rust", "go",
  "css", "scss", "json",
])
const COLON_INDENT_LANGS = new Set(["python", "yaml"])


/** Find the codeBlock node containing the selection's $from, or null. */
function findCodeBlockAncestor(state: EditorState): PMNode | null {
  const { $from } = state.selection
  for (let d = $from.depth; d >= 0; d--) {
    const n = $from.node(d)
    if (n.type.name === "codeBlock") return n
  }
  return null
}


/** True when $from is inside a listItem or taskItem. */
function isInsideListItem(state: EditorState): boolean {
  const { $from } = state.selection
  for (let d = $from.depth; d >= 0; d--) {
    const name = $from.node(d).type.name
    if (name === "listItem" || name === "taskItem") return true
  }
  return false
}


/** Blockquote without the `> ` input rule — that prefix now triggers the
 * toggle. Blockquotes are still reachable via the slash command. */
const BlockquoteNoShortcut = Blockquote.extend({
  addInputRules() {
    return []
  },
})


/**
 * Trap Tab inside the editor and add smart indentation inside code blocks
 * (Tab inserts 2 spaces; Enter preserves the current line's indent and adds
 * one extra level after `:` for Python/YAML or `{` for brace-style langs).
 */
const TabHandler = Extension.create({
  name: "tabHandler",
  addProseMirrorPlugins() {
    return [
      keymap({
        Tab: (state, dispatch) => {
          // Inside a code block: insert two spaces (consistent with the
          // canvas code-snippet editor and most modern toolchains).
          if (findCodeBlockAncestor(state)) {
            if (dispatch) dispatch(state.tr.insertText(CODE_INDENT))
            return true
          }

          // List items via prosemirror-schema-list commands
          const li = state.schema.nodes.listItem
          const ti = state.schema.nodes.taskItem
          if (li && sinkListItem(li)(state, dispatch)) return true
          if (ti && sinkListItem(ti)(state, dispatch)) return true

          return true // consume Tab — no focus escape
        },
        "Shift-Tab": (state, dispatch) => {
          const li = state.schema.nodes.listItem
          const ti = state.schema.nodes.taskItem
          if (li && liftListItem(li)(state, dispatch)) return true
          if (ti && liftListItem(ti)(state, dispatch)) return true
          return true
        },
        "Shift-Enter": (state, dispatch) => {
          // Inside a list item: split the current paragraph at the cursor so a
          // continuation paragraph lands in the same listItem (numbering stays
          // correct). Outside of lists, fall through to the default hardBreak.
          if (!isInsideListItem(state)) return false
          if (findCodeBlockAncestor(state)) return false // code blocks own \n
          if (dispatch) {
            const { $from } = state.selection
            dispatch(state.tr.split($from.pos).scrollIntoView())
          }
          return true
        },
        Enter: (state, dispatch) => {
          const codeBlock = findCodeBlockAncestor(state)
          if (!codeBlock) return false // let other handlers (lists, etc.) run

          const { $from } = state.selection
          const text = codeBlock.textContent
          const offset = $from.parentOffset
          const beforeCursor = text.slice(0, offset)
          const lineStart = beforeCursor.lastIndexOf("\n") + 1
          const currentLine = beforeCursor.slice(lineStart)

          const indentMatch = currentLine.match(/^[\t ]*/)
          const indent = indentMatch?.[0] ?? ""

          const lang = (codeBlock.attrs.language as string | null) ?? "plaintext"
          const trimmed = currentLine.trimEnd()
          const lastChar = trimmed.slice(-1)
          const extra =
            (BRACE_INDENT_LANGS.has(lang) && lastChar === "{") ||
            (COLON_INDENT_LANGS.has(lang) && lastChar === ":")
              ? CODE_INDENT
              : ""

          if (dispatch) {
            dispatch(state.tr.insertText(`\n${indent}${extra}`))
          }
          return true
        },
      }),
    ]
  },
})

/**
 * Keep clipboard shortcuts inside the editor. canvas-harness wires a
 * window-level Cmd/Ctrl+C/X/V listener that only skips <input>/<textarea>
 * (not contenteditable), so without this it hijacks copy/cut/paste while
 * you're typing in a TipTap surface. Stop the keydown from reaching that
 * window listener — but don't preventDefault, so the browser's native
 * clipboard and ProseMirror's own copy/paste handling still run.
 */
const ClipboardGuard = Extension.create({
  name: "clipboardGuard",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            keydown: (_view, event) => {
              if (!(event.metaKey || event.ctrlKey)) return false
              const key = event.key.toLowerCase()
              if (key === "c" || key === "x" || key === "v") {
                event.stopPropagation()
              }
              return false
            },
          },
        },
      }),
    ]
  },
})


export interface GetExtensionsOptions {
  placeholder?: string
  pageProvider?: PageProvider | null
  /** Id of the note the editor is currently editing — used by /subpage. */
  parentNoteId?: string | null
}


export function getExtensions(options: GetExtensionsOptions = {}) {
  const {
    placeholder = "Start writing…",
    pageProvider = null,
    parentNoteId = null,
  } = options
  return [
    StarterKit.configure({
      // Phase 1: undo/redo enabled. When adding Yjs: set undoRedo: false and add @tiptap/extension-collaboration
      codeBlock: false, // replaced by ShikiCodeBlock
      blockquote: false, // replaced by BlockquoteNoShortcut so `> ` triggers toggle
    }),
    BlockquoteNoShortcut,
    ShikiCodeBlock,
    InlineMathMarkdown.configure({
      onClick: (node, pos) =>
        openMathEditor({ pos, latex: node.attrs.latex ?? "", isInline: true }),
    }),
    BlockMathMarkdown.configure({
      onClick: (node, pos) =>
        openMathEditor({ pos, latex: node.attrs.latex ?? "", isInline: false }),
    }),
    ImageWithDrop,
    TocBlock,
    PageProviderExtension.configure({ provider: pageProvider, parentNoteId }),
    PageRef,
    PageMention,
    Subpage,
    HighlightMarkdown.configure({ multicolor: true }),
    DetailsMarkdown,
    DetailsSummaryMarkdown,
    DetailsContentMarkdown,
    TagDecoration,
    TableKit,
    Placeholder.configure({ placeholder }),
    CharacterCount,
    TaskList,
    TaskItem.configure({ nested: true }),
    Link.configure({
      openOnClick: false,
      HTMLAttributes: { class: "editor-link" },
      // Auto-link bare domains too — by default the Link extension's
      // `shouldAutoLink` requires a protocol prefix (`https://example.com`
      // autolinks, `example.com` doesn't). Users expect a typed
      // `wordpress.com ` to become a link without the scheme; linkifyjs's
      // tokenizer already screens out non-URL-looking strings (it checks
      // against the IANA TLD list under the hood), so widening to "trust
      // linkify's detection" produces the natural behavior. Bare matches
      // get the `https://` scheme via `defaultProtocol`.
      shouldAutoLink: () => true,
      defaultProtocol: "https",
    }),
    Typography,
    Markdown.configure({
      html: false,
      transformCopiedText: true,
      transformPastedText: true,
    }),
    SlashCommand,
    ClipboardGuard,
    TabHandler, // must be last — highest priority in TipTap's keymap chain
  ]
}
