// Destructuring-param binding for arrow callbacks (applet-design.md §8.6). Binds
// the leaf identifiers of object/array patterns (with defaults + rest) into a
// child env. Patterns only *name* already-safe values via `safeGet`, so they add
// no new read surface — the §8.4 escape-key denial applies to every pattern key.

import { AppletError } from "./errors"
import { evalExpr, type Ctx } from "./eval-expr"
import { BLOCKED_KEYS, safeGet } from "./safe-get"
import type { Env, Expr, Pattern } from "./types"


/**
 * Bind `value` to `pattern`, writing leaf names into `target`. `evalEnv` is the
 * scope in which any default expressions (`{ x = expr }`) are evaluated.
 */
export function bindPattern(
  pattern: Pattern,
  value: unknown,
  target: Env,
  evalEnv: Env,
  ctx: Ctx,
): void {
  ctx.budget.tick()

  switch (pattern.type) {
    case "Identifier":
      target.set(pattern.name, value)
      return

    case "AssignmentPattern": {
      const resolved = value === undefined ? evalExpr(pattern.right, evalEnv, ctx) : value
      bindPattern(pattern.left, resolved, target, evalEnv, ctx)
      return
    }

    case "ArrayPattern": {
      const arr = Array.isArray(value) ? value : []
      pattern.elements.forEach((el, i) => {
        if (el === null) return
        if (el.type === "RestElement") {
          bindPattern(el.argument, arr.slice(i), target, evalEnv, ctx)
        } else {
          bindPattern(el, arr[i], target, evalEnv, ctx)
        }
      })
      return
    }

    case "ObjectPattern": {
      const consumed = new Set<string>()
      for (const prop of pattern.properties) {
        if (prop.type === "RestElement") {
          bindPattern(prop.argument, restObject(value, consumed, ctx), target, evalEnv, ctx)
          continue
        }
        const key = propKey(prop.key, prop.computed, evalEnv, ctx)
        consumed.add(key)
        bindPattern(prop.value, safeGet(value, key), target, evalEnv, ctx)
      }
      return
    }

    default:
      throw new AppletError(`unsupported pattern: ${(pattern as { type: string }).type}`)
  }
}


function propKey(key: Expr, computed: boolean, evalEnv: Env, ctx: Ctx): string {
  let name: string
  if (computed) name = String(evalExpr(key, evalEnv, ctx))
  else if (key.type === "Identifier") name = key.name
  else if (key.type === "Literal") name = String(key.value)
  else throw new AppletError("unsupported destructuring key")

  if (BLOCKED_KEYS.has(name)) {
    throw new AppletError(`forbidden destructuring key: ${name}`)
  }
  return name
}


// Own enumerable keys of `value` not already destructured — the `...rest` object.
function restObject(value: unknown, consumed: Set<string>, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof value !== "object" || value === null) return out
  const keys = Object.keys(value)
  ctx.budget.checkArray(keys.length) // bound `({...rest}) => …` over a huge object
  for (const key of keys) {
    if (!consumed.has(key) && !BLOCKED_KEYS.has(key)) {
      out[key] = (value as Record<string, unknown>)[key]
    }
  }
  return out
}
