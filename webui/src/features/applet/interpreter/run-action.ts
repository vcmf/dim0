// The action executor (applet-design.md §9, §6.4). Applies a handler's guarded
// action to state and returns the NEXT state immutably (the original is never
// mutated) plus any toasts to fire. Argument/guard expressions are evaluated
// against `env` (the snapshot the event saw); paths read the evolving working
// state so a batch composes. Paths are static and re-checked against the
// escape-key denial defensively.

import { evalExpr, truthy, type Ctx } from "./eval-expr"
import { AppletError } from "./errors"
import { splitAndCheckPath } from "./path"
import { safeGet } from "./safe-get"
import type { Action, Env } from "./types"


export type StateObject = Record<string, unknown>


export interface Toast {
  message: string
  level: "info" | "error"
}


export interface HandlerResult {
  state: StateObject
  toasts: Toast[]
}


/** Run a handler (a guarded action) against `state`, returning the next state. */
export function runHandler(action: Action, env: Env, state: StateObject, ctx: Ctx): HandlerResult {
  const toasts: Toast[] = []
  const next = apply(action, env, state, ctx, toasts)
  return { state: next as StateObject, toasts }
}


// Apply one action to `state`, returning the next state (immutably) and pushing
// any toasts. Handles guarded actions and batches recursively; `depth` bounds the
// action tree so a deeply nested batch/guard can't overflow the stack.
function apply(action: Action, env: Env, state: unknown, ctx: Ctx, toasts: Toast[], depth = 0): unknown {
  ctx.budget.tick()
  ctx.budget.checkDepth(depth) // a deeply nested batch/guard tree must throw AppletError, not overflow the stack
  const d = depth + 1

  if ("guard" in action) {
    if (truthy(evalExpr(action.guard, env, ctx, depth))) return apply(action.then, env, state, ctx, toasts, d)
    return action.else ? apply(action.else, env, state, ctx, toasts, d) : state
  }

  switch (action.do) {
    case "set":
      return setIn(state, splitPath(action.path), evalExpr(action.arg, env, ctx, depth))
    case "toggle": {
      const path = splitPath(action.path)
      return setIn(state, path, !truthy(getIn(state, path)))
    }
    case "append": {
      const path = splitPath(action.path)
      const cur = getIn(state, path)
      const arr = Array.isArray(cur) ? cur : []
      return setIn(state, path, [...arr, evalExpr(action.arg, env, ctx, depth)])
    }
    case "toast":
      toasts.push({ message: String(evalExpr(action.arg, env, ctx, depth)), level: action.level ?? "info" })
      return state
    case "batch": {
      let s = state
      for (const a of action.actions) s = apply(a, env, s, ctx, toasts, d)
      return s
    }
    default:
      throw new AppletError(`unknown action: ${(action as { do: string }).do}`)
  }
}


// Split and validate a static action path (via the shared checker), throwing an
// AppletError on an empty or escape-key segment.
function splitPath(path: string): string[] {
  const r = splitAndCheckPath(path)
  if ("error" in r) throw new AppletError(r.error)
  return r.segments
}


// Read the value at a dotted path from `obj` (via safeGet), returning undefined if
// any intermediate value is nullish.
function getIn(obj: unknown, parts: string[]): unknown {
  let cur = obj
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined
    cur = safeGet(cur, p)
  }
  return cur
}


// Immutable deep set: returns a shallow-cloned spine with `value` at `parts`,
// preserving arrays as arrays so index writes don't turn a list into an object.
function setIn(obj: unknown, parts: string[], value: unknown): unknown {
  if (parts.length === 0) return value
  const [head, ...rest] = parts

  if (Array.isArray(obj)) {
    // Bound the index so a static path like "list.1000000000" can't allocate a
    // giant sparse array (a DoS the eval budgets don't cover — they bound
    // evaluation, not result size). Allow [0, length] (== length appends).
    const i = Number(head)
    if (!Number.isInteger(i) || i < 0 || i > obj.length) {
      throw new AppletError(`array index out of range: ${head}`)
    }
    const copy = obj.slice()
    copy[i] = rest.length ? setIn(copy[i], rest, value) : value
    return copy
  }

  const base = typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>) : {}
  const copy: Record<string, unknown> = { ...base }
  copy[head] = rest.length ? setIn(copy[head], rest, value) : value
  return copy
}
