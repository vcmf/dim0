// The inline applet renderer (applet-design.md §5). Compiles JSX source to the §6
// tree (memoized), then interprets it into a live React tree — no iframe, no eval.
// State is held in a ref (so batched events fold onto the latest committed state,
// not a stale render snapshot) and mirrored to React via a re-render bump; events
// run the bounded action interpreter, bindings are evaluated per render with a
// fresh budget. Failures degrade gracefully: a bad binding renders nothing, a
// thrown render is caught by the error boundary (§5.3, recoverable), and the whole
// widget is layout-contained (§5.2).

import { createElement, useCallback, useMemo, useReducer, useRef, type ReactNode } from "react"

import { toast } from "sonner"

import { cn } from "@/lib/utils"

import { compileApplet } from "../compile"
import { evalExpr, makeCtx, runHandler } from "../interpreter"
import type { Action, Env, Expr } from "../interpreter/types"
import type { AppletTree, ElNode, JsonValue, ListNode, Node } from "../tree"
import { COMPONENT_IMPLS } from "./components"
import { AppletErrorBoundary } from "./error-boundary"


// Cap on rendered list items: the interpreter bounds array *evaluation* but not
// DOM output, so a huge bound array (`data={{ rows: [...100k...] }}`) could freeze
// the tab. Render at most this many and show a "… N more" note.
const MAX_LIST_ITEMS = 1000


// Tree event name (lowercased by the transformer) → React handler prop.
const EVENT_PROP: Record<string, string> = {
  click: "onClick",
  change: "onChange",
  input: "onInput",
  keydown: "onKeyDown",
  keyup: "onKeyUp",
  submit: "onSubmit",
  blur: "onBlur",
  focus: "onFocus",
}


export interface AppletRendererProps {
  /** The JSX source (canonical, stored on the note). */
  source: string
  /** Persisted state to hydrate over the declared defaults (Phase 2b wires this). */
  initialState?: Record<string, JsonValue>
  /** Called with the next state after each change when the applet is `persist`. */
  onPersist?: (state: Record<string, unknown>) => void
  className?: string
}


/** Compile + render an applet, contained and wrapped in an error boundary. */
export function AppletRenderer({ source, initialState, onPersist, className }: AppletRendererProps) {
  const compiled = useMemo(() => compileApplet(source), [source])

  return (
    <div className={cn("applet-root", className)} style={{ contain: "layout paint", isolation: "isolate" }}>
      {compiled.ok ? (
        // Reset on source change so an edited applet re-hydrates fresh state and
        // clears any prior error; `key={source}` remounts TreeView's state ref.
        <AppletErrorBoundary resetKey={source} fallback={(e, reset) => <ErrorCard message={e.message} onRetry={reset} />}>
          <TreeView key={source} tree={compiled.tree} initialState={initialState} onPersist={onPersist} />
        </AppletErrorBoundary>
      ) : (
        <ErrorCard message={compiled.message} line={compiled.line} />
      )}
    </div>
  )
}


/** The failure UI for a compile error or a caught render throw. */
function ErrorCard({ message, line, onRetry }: { message: string; line?: number; onRetry?: () => void }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
      <div className="font-medium">Applet error</div>
      <div className="mt-0.5 text-xs opacity-90">
        {message}
        {line ? ` (line ${line})` : ""}
      </div>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="mt-2 rounded-md border px-2 py-0.5 text-xs hover:bg-destructive/10">
          Retry
        </button>
      ) : null}
    </div>
  )
}


/** Owns applet state (in a ref, for correct batching) and renders the tree. */
function TreeView({
  tree,
  initialState,
  onPersist,
}: {
  tree: AppletTree
  initialState?: Record<string, JsonValue>
  onPersist?: (state: Record<string, unknown>) => void
}) {
  const data = useMemo(() => tree.scopes.data ?? {}, [tree.scopes.data])
  // State lives in a ref so a second event in the same React tick reads the first
  // event's result (a render snapshot would drop it); `bump` re-renders.
  const stateRef = useRef<Record<string, unknown>>({ ...(tree.scopes.state ?? {}), ...(initialState ?? {}) })
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const state = stateRef.current

  const derived = useMemo(() => computeDerived(tree.scopes.derived, state, data), [tree.scopes.derived, state, data])
  const env = useMemo(() => buildEnv(state, data, derived), [state, data, derived])

  // Run a handler against the LATEST committed state (from the ref), commit the
  // next state, fire any toasts, and persist when the applet is `persist`.
  const runAction = useCallback(
    (action: Action, event: unknown) => {
      const cur = stateRef.current
      const actionEnv: Env = buildEnv(cur, data, computeDerived(tree.scopes.derived, cur, data))
      actionEnv.set("$event", sanitizeEvent(event))
      try {
        const { state: next, toasts } = runHandler(action, actionEnv, cur, makeCtx())
        stateRef.current = next
        bump()
        for (const t of toasts) (t.level === "error" ? toast.error : toast)(t.message)
        if (tree.persist) onPersist?.(next)
      } catch (e) {
        if (import.meta.env.DEV) console.error("[applet] action error", e)
      }
    },
    [data, tree.persist, tree.scopes.derived, onPersist],
  )

  return <>{renderNode(tree.root, env, runAction)}</>
}


type RunAction = (action: Action, event: unknown) => void


/** Render one tree node to React. `key` positions it among its siblings. */
function renderNode(node: Node, env: Env, runAction: RunAction, key?: string): ReactNode {
  switch (node.k) {
    case "txt":
      return node.v !== undefined ? node.v : renderValue(tryEval(node.x as Expr, env))
    case "el":
      return renderElement(node, env, runAction, key)
    case "list":
      return renderList(node, env, runAction, key)
    case "cond": {
      const branch = tryEval(node.test, env) ? node.then : node.else
      return branch ? renderNode(branch, env, runAction, key) : null
    }
  }
}


/** Render an `el` node: static props + evaluated binds + wrapped handlers + kids. */
function renderElement(node: ElNode, env: Env, runAction: RunAction, key?: string): ReactNode {
  const type = COMPONENT_IMPLS[node.tag] ?? node.tag
  const props: Record<string, unknown> = { ...(node.props ?? {}) }
  if (key !== undefined) props.key = key

  if (node.bind) {
    for (const [name, expr] of Object.entries(node.bind)) props[name] = tryEval(expr, env)
  }
  if (node.on) {
    for (const [event, action] of Object.entries(node.on)) {
      const prop = EVENT_PROP[event]
      if (prop) props[prop] = (e: unknown) => runAction(action, e)
    }
  }

  const children = node.children?.map((child, i) => renderNode(child, env, runAction, String(i)))
  // Void elements (input/img/br/hr) must not receive a children argument.
  return children && children.length ? createElement(type, props, ...children) : createElement(type, props)
}


/** Render a `.map` list: item keys are prefixed with the list's own sibling key
 *  so two sibling lists (each index-keyed) can't collide. */
function renderList(node: ListNode, env: Env, runAction: RunAction, key?: string): ReactNode {
  const src = tryEval(node.src, env)
  if (!Array.isArray(src)) return null
  const shown = src.length > MAX_LIST_ITEMS ? src.slice(0, MAX_LIST_ITEMS) : src
  const out: ReactNode[] = shown.map((item, i) => {
    const childEnv: Env = new Map(env)
    childEnv.set(node.item, item)
    if (node.index) childEnv.set(node.index, i)
    return renderNode(node.tpl, childEnv, runAction, `${key ?? "l"}:${keyForItem(item, i)}`)
  })
  if (src.length > MAX_LIST_ITEMS) {
    out.push(
      createElement(
        "div",
        { key: `${key ?? "l"}:more`, className: "px-1 py-0.5 text-xs text-muted-foreground" },
        `… ${src.length - MAX_LIST_ITEMS} more`,
      ),
    )
  }
  return out
}


// ---- evaluation helpers ----

/** Evaluate an expression with a fresh budget, degrading a failure to undefined
 *  (a bad binding renders nothing rather than throwing through React). */
function tryEval(expr: Expr, env: Env): unknown {
  try {
    return evalExpr(expr, env, makeCtx())
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[applet] expression error", e)
    return undefined
  }
}


/** Coerce a bound value to a renderable child: JSX renders null/undefined/boolean
 *  as nothing; everything else (incl. 0 and "") renders as its string. */
function renderValue(value: unknown): ReactNode {
  if (value === null || value === undefined || typeof value === "boolean") return null
  // Arrays/objects aren't renderable text — degrade to nothing rather than showing
  // "[object Object]". (A list is authored as `.map`, not a bare object binding.)
  if (typeof value === "object") return null
  return String(value)
}


/** Build the identifier scope: state + data + derived (no key collisions — the
 *  transformer rejects overlapping scope keys). */
function buildEnv(state: Record<string, unknown>, data: Record<string, unknown>, derived: Record<string, unknown>): Env {
  return new Map<string, unknown>([...Object.entries(data), ...Object.entries(state), ...Object.entries(derived)])
}


/** Evaluate the `derived` expressions against state + data. */
function computeDerived(
  spec: Record<string, Expr> | undefined,
  state: Record<string, unknown>,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (!spec) return {}
  const base = buildEnv(state, data, {})
  const out: Record<string, unknown> = {}
  for (const [name, expr] of Object.entries(spec)) out[name] = tryEval(expr, base)
  return out
}


/** Extract the sanitized event fields exposed to actions as `$event` (§8.7). */
function sanitizeEvent(event: unknown): { value: unknown; checked: unknown; key: unknown } {
  const e = event as { target?: { value?: unknown; checked?: unknown }; key?: unknown } | null
  return { value: e?.target?.value, checked: e?.target?.checked, key: e?.key }
}


/** Stable list key: the item's `id` when present, else the index. */
function keyForItem(item: unknown, index: number): string {
  const id = (item as { id?: unknown })?.id
  return id === undefined || id === null ? String(index) : String(id)
}
