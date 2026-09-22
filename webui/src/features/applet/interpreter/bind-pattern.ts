// Destructuring-param binding for arrow callbacks (applet-design.md §8.6). Binds
// the leaf identifiers of object/array patterns (with defaults + rest) into a
// child env. Patterns only *name* already-safe values via `safeGet`, so they add
// no new read surface — the §8.4 escape-key denial applies to every pattern key.
// `depth` is threaded so default/computed-key expressions compose the depth budget
// (never reset it) — otherwise nested defaults could overflow the JS stack.

import { AppletError } from "./errors"
import { evalExpr, type Ctx } from "./eval-expr"
import { copyOwnEnumerable } from "./object-spread"
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
  depth: number,
): void {
  ctx.budget.tick()
  ctx.budget.checkDepth(depth)
  const d = depth + 1

  switch (pattern.type) {
    case "Identifier":
      target.set(pattern.name, value)
      return

    case "AssignmentPattern": {
      const resolved = value === undefined ? evalExpr(pattern.right, evalEnv, ctx, d) : value
      bindPattern(pattern.left, resolved, target, evalEnv, ctx, d)
      return
    }

    case "ArrayPattern": {
      const arr = Array.isArray(value) ? value : []
      pattern.elements.forEach((el, i) => {
        if (el === null) return
        if (el.type === "RestElement") {
          bindPattern(el.argument, arr.slice(i), target, evalEnv, ctx, d)
        } else {
          bindPattern(el, arr[i], target, evalEnv, ctx, d)
        }
      })
      return
    }

    case "ObjectPattern": {
      const consumed = new Set<string>()
      for (const prop of pattern.properties) {
        if (prop.type === "RestElement") {
          bindPattern(prop.argument, copyOwnEnumerable(value, ctx, consumed), target, evalEnv, ctx, d)
          continue
        }
        const key = propKey(prop.key, prop.computed, evalEnv, ctx, d)
        consumed.add(key)
        bindPattern(prop.value, safeGet(value, key), target, evalEnv, ctx, d)
      }
      return
    }

    default:
      throw new AppletError(`unsupported pattern: ${(pattern as { type: string }).type}`)
  }
}


// Resolve an object-pattern key to its name (a computed key is evaluated), and
// reject escape keys so `({ __proto__ }) => …` can't reach the prototype chain.
function propKey(key: Expr, computed: boolean, evalEnv: Env, ctx: Ctx, depth: number): string {
  let name: string
  if (computed) name = String(evalExpr(key, evalEnv, ctx, depth))
  else if (key.type === "Identifier") name = key.name
  else if (key.type === "Literal") name = String(key.value)
  else throw new AppletError("unsupported destructuring key")

  if (BLOCKED_KEYS.has(name)) {
    throw new AppletError(`forbidden destructuring key: ${name}`)
  }
  return name
}
