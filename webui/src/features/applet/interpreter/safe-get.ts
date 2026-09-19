// Property access — the security crux (applet-design.md §8.4). Reads data only:
// own enumerable properties plus `length`, never the prototype chain (the path
// from any value back to `Function`). Method names (`map`, `toUpperCase`, …) live
// on prototypes, so they resolve to `undefined` here — methods are dispatched only
// in call position (see eval-expr `evalCall`), never handed out as values.

import { AppletError } from "./errors"


// Denied statically and dynamically: the three doors to the prototype chain.
export const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"])


// Read `obj[key]` as data only: string/array `length` and indices, own enumerable
// object properties. Escape keys throw; anything else (incl. prototype methods)
// returns undefined.
export function safeGet(obj: unknown, key: string): unknown {
  if (BLOCKED_KEYS.has(key)) {
    throw new AppletError(`forbidden property access: ${key}`)
  }
  if (obj == null) return undefined

  if (typeof obj === "string") {
    if (key === "length") return obj.length
    const i = Number(key)
    return Number.isInteger(i) && i >= 0 ? obj[i] : undefined
  }

  if (Array.isArray(obj)) {
    if (key === "length") return obj.length
    return own(obj as unknown as Record<string, unknown>, key)
  }

  if (typeof obj === "object") {
    return own(obj as Record<string, unknown>, key)
  }

  // numbers / booleans / functions / symbols expose no readable data props
  return undefined
}


// Read a key only if the object owns it as an enumerable property — never an
// inherited one. `Object.hasOwn` does not consult the prototype chain.
function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined
}
