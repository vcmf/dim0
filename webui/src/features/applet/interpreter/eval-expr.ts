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
  num,
  NUMBER_METHODS,
  PLAIN_ARRAY_METHODS,
  STRING_METHODS,
} from "./globals"
import { copyOwnEnumerable } from "./object-spread"
import { BLOCKED_KEYS, safeGet } from "./safe-get"
import type { Arrow, Call, Env, Expr, Ident, Member, Spread } from "./types"


export interface Ctx {
  budget: Budget
}


// Create a fresh evaluation context with a new per-evaluation budget.
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
          Object.assign(out, copyOwnEnumerable(evalExpr(p.argument, env, ctx, d), ctx))
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
      if (node.operator === "typeof") {
        // `typeof <unbound identifier>` is "undefined" in JS — the one operator
        // safe on an unbound name; don't throw an undefined-reference here.
        if (node.argument.type === "Identifier" && !isBound(node.argument.name, env)) return "undefined"
        return typeof evalExpr(node.argument, env, ctx, d)
      }
      const x = evalExpr(node.argument, env, ctx, d)
      switch (node.operator) {
        case "!":
          return !truthy(x)
        case "-":
          return -num(x)
        case "+":
          return +num(x)
        case "~":
          return ~num(x)
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


// JS truthiness test, used by `&&`/`||`/`?:` and the predicate array methods.
export function truthy(x: unknown): boolean {
  return Boolean(x)
}


// Run a whitelisted native method and convert any native throw (TypeError from
// `[].reduce(fn)`, RangeError from `toFixed(500)` / a huge argument spread, …)
// into an AppletError, so the renderer's degrade-gracefully contract (errors.ts)
// always holds — the interpreter throws only AppletError.
function native<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (e instanceof AppletError) throw e
    throw new AppletError(e instanceof Error ? e.message : String(e))
  }
}


// True if `name` resolves to anything (a scope var, a namespace, or a coercion) —
// lets `typeof <unbound>` return "undefined" instead of throwing.
function isBound(name: string, env: Env): boolean {
  return env.has(name) || NAMESPACE_NAMES.has(name) || Object.hasOwn(COERCIONS, name)
}


// Extract a static object-literal key name from an Identifier or Literal key.
function keyName(key: Expr): string {
  if (key.type === "Identifier") return key.name
  if (key.type === "Literal") return String(key.value)
  throw new AppletError("unsupported object key")
}


// Resolve a bare identifier to its scope value, or to a namespace sentinel for a
// global (Math/Number/…). An unknown name throws — the undefined-reference guard.
function resolveIdent(name: string, env: Env): unknown {
  if (env.has(name)) return env.get(name)
  // `Object.hasOwn`, never `in`: COERCIONS is a plain object literal, so `in`
  // would match inherited names (`constructor`, `toString`, `valueOf`, …) and let
  // them resolve as globals — a whitelist bypass.
  if (NAMESPACE_NAMES.has(name) || Object.hasOwn(COERCIONS, name)) return makeNamespace(name)
  throw new AppletError(`undefined reference: ${name}`)
}


// Apply a whitelisted binary operator to two evaluated operands (`in`/`instanceof`
// are rejected). `+` concatenates when either side is a string, else adds numbers.
function evalBinary(op: string, l: unknown, r: unknown): unknown {
  switch (op) {
    case "+":
      return typeof l === "string" || typeof r === "string" ? String(l) + String(r) : num(l) + num(r)
    case "-":
      return num(l) - num(r)
    case "*":
      return num(l) * num(r)
    case "/":
      return num(l) / num(r)
    case "%":
      return num(l) % num(r)
    case "**":
      return num(l) ** num(r)
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
      return num(l) & num(r)
    case "|":
      return num(l) | num(r)
    case "^":
      return num(l) ^ num(r)
    case "<<":
      return num(l) << num(r)
    case ">>":
      return num(l) >> num(r)
    case ">>>":
      return num(l) >>> num(r)
    default:
      // denies `in` and `instanceof` (§8.3)
      throw new AppletError(`unsupported binary operator: ${op}`)
  }
}


// Evaluate member access (`a.b` / `a[b]`, optional `a?.b`) to a data value via
// safeGet — never a prototype method.
function evalMember(node: Member, env: Env, ctx: Ctx, d: number): unknown {
  const obj = evalExpr(node.object, env, ctx, d)
  if (node.optional && (obj === null || obj === undefined)) return undefined
  const key = node.computed ? String(evalExpr(node.property, env, ctx, d)) : (node.property as Ident).name
  return safeGet(obj, key)
}


// Evaluate a call: a coercion for an identifier callee (Number/String/Boolean), or
// a namespace/value method for a member callee. Native throws are wrapped as
// AppletError.
function evalCall(node: Call, env: Env, ctx: Ctx, d: number): unknown {
  const callee = node.callee

  // Identifier callee → a coercion only: Number(x) / String(x) / Boolean(x).
  // `Object.hasOwn`, never `in`: otherwise `constructor()` / `toString()` /
  // `valueOf()` would resolve to inherited Object.prototype functions.
  if (callee.type === "Identifier") {
    const name = callee.name
    if (!env.has(name) && Object.hasOwn(COERCIONS, name)) {
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
      // `Object.hasOwn` at both levels: bracket access on the plain-object tables
      // would otherwise resolve inherited names (`Math.toString`, `Math.valueOf`).
      const table = Object.hasOwn(NAMESPACE_METHODS, ns) ? NAMESPACE_METHODS[ns] : undefined
      const fn = table && Object.hasOwn(table, method) ? table[method] : undefined
      if (!fn) throw new AppletError(`unknown ${ns} method: ${method}`)
      const args = evalArgs(node.arguments, env, ctx, d) // spread is length-capped in `spread`
      return native(() => fn(...args))
    }
    return native(() => callValueMethod(recv, method, node.arguments, env, ctx, d))
  }

  throw new AppletError("unsupported call target")
}


// Evaluate call arguments, flattening any spread elements into the argument list.
function evalArgs(args: (Expr | Spread)[], env: Env, ctx: Ctx, d: number): unknown[] {
  const out: unknown[] = []
  for (const a of args) {
    if (a.type === "SpreadElement") out.push(...spread(a, env, ctx, d))
    else out.push(evalExpr(a, env, ctx, d))
  }
  return out
}


// Evaluate a spread argument to its array value, requiring an array and bounding
// its length so a huge spread (`Math.max(...huge)`, big literal spreads) can't DoS.
function spread(node: Spread, env: Env, ctx: Ctx, d: number): unknown[] {
  const v = evalExpr(node.argument, env, ctx, d)
  if (!Array.isArray(v)) throw new AppletError("spread of a non-array value")
  ctx.budget.checkArray(v.length) // bounds `Math.max(...huge)` and array-literal spreads
  return v
}


// Build a JS callback from an arrow node — invoked only by our own array-method
// implementations (never stored, never handed out), so it cannot escape.
function makeClosure(node: Expr | Spread | undefined, env: Env, ctx: Ctx, d: number): (...a: unknown[]) => unknown {
  if (!node || node.type !== "ArrowFunctionExpression") {
    throw new AppletError("this method requires an arrow function argument")
  }
  const arrow: Arrow = node
  // Clone the enclosing scope ONCE per closure (not per element): params are
  // rebound each call, non-param bindings stay from the parent. No closure
  // escapes and calls are synchronous, so reuse is safe. Defaults resolve
  // against `child`, so `(a, b = a) => …` sees the already-bound param. `d` is
  // threaded into bindPattern so param defaults / computed keys compose the depth
  // budget instead of resetting it (no stack overflow via nested defaults).
  const child: Env = new Map(env)
  return (...args: unknown[]) => {
    ctx.budget.tick()
    arrow.params.forEach((p, i) => bindPattern(p, args[i], child, child, ctx, d))
    return evalExpr(arrow.body, child, ctx, d)
  }
}


// Dispatch a method call on a value receiver to the array/string/number handler,
// rejecting any method not on that type's whitelist.
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


// Evaluate a whitelisted array method. Higher-order methods (map/filter/reduce/…)
// run an interpreted arrow callback; input length and growable-output sizes are
// budget-bounded.
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
      case "flat": {
        const out = recv.flat(a[0] as number | undefined)
        ctx.budget.checkArray(out.length) // bound the flattened OUTPUT size
        return out
      }
      case "concat":
        return concatBounded(recv, a, ctx)
      default:
        throw new AppletError(`unknown array method: ${method}`)
    }
  }

  // higher-order methods take an arrow callback
  if (method === "sort") {
    const copy = recv.slice()
    if (args.length === 0) return copy.sort(defaultCompare)
    const cmp = makeClosure(args[0], env, ctx, d)
    return copy.sort((x, y) => num(cmp(x, y)))
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
      return flatMapBounded(recv, cb, ctx)
    default:
      throw new AppletError(`unknown array method: ${method}`)
  }
}


// Array methods whose OUTPUT can grow past the input length spend only O(n) ops
// but could allocate an O(n²) array (a memory DoS the op/input budgets miss). Both
// build incrementally and check the running length BEFORE each push, so they throw
// as soon as the cap is crossed — never materializing the huge array.
function concatBounded(recv: unknown[], args: unknown[], ctx: Ctx): unknown[] {
  const out = recv.slice()
  for (const x of args) {
    const items = Array.isArray(x) ? x : [x]
    for (const it of items) {
      ctx.budget.checkArray(out.length + 1)
      out.push(it)
    }
  }
  return out
}


function flatMapBounded(recv: unknown[], cb: (...a: unknown[]) => unknown, ctx: Ctx): unknown[] {
  const out: unknown[] = []
  recv.forEach((v, i) => {
    const r = cb(v, i)
    const items = Array.isArray(r) ? r : [r]
    for (const it of items) {
      ctx.budget.checkArray(out.length + 1)
      out.push(it)
    }
  })
  return out
}


// Default sort comparator: orders by string comparison (mirrors Array#sort).
function defaultCompare(a: unknown, b: unknown): number {
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}


// Evaluate a whitelisted string method; length-growing methods (repeat/padStart/
// padEnd) are budget-bounded and `replace` rejects RegExp arguments.
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


// Evaluate a whitelisted number method (toFixed / toString).
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
