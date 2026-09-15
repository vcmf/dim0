// Shared object-spread filter used by both ObjectExpression spread (`{...v}`,
// eval-expr) and destructuring rest (`({...rest}) => …`, bind-pattern). Kept in
// ONE place because it is prototype-pollution-sensitive: the escape-key denial
// and the size cap must never drift between the two call sites.

import type { Ctx } from "./eval-expr"
import { BLOCKED_KEYS } from "./safe-get"


/** Copy own enumerable keys of `v` (dropping escape keys and any `consumed`),
 *  bounded by the array budget so `{...bigObject}` can't do an unbounded copy. */
export function copyOwnEnumerable(v: unknown, ctx: Ctx, consumed?: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof v !== "object" || v === null) return out
  const keys = Object.keys(v)
  ctx.budget.checkArray(keys.length)
  for (const k of keys) {
    if (BLOCKED_KEYS.has(k)) continue
    if (consumed?.has(k)) continue
    out[k] = (v as Record<string, unknown>)[k]
  }
  return out
}
