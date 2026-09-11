// Allowlists shared by the transformer (author-time validation) and the Phase-2
// renderer. Phase 1 declares the NAMES; Phase 2 will attach the React component
// implementations and per-component prop schemas (applet-design.md §7).

export const COMPONENTS = new Set([
  "Card",
  "CardHeader",
  "CardTitle",
  "CardContent",
  "CardFooter",
  "Button",
  "Chart",
  "Graph",
  "Map",
  "Table",
])


export const INTRINSICS = new Set([
  "div", "span", "p", "ul", "ol", "li",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tr", "th", "td",
  "b", "i", "em", "strong", "small", "code", "pre", "kbd", "br", "hr",
  "img", "input", "textarea", "select", "option", "label", "button",
])


export const EVENT_HANDLERS = new Set([
  "onClick",
  "onChange",
  "onInput",
  "onKeyDown",
  "onKeyUp",
  "onSubmit",
  "onBlur",
  "onFocus",
])


export const ACTION_VERBS = new Set(["set", "toggle", "append", "toast", "batch"])


// Rejected on any element regardless of its allowlist.
export const FORBIDDEN_ATTRS = new Set(["style", "dangerouslySetInnerHTML"])


export function isKnownTag(tag: string): boolean {
  return COMPONENTS.has(tag) || INTRINSICS.has(tag)
}
