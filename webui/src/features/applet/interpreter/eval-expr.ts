// The expression evaluator — the applet security boundary (applet-design.md §5.1,
// §8). A deny-by-default walk over the ESTree subset in `types.ts`. It never
// evaluates a node type outside that subset, never reaches the prototype chain
// (safe-get.ts), never treats a method as a first-class value (methods dispatch
// only here, in call position), and is bounded by budgets so it always
// terminates. The red-team suite (redteam.test.ts) is the audit that guards it.

import { bindPattern } from "./bind-pattern"
import { Budget } from "./budget"
import { AppletError } from "./errors"
import {
  COERCIONS,
  HOF_ARRAY_METHODS,
  makeNamespace,
  NAMESPACE_METHODS,
  NAMESPACE_NAMES,
  namespaceName,
  NUMBER_METHODS,
  PLAIN_ARRAY_METHODS,
  STRING_METHODS,
} from "./globals"
import { BLOCKED_KEYS, safeGet } from "./safe-get"
import type { Arrow, Call, Env, Expr, Ident, Member, Spread } from "./types"


export interface Ctx {
  budget: Budget
}


export function makeCtx(): Ctx {
  return { budget: new Budget() }
}


/** Evaluate an expression against `env`. Throws `AppletError` on any violation. */
export function evalExpr(node: Expr, env: Env, ctx: Ctx, depth = 0): unknown {
  ctx.budget.tick()
  ctx.budget.checkDepth(depth)
  const d = depth + 1

  switch (node.type) {
    case "Literal":
      return node.value
    case "Identifier":
      return resolveIdent(node.name, env)
    case "TemplateLiteral": {
      let out = ""
      node.quasis.forEach((q, i) => {
        out += q.value.cooked ?? ""
        if (i < node.expressions.length) out += String(evalExpr(node.expressions[i], env, ctx, d))
      })
      return out
    }
    case "ArrayExpression": {
      const out: unknown[] = []
      for (const el of node.elements) {
        if (el === null) {
          out.push(undefined)
        } else if (el.type === "SpreadElement") {
          out.push(...spread(el, env, ctx, d))
        } else {
          out.push(evalExpr(el, env, ctx, d))
        }
      }
      return out
    }
    case "ObjectExpression": {
      const out: Record<string, unknown> = {}
      for (const p of node.properties) {
        if (p.type === "SpreadElement") {
          Object.assign(out, spreadObject(spreadValue(p, env, ctx, d)))
          continue
        }
        const key = p.computed
          ? String(evalExpr(p.key, env, ctx, d))
          : keyName(p.key)
        if (BLOCKED_KEYS.has(key)) throw new AppletError(`forbidden object key: ${key}`)
        out[key] = evalExpr(p.value, env, ctx, d)
      }
      return out
    }
    case "UnaryExpression": {
      if (node.operator === "typeof") return typeof evalExpr(node.argument, env, ctx, d)
      const x = evalExpr(node.argument, env, ctx, d)
      switch (node.operator) {
        case "!":
          return !truthy(x)
        case "-":
          return -toNum(x)
        case "+":
          return +toNum(x)
        case "~":
          return ~toNum(x)
        default:
          throw new AppletError(`unsupported unary operator: ${node.operator}`)
      }
    }
    case "BinaryExpression":
      return evalBinary(node.operator, evalExpr(node.left, env, ctx, d), evalExpr(node.right, env, ctx, d))
    case "LogicalExpression": {
      const l = evalExpr(node.left, env, ctx, d)
      switch (node.operator) {
        case "&&":
          return truthy(l) ? evalExpr(node.right, env, ctx, d) : l
        case "||":
          return truthy(l) ? l : evalExpr(node.right, env, ctx, d)
        case "??":
          return l === null || l === undefined ? evalExpr(node.right, env, ctx, d) : l
        default:
          throw new AppletError(`unsupported logical operator: ${node.operator}`)
      }
    }
    case "ConditionalExpression":
      return truthy(evalExpr(node.test, env, ctx, d))
        ? evalExpr(node.consequent, env, ctx, d)
        : evalExpr(node.alternate, env, ctx, d)
    case "MemberExpression":
      return evalMember(node, env, ctx, d)
    case "CallExpression":
      return evalCall(node, env, ctx, d)
    case "ArrowFunctionExpression":
      throw new AppletError("arrow functions are allowed only as array-method arguments")
    default:
      throw new AppletError(`unsupported expression: ${(node as { type: string }).type}`)
  }
}


export function truthy(x: unknown): boolean {
  return Boolean(x)
}


function toNum(x: unknown): number {
  return typeof x === "number" ? x : Number(x)
}


function keyName(key: Expr): string {
  if (key.type === "Identifier") return key.name
  if (key.type === "Literal") return String(key.value)
  throw new AppletError("unsupported object key")
}


function resolveIdent(name: string, env: Env): unknown {
  if (env.has(name)) return env.get(name)
  if (NAMESPACE_NAMES.has(name) || name in COERCIONS) return makeNamespace(name)
  throw new AppletError(`undefined reference: ${name}`)
}


function evalBinary(op: string, l: unknown, r: unknown): unknown {
  switch (op) {
    case "+":
      return typeof l === "string" || typeof r === "string" ? String(l) + String(r) : toNum(l) + toNum(r)
    case "-":
      return toNum(l) - toNum(r)
    case "*":
      return toNum(l) * toNum(r)
    case "/":
      return toNum(l) / toNum(r)
    case "%":
      return toNum(l) % toNum(r)
    case "**":
      return toNum(l) ** toNum(r)
    case "===":
      return l === r
    case "!==":
      return l !== r
    case "==":
      return l == r
    case "!=":
      return l != r
    case "<":
      return (l as number) < (r as number)
    case "<=":
      return (l as number) <= (r as number)
    case ">":
      return (l as number) > (r as number)
    case ">=":
      return (l as number) >= (r as number)
    case "&":
      return toNum(l) & toNum(r)
    case "|":
      return toNum(l) | toNum(r)
    case "^":
      return toNum(l) ^ toNum(r)
    case "<<":
      return toNum(l) << toNum(r)
    case ">>":
      return toNum(l) >> toNum(r)
    case ">>>":
      return toNum(l) >>> toNum(r)
    default:
      // denies `in` and `instanceof` (§8.3)
      throw new AppletError(`unsupported binary operator: ${op}`)
  }
}


function evalMember(node: Member, env: Env, ctx: Ctx, d: number): unknown {
  const obj = evalExpr(node.object, env, ctx, d)
  if (node.optional && (obj === null || obj === undefined)) return undefined
  const key = node.computed ? String(evalExpr(node.property, env, ctx, d)) : (node.property as Ident).name
  return safeGet(obj, key)
}


function evalCall(node: Call, env: Env, ctx: Ctx, d: number): unknown {
  const callee = node.callee

  // Identifier callee → a coercion only: Number(x) / String(x) / Boolean(x).
  if (callee.type === "Identifier") {
    const name = callee.name
    if (!env.has(name) && name in COERCIONS) {
      return COERCIONS[name](...evalArgs(node.arguments, env, ctx, d))
    }
    throw new AppletError(`call to non-whitelisted function: ${name}`)
  }

  // Member callee → a namespace method or a value method.
  if (callee.type === "MemberExpression") {
    const recv = evalExpr(callee.object, env, ctx, d)
    if (callee.optional && (recv === null || recv === undefined)) return undefined
    const method = callee.computed ? String(evalExpr(callee.property, env, ctx, d)) : (callee.property as Ident).name
    if (BLOCKED_KEYS.has(method)) throw new AppletError(`forbidden method: ${method}`)

    const ns = namespaceName(recv)
    if (ns) {
      const fn = NAMESPACE_METHODS[ns]?.[method]
      if (!fn) throw new AppletError(`unknown ${ns} method: ${method}`)
      return fn(...evalArgs(node.arguments, env, ctx, d))
    }
    return callValueMethod(recv, method, node.arguments, env, ctx, d)
  }

  throw new AppletError("unsupported call target")
}


function evalArgs(args: (Expr | Spread)[], env: Env, ctx: Ctx, d: number): unknown[] {
  const out: unknown[] = []
  for (const a of args) {
    if (a.type === "SpreadElement") out.push(...spread(a, env, ctx, d))
    else out.push(evalExpr(a, env, ctx, d))
  }
  return out
}


function spread(node: Spread, env: Env, ctx: Ctx, d: number): unknown[] {
  const v = evalExpr(node.argument, env, ctx, d)
  if (!Array.isArray(v)) throw new AppletError("spread of a non-array value")
  return v
}


function spreadValue(node: Spread, env: Env, ctx: Ctx, d: number): unknown {
  return evalExpr(node.argument, env, ctx, d)
}


function spreadObject(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof v !== "object" || v === null) return out
  for (const k of Object.keys(v)) {
    if (!BLOCKED_KEYS.has(k)) out[k] = (v as Record<string, unknown>)[k]
  }
  return out
}


// Build a JS callback from an arrow node — invoked only by our own array-method
// implementations (never stored, never handed out), so it cannot escape.
function makeClosure(node: Expr | Spread | undefined, env: Env, ctx: Ctx, d: number): (...a: unknown[]) => unknown {
  if (!node || node.type !== "ArrowFunctionExpression") {
    throw new AppletError("this method requires an arrow function argument")
  }
  const arrow: Arrow = node
  return (...args: unknown[]) => {
    ctx.budget.tick()
    const child: Env = new Map(env)
    arrow.params.forEach((p, i) => bindPattern(p, args[i], child, env, ctx))
    return evalExpr(arrow.body, child, ctx, d)
  }
}


function callValueMethod(
  recv: unknown,
  method: string,
  args: (Expr | Spread)[],
  env: Env,
  ctx: Ctx,
  d: number,
): unknown {
  if (Array.isArray(recv)) {
    if (!HOF_ARRAY_METHODS.has(method) && !PLAIN_ARRAY_METHODS.has(method)) {
      throw new AppletError(`unknown array method: ${method}`)
    }
    return callArrayMethod(recv, method, args, env, ctx, d)
  }
  if (typeof recv === "string") {
    if (!STRING_METHODS.has(method)) throw new AppletError(`unknown string method: ${method}`)
    return callStringMethod(recv, method, evalArgs(args, env, ctx, d), ctx)
  }
  if (typeof recv === "number") {
    if (!NUMBER_METHODS.has(method)) throw new AppletError(`unknown number method: ${method}`)
    return callNumberMethod(recv, method, evalArgs(args, env, ctx, d))
  }
  throw new AppletError(`cannot call method ${method} on this value`)
}


function callArrayMethod(
  recv: unknown[],
  method: string,
  args: (Expr | Spread)[],
  env: Env,
  ctx: Ctx,
  d: number,
): unknown {
  ctx.budget.checkArray(recv.length)

  if (PLAIN_ARRAY_METHODS.has(method)) {
    const a = evalArgs(args, env, ctx, d)
    switch (method) {
      case "includes":
        return recv.includes(a[0])
      case "indexOf":
        return recv.indexOf(a[0])
      case "lastIndexOf":
        return recv.lastIndexOf(a[0])
      case "slice":
        return recv.slice(a[0] as number | undefined, a[1] as number | undefined)
      case "at":
        return recv.at(a[0] as number)
      case "join":
        return recv.join(a[0] as string | undefined)
      case "flat":
        return recv.flat(a[0] as number | undefined)
      case "concat":
        return recv.concat(...a.map((x) => (Array.isArray(x) ? x : [x])))
      default:
        throw new AppletError(`unknown array method: ${method}`)
    }
  }

  // higher-order methods take an arrow callback
  if (method === "sort") {
    const copy = recv.slice()
    if (args.length === 0) return copy.sort(defaultCompare)
    const cmp = makeClosure(args[0], env, ctx, d)
    return copy.sort((x, y) => toNum(cmp(x, y)))
  }
  if (method === "reduce") {
    const cb = makeClosure(args[0], env, ctx, d)
    const init = evalArgs(args.slice(1), env, ctx, d)
    return init.length
      ? recv.reduce((acc, v, i) => cb(acc, v, i), init[0])
      : recv.reduce((acc, v, i) => cb(acc, v, i))
  }

  const cb = makeClosure(args[0], env, ctx, d)
  switch (method) {
    case "map":
      return recv.map((v, i) => cb(v, i))
    case "filter":
      return recv.filter((v, i) => truthy(cb(v, i)))
    case "find":
      return recv.find((v, i) => truthy(cb(v, i)))
    case "findIndex":
      return recv.findIndex((v, i) => truthy(cb(v, i)))
    case "some":
      return recv.some((v, i) => truthy(cb(v, i)))
    case "every":
      return recv.every((v, i) => truthy(cb(v, i)))
    case "flatMap":
      return recv.flatMap((v, i): unknown => cb(v, i))
    default:
      throw new AppletError(`unknown array method: ${method}`)
  }
}


function defaultCompare(a: unknown, b: unknown): number {
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}


function callStringMethod(recv: string, method: string, a: unknown[], ctx: Ctx): unknown {
  switch (method) {
    case "toUpperCase":
      return recv.toUpperCase()
    case "toLowerCase":
      return recv.toLowerCase()
    case "slice":
      return recv.slice(a[0] as number | undefined, a[1] as number | undefined)
    case "substring":
      return recv.substring(a[0] as number, a[1] as number | undefined)
    case "includes":
      return recv.includes(String(a[0]))
    case "indexOf":
      return recv.indexOf(String(a[0]))
    case "startsWith":
      return recv.startsWith(String(a[0]))
    case "endsWith":
      return recv.endsWith(String(a[0]))
    case "split":
      return recv.split(a[0] as string)
    case "trim":
      return recv.trim()
    case "at":
      return recv.at(a[0] as number)
    case "charAt":
      return recv.charAt(a[0] as number)
    case "padStart": {
      const n = a[0] as number
      ctx.budget.checkString(n)
      return recv.padStart(n, a[1] as string | undefined)
    }
    case "padEnd": {
      const n = a[0] as number
      ctx.budget.checkString(n)
      return recv.padEnd(n, a[1] as string | undefined)
    }
    case "repeat": {
      const n = Math.max(0, Number(a[0]))
      ctx.budget.checkString(recv.length * n)
      return recv.repeat(n)
    }
    case "replace": {
      // string search only — no RegExp (ReDoS, §8.3). The grammar can't produce a
      // RegExp, so this is defense in depth.
      if (a[0] instanceof RegExp) throw new AppletError("regular expressions are not allowed")
      return recv.replace(String(a[0]), String(a[1]))
    }
    default:
      throw new AppletError(`unknown string method: ${method}`)
  }
}


function callNumberMethod(recv: number, method: string, a: unknown[]): unknown {
  switch (method) {
    case "toFixed":
      return recv.toFixed(a[0] as number | undefined)
    case "toString":
      return recv.toString(a[0] as number | undefined)
    default:
      throw new AppletError(`unknown number method: ${method}`)
  }
}
