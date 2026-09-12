// The global call surface (applet-design.md §8.5, Form B) and the value-method
// whitelists (Form A). Everything here is pure and non-mutating. Namespaces
// (`Math`, `Object`, …) resolve to opaque sentinels so they can be used ONLY as
// call targets — never dereferenced into a live function.

type Fn = (...args: unknown[]) => unknown

const NS = Symbol("applet.namespace")


interface NamespaceRef {
  [NS]: string
}


// Make an opaque sentinel standing for a global namespace (e.g. `Math`), usable
// only as a call target — never a live object.
export function makeNamespace(name: string): NamespaceRef {
  return { [NS]: name }
}


// Return the namespace name a sentinel represents, or undefined for a plain value.
export function namespaceName(v: unknown): string | undefined {
  return typeof v === "object" && v !== null && NS in v ? (v as NamespaceRef)[NS] : undefined
}


// Bare identifiers that resolve to a namespace sentinel.
export const NAMESPACE_NAMES = new Set(["Math", "Object", "Array", "Number", "String", "Boolean"])


// Direct-call coercions: `Number(x)`, `String(x)`, `Boolean(x)`.
export const COERCIONS: Record<string, Fn> = {
  Number: (x) => Number(x),
  String: (x) => String(x),
  Boolean: (x) => Boolean(x),
}


// Coerce a value to a number (identity for numbers), used by the Math methods.
export function num(x: unknown): number {
  return typeof x === "number" ? x : Number(x)
}


// Narrow a value to a plain object for the Object.* methods, else an empty object.
function plainObj(o: unknown): Record<string, unknown> {
  return typeof o === "object" && o !== null ? (o as Record<string, unknown>) : {}
}


// Namespace methods: `Math.max(...)`, `Object.keys(o)`, `Array.isArray(x)`, …
export const NAMESPACE_METHODS: Record<string, Record<string, Fn>> = {
  Math: {
    abs: (x) => Math.abs(num(x)),
    min: (...a) => Math.min(...a.map(num)),
    max: (...a) => Math.max(...a.map(num)),
    round: (x) => Math.round(num(x)),
    floor: (x) => Math.floor(num(x)),
    ceil: (x) => Math.ceil(num(x)),
    sqrt: (x) => Math.sqrt(num(x)),
    cbrt: (x) => Math.cbrt(num(x)),
    pow: (x, y) => Math.pow(num(x), num(y)),
    sign: (x) => Math.sign(num(x)),
    trunc: (x) => Math.trunc(num(x)),
    hypot: (...a) => Math.hypot(...a.map(num)),
    log: (x) => Math.log(num(x)),
  },
  Object: {
    keys: (o) => Object.keys(plainObj(o)),
    values: (o) => Object.values(plainObj(o)),
    entries: (o) => Object.entries(plainObj(o)),
  },
  Array: {
    isArray: (x) => Array.isArray(x),
  },
  Number: {
    isFinite: (x) => Number.isFinite(x),
    isInteger: (x) => Number.isInteger(x),
  },
}


// Value-method whitelists (called on an evaluated value). Split so the evaluator
// knows which array methods take an arrow callback (higher-order) vs plain args.
export const HOF_ARRAY_METHODS = new Set([
  "map",
  "filter",
  "find",
  "findIndex",
  "some",
  "every",
  "reduce",
  "flatMap",
  "sort",
])


export const PLAIN_ARRAY_METHODS = new Set([
  "includes",
  "indexOf",
  "lastIndexOf",
  "slice",
  "at",
  "concat",
  "join",
  "flat",
])


export const STRING_METHODS = new Set([
  "toUpperCase",
  "toLowerCase",
  "slice",
  "substring",
  "includes",
  "indexOf",
  "startsWith",
  "endsWith",
  "split",
  "trim",
  "padStart",
  "padEnd",
  "replace",
  "repeat",
  "at",
  "charAt",
])


export const NUMBER_METHODS = new Set(["toFixed", "toString"])
