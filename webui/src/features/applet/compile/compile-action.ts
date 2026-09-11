// Compile an event-handler expression into a guarded-action AST (applet-design.md
// §9.2). A handler is an action, or `cond && action`, or `cond ? a : b`. Verbs are
// the closed §9.1 set; paths must be static string literals (the footgun gate).

import { BLOCKED_KEYS } from "../interpreter/safe-get"
import type { Action } from "../interpreter/types"
import { ACTION_VERBS } from "../registry"
import { CompileError } from "./errors"
import { locOf, type RawNode } from "./parse"
import { validateExpr } from "./validate-expr"


export function compileAction(node: RawNode): Action {
  if (node.type === "LogicalExpression" && node.operator === "&&") {
    return { guard: validateExpr(node.left as RawNode), then: compileAction(node.right as RawNode) }
  }
  if (node.type === "ConditionalExpression") {
    return {
      guard: validateExpr(node.test as RawNode),
      then: compileAction(node.consequent as RawNode),
      else: compileAction(node.alternate as RawNode),
    }
  }
  if (node.type === "CallExpression") return compileVerb(node)
  throw new CompileError(
    "an event handler must be an action — set/toggle/append/toast/batch, optionally guarded with `cond && …` or `cond ? … : …`",
    locOf(node),
  )
}


function compileVerb(node: RawNode): Action {
  const callee = node.callee as RawNode
  if (callee.type !== "Identifier") throw new CompileError("unknown action", locOf(node))
  const verb = callee.name as string
  if (!ACTION_VERBS.has(verb)) {
    throw new CompileError(`unknown action '${verb}' — use set / toggle / append / toast / batch`, locOf(node))
  }
  const args = node.arguments as RawNode[]

  switch (verb) {
    case "set":
      return { do: "set", path: staticPath(args[0], node), arg: validateExpr(requireArg(args[1], node, "set(path, value)")) }
    case "toggle":
      return { do: "toggle", path: staticPath(args[0], node) }
    case "append":
      return { do: "append", path: staticPath(args[0], node), arg: validateExpr(requireArg(args[1], node, "append(path, value)")) }
    case "toast":
      return { do: "toast", arg: validateExpr(requireArg(args[0], node, "toast(message)")), level: toastLevel(args[1]) }
    case "batch":
      return { do: "batch", actions: args.map(compileAction) }
    default:
      throw new CompileError(`unknown action '${verb}'`, locOf(node))
  }
}


function staticPath(node: RawNode | undefined, at: RawNode): string {
  if (!node || node.type !== "Literal" || typeof node.value !== "string") {
    throw new CompileError(
      'an action path must be a static string literal (e.g. "count", "user.name"), not a computed value',
      locOf(node ?? at),
    )
  }
  // Validate segments now (mirrors run-action's splitPath) so a bad path is an
  // author-time error, not a render-time crash.
  const path = node.value
  for (const seg of path.split(".")) {
    if (seg === "") throw new CompileError(`invalid action path "${path}" — empty segment`, locOf(node))
    if (BLOCKED_KEYS.has(seg)) throw new CompileError(`forbidden path segment '${seg}' in "${path}"`, locOf(node))
  }
  return path
}


function toastLevel(node: RawNode | undefined): "info" | "error" | undefined {
  if (!node) return undefined
  if (node.type === "Literal" && (node.value === "info" || node.value === "error")) return node.value
  throw new CompileError('toast level must be "info" or "error"', locOf(node))
}


function requireArg(node: RawNode | undefined, at: RawNode, sig: string): RawNode {
  if (!node) throw new CompileError(`missing argument — expected ${sig}`, locOf(at))
  if (node.type === "SpreadElement") throw new CompileError("spread arguments are not allowed in actions", locOf(node))
  return node
}
