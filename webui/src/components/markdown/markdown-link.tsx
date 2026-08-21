import React from "react"
import { useNavigate } from "@tanstack/react-router"
import { LinkIcon } from "@/components/icons"
import { cn } from "@/lib/utils"
import { PageRefChip } from "./page-ref-chip"

const boardLinkRe = /^\/boards\/([^/]+)\/([^/]+)\/([^/]+)$/
const PAGE_HREF_PREFIX = "page://"
const DOC_HREF_PREFIX = "#doc-"

// Schemes we allow on a rendered <a href>. Everything else (javascript:,
// data:, vbscript:, blob:, file:, …) is treated as unsafe and neutralized.
// page:// and #doc- are handled by dedicated branches before this gate.
// Kept in sync with sanitize-schema's href protocols. tel/sms are legitimate
// contact links; xmpp/irc(s) are in the sanitizer's default href allowlist.
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:", "sms:", "xmpp:", "irc:", "ircs:"])

/**
 * Decide whether a markdown href is safe to assign to an anchor.
 * Schemeless hrefs — relative paths, `#hash`, `?query`, and
 * protocol-relative `//host` — inherit the current origin and are safe.
 * A href with an explicit scheme is safe only when that scheme is in the
 * allowlist. Robust to obfuscation: leading/trailing whitespace, control
 * chars, mixed case, and whitespace embedded in the scheme (browsers strip
 * tabs/newlines, so "java\tscript:" resolves to javascript:).
 */
const isSafeHref = (href: string): boolean => {
  // eslint-disable-next-line no-control-regex -- deliberately strips control/whitespace chars a browser ignores inside a scheme (defeats "java\tscript:" obfuscation)
  const cleaned = href.replace(/[\u0000-\u0020\u007f-\u009f]/g, "")
  const scheme = cleaned.match(/^([a-z][a-z0-9+.-]*):/i)
  if (!scheme) return true
  return SAFE_SCHEMES.has(`${scheme[1].toLowerCase()}:`)
}

type MarkdownLinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  children?: React.ReactNode
}

/**
 * Pull a usable string title out of the children React node tree.
 * Markdown links can wrap their text in formatting (em, strong); we
 * just want the visible label for the page-ref chip.
 */
const textOf = (node: React.ReactNode): string => {
  if (typeof node === "string") return node
  if (typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (React.isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode }
    return textOf(props.children)
  }
  return ""
}

/**
 * Markdown link renderer that routes internal board URLs through the router.
 * `page://<id>` URLs render as a PageRefChip (TipTap interop — see
 * `editor/tiptap/page/page-ref-extension.ts`). External links keep
 * default browser behavior.
 */
export function MarkdownLink({ children, href, ...rest }: MarkdownLinkProps) {
  const navigate = useNavigate()

  // Page-ref short-circuit: don't render an <a> at all. The chip
  // carries the title from the markdown's link text and behaves as a
  // self-contained inline element. v1 has no click target — adding
  // navigate() requires a host PageProvider that knows where pages live.
  if (href?.startsWith(PAGE_HREF_PREFIX)) {
    const title = textOf(children).trim() || "Untitled"
    return <PageRefChip title={title} />
  }

  // Document citation (`#doc-<docId>`, injected by linkifyDocTitles): render the
  // title as an inline PROSE link (keep the label — the default internal-link
  // branch below would replace it with a bare icon), and scroll to the matching
  // Sources card, opening it if collapsed. Kept in-page (no URL hash churn).
  if (href?.startsWith(DOC_HREF_PREFIX)) {
    const onDocClick = (event: React.MouseEvent<HTMLAnchorElement>): void => {
      event.preventDefault()
      const el = document.getElementById(href.slice(1)) // "#doc-x" → "doc-x"
      if (!el) return
      if (el instanceof HTMLDetailsElement) el.open = true
      el.scrollIntoView({ behavior: "smooth", block: "start" })
    }
    return (
      <a
        href={href}
        onClick={onDocClick}
        className="font-medium text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
      >
        {children}
      </a>
    )
  }

  const content = Array.isArray(children) ? children[0] : children
  const label = typeof content === "string" ? content.replace(/^[[]|[\]]$/g, "") : "source"

  const onClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!href) return
    const match = href.match(boardLinkRe)
    if (!match) return

    event.preventDefault()
    const [, boardId, , targetId] = match
    navigate({
      to: "/boards/$id",
      params: { id: boardId },
      // `center` is the param useCenterFromUrl actually consumes (selects + centers
      // the node); `center_around` was a dead param with no reader.
      search: (prev: Record<string, unknown>) => ({ ...prev, center: targetId }),
    })
  }

  // Scheme allowlist gate (defense at the sink): only assign the href when
  // its scheme is safe, so javascript:/data:/vbscript:/… never reach the DOM.
  const safeHref = href && isSafeHref(href) ? href : undefined

  const isExternal = !!safeHref && /^(https?:)?\/\//.test(safeHref)
  const target = isExternal ? "_blank" : rest.target
  const rel = isExternal ? "noreferrer" : rest.rel

  const clName = cn(
    "transition-all inline-block leading-none align-text-bottom text-muted-foreground/70 hover:text-muted-foreground text-xs font-mono bg-card hover:bg-accent rounded-lg",
    isExternal ? "border border-border px-1 py-0.5" : "p-1",
  )

  return (
    <a
      href={safeHref}
      target={target}
      rel={rel}
      className={clName}
      onClick={onClick}
      {...rest}
    >
      {
        isExternal ? label :
        <LinkIcon className='size-3' strokeWidth={2} />
      }
    </a>
  )
}
