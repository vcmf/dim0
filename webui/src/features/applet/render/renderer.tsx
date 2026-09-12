// The inline applet renderer (applet-design.md §5). Compiles JSX source to the §6
// tree (memoized), then interprets it into a live React tree — no iframe, no eval.
// State lives in React; events run the bounded action interpreter and setState;
// expression bindings are evaluated per render with a fresh budget. Failures
// degrade gracefully: a bad binding renders nothing, a thrown render is caught by
// the error boundary (§5.3), and the whole widget is layout-contained (§5.2).

import { createElement, useCallback, useMemo, useState, type ReactNode } from "react"

import { toast } from "sonner"

import { cn } from "@/lib/utils"

import { compileApplet } from "../compile"
import { evalExpr, makeCtx, runHandler } from "../interpreter"
import type { Action, Env, Expr } from "../interpreter/types"
import type { AppletTree, ElNode, JsonValue, ListNode, Node } from "../tree"
import { COMPONENT_IMPLS } from "./components"
import { AppletErrorBoundary } from "./error-boundary"


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
        <AppletErrorBoundary fallback={(e) => <ErrorCard message={e.message} />}>
          <TreeView tree={compiled.tree} initialState={initialState} onPersist={onPersist} />
        </AppletErrorBoundary>
      ) : (
        <ErrorCard message={compiled.message} line={compiled.line} />
      )}
    </div>
  )
}


/** The failure UI for a compile error or a caught render throw. */
function ErrorCard({ message, line }: { message: string; line?: number }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
      <div className="font-medium">Applet error</div>
      <div className="mt-0.5 text-xs opacity-90">
        {message}
        {line ? ` (line ${line})` : ""}
      </div>
    </div>
  )
}


/** Owns applet state and renders the tree; recomputes derived/env on each change. */
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
  const [state, setState] = useState<Record<string, unknown>>(() => ({
    ...(tree.scopes.state ?? {}),
    ...(initialState ?? {}),
  }))

  const derived = useMemo(() => computeDerived(tree.scopes.derived, state, data), [tree.scopes.derived, state, data])
  const env = useMemo(() => buildEnv(state, data, derived), [state, data, derived])

  // Run a handler: evaluate its guard/args against the current env + sanitized
  // event, commit the next state, and fire any toasts.
  const runAction = useCallback(
    (action: Action, event: unknown) => {
      const actionEnv: Env = new Map(env)
      actionEnv.set("$event", sanitizeEvent(event))
      try {
        const { state: next, toasts } = runHandler(action, actionEnv, state, makeCtx())
        setState(next)
        for (const t of toasts) (t.level === "error" ? toast.error : toast)(t.message)
        if (tree.persist) onPersist?.(next)
      } catch (e) {
        if (import.meta.env.DEV) console.error("[applet] action error", e)
      }
    },
    [env, state, tree.persist, onPersist],
  )

  return <>{renderNode(tree.root, env, runAction)}</>
}


/** Render one tree node to React. */
function renderNode(node: Node, env: Env, runAction: RunAction, key?: string): ReactNode {
  switch (node.k) {
    case "txt":
      return node.v !== undefined ? node.v : renderValue(tryEval(node.x as Expr, env))
    case "el":
      return renderElement(node, env, runAction, key)
    case "list":
      return renderList(node, env, runAction)
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


/** Render a `.map` list: evaluate the source array, bind item/index per element. */
function renderList(node: ListNode, env: Env, runAction: RunAction): ReactNode {
  const src = tryEval(node.src, env)
  if (!Array.isArray(src)) return null
  return src.map((item, i) => {
    const childEnv: Env = new Map(env)
    childEnv.set(node.item, item)
    if (node.index) childEnv.set(node.index, i)
    return renderNode(node.tpl, childEnv, runAction, keyForItem(item, i))
  })
}


type RunAction = (action: Action, event: unknown) => void


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
  return String(value)
}


/** Build the identifier scope: state + data + derived (no key collisions — the
 *  transformer rejects overlapping scope keys). */
function buildEnv(state: Record<string, unknown>, data: Record<string, unknown>, derived: Record<string, unknown>): Env {
  return new Map<string, unknown>([...Object.entries(data), ...Object.entries(state), ...Object.entries(derived)])
}


/** Evaluate the `derived` expressions against state + data (memoized upstream). */
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
