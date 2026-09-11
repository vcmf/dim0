// Tiny typed AST builders for interpreter tests. Kept dependency-free (no parser)
// so Phase 0 stands alone; the Phase-1 transformer will produce these same shapes
// from acorn. Not a test file itself — imported by the *.test.ts suites.

import type { Expr, Pattern, Spread } from "./types"


export const lit = (value: string | number | boolean | null): Expr => ({ type: "Literal", value })

export const id = (name: string): Expr => ({ type: "Identifier", name })

export const tpl = (strings: string[], exprs: Expr[]): Expr => ({
  type: "TemplateLiteral",
  quasis: strings.map((s) => ({ value: { cooked: s } })),
  expressions: exprs,
})

export const spread = (argument: Expr): Spread => ({ type: "SpreadElement", argument })

export const arr = (...elements: (Expr | Spread | null)[]): Expr => ({ type: "ArrayExpression", elements })

export const obj = (pairs: Record<string, Expr>): Expr => ({
  type: "ObjectExpression",
  properties: Object.entries(pairs).map(([k, v]) => ({
    type: "Property" as const,
    key: id(k),
    value: v,
    computed: false,
    kind: "init",
  })),
})

// object literal with a spread element (…v) — for prototype-pollution tests
export const objSpread = (spreadFrom: Expr, pairs: Record<string, Expr> = {}): Expr => ({
  type: "ObjectExpression",
  properties: [
    { type: "SpreadElement" as const, argument: spreadFrom },
    ...Object.entries(pairs).map(([k, v]) => ({
      type: "Property" as const,
      key: id(k),
      value: v,
      computed: false,
      kind: "init",
    })),
  ],
})

export const un = (operator: string, argument: Expr): Expr => ({ type: "UnaryExpression", operator, argument, prefix: true })

export const bin = (operator: string, left: Expr, right: Expr): Expr => ({ type: "BinaryExpression", operator, left, right })

export const logic = (operator: string, left: Expr, right: Expr): Expr => ({ type: "LogicalExpression", operator, left, right })

export const cond = (test: Expr, consequent: Expr, alternate: Expr): Expr => ({
  type: "ConditionalExpression",
  test,
  consequent,
  alternate,
})

export const mem = (object: Expr, prop: string | Expr, computed = false): Expr => ({
  type: "MemberExpression",
  object,
  property: typeof prop === "string" ? id(prop) : prop,
  computed,
  optional: false,
})

export const omem = (object: Expr, prop: string): Expr => ({
  type: "MemberExpression",
  object,
  property: id(prop),
  computed: false,
  optional: true,
})

export const call = (callee: Expr, ...args: (Expr | Spread)[]): Expr => ({
  type: "CallExpression",
  callee,
  arguments: args,
})

export const arrow = (params: (string | Pattern)[], body: Expr): Expr => ({
  type: "ArrowFunctionExpression",
  params: params.map((p) => (typeof p === "string" ? ({ type: "Identifier", name: p } as Pattern) : p)),
  body,
})

// pattern builders
export const objPat = (keys: string[]): Pattern => ({
  type: "ObjectPattern",
  properties: keys.map((k) => ({
    type: "Property" as const,
    key: id(k),
    value: { type: "Identifier", name: k },
    computed: false,
    kind: "init",
  })),
})

export const arrPat = (names: (string | null)[]): Pattern => ({
  type: "ArrayPattern",
  elements: names.map((n) => (n === null ? null : ({ type: "Identifier", name: n } as Pattern))),
})
