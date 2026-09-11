// Red-team suite — the audit that replaces the iframe sandbox (applet-design.md
// §5.1). Every fixture is an attempted escape (reach real code / the prototype
// chain / a host global) or a denial-of-service. All MUST be rejected or bounded.
// A regression here is a security regression; this file is a permanent CI gate.

import { describe, expect, it } from "vitest"

import { evalExpr, makeCtx } from "./eval-expr"
import { AppletError } from "./errors"
import type { Env, Expr } from "./types"
import { arr, arrow, bin, call, id, lit, mem, obj, objPat, objSpread, spread, un } from "./test-ast"


const E = (scope: Record<string, unknown> = {}): Env => new Map(Object.entries(scope))
const run = (node: Expr, scope: Record<string, unknown> = {}): unknown => evalExpr(node, E(scope), makeCtx())

// Raw node of a type outside the grammar (the transformer would reject these, but
// the evaluator must reject them too — defense in depth).
const raw = (type: string, extra: Record<string, unknown> = {}): Expr => ({ type, ...extra }) as unknown as Expr


describe("prototype-chain escapes", () => {
  it("blocks .constructor (static)", () => {
    expect(() => run(mem(arr(lit(1)), "constructor"))).toThrow(/forbidden property access/)
  })

  it("blocks .constructor (computed)", () => {
    expect(() => run(mem(arr(lit(1)), lit("constructor"), true))).toThrow(/forbidden property access/)
  })

  it("blocks __proto__ and prototype", () => {
    expect(() => run(mem(obj({}), "__proto__"))).toThrow(/forbidden property access/)
    expect(() => run(mem(id("f"), "prototype"), { f: {} })).toThrow(/forbidden property access/)
  })

  it("blocks the classic [].constructor.constructor(...)() RCE at the first hop", () => {
    const attack = call(mem(mem(mem(arr(), "constructor"), "constructor"), lit("return 1"), false))
    expect(() => run(attack)).toThrow(/forbidden property access/)
  })

  it("does not leak a method as a first-class value", () => {
    // reading `[].map` (not calling it) must yield undefined, never the function
    expect(run(mem(arr(lit(1)), "map"))).toBeUndefined()
    expect(run(mem(lit("s"), "toUpperCase"))).toBeUndefined()
  })

  it("blocks calling a forbidden method name", () => {
    expect(() => run(call(mem(arr(lit(1)), "constructor")))).toThrow(/forbidden method/)
  })
})


describe("prototype pollution", () => {
  it("rejects a literal __proto__ key", () => {
    const node = raw("ObjectExpression", {
      properties: [{ type: "Property", key: id("__proto__"), value: obj({ x: lit(1) }), computed: false, kind: "init" }],
    })
    expect(() => run(node)).toThrow(/forbidden object key/)
  })

  it("rejects a computed __proto__ key", () => {
    const node = raw("ObjectExpression", {
      properties: [{ type: "Property", key: lit("__proto__"), value: lit(1), computed: true, kind: "init" }],
    })
    expect(() => run(node)).toThrow(/forbidden object key/)
    // global Object.prototype stays clean
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  it("rejects a __proto__ destructuring key", () => {
    const attack = call(mem(arr(obj({})), "map"), arrow([objPat(["__proto__"])], lit(1)))
    expect(() => run(attack)).toThrow(/forbidden destructuring key/)
  })

  it("drops __proto__ when spreading into an object literal", () => {
    // {...evil} must not copy an own "__proto__" data key onto the result's proto
    const evil = { ["__proto__"]: { polluted: true } }
    const node = raw("ObjectExpression", { properties: [{ type: "SpreadElement", argument: id("e") }] })
    const out = run(node, { e: evil }) as Record<string, unknown>
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
  })
})


describe("host globals are unreachable", () => {
  it.each(["window", "globalThis", "process", "Function", "eval", "require", "document"])(
    "undefined reference: %s",
    (name) => {
      expect(() => run(id(name))).toThrow(/undefined reference/)
    },
  )

  it("calling a non-whitelisted global throws", () => {
    expect(() => run(call(id("eval"), lit("2+2")))).toThrow(/non-whitelisted/)
  })
})


// Regression: the whitelist tables are plain object literals, so `in`/bracket
// access would match inherited Object.prototype names (constructor, toString, …).
// Every lookup uses Object.hasOwn — these must all be rejected, not resolved.
describe("inherited Object.prototype names are not a backdoor", () => {
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"])(
    "bare identifier `%s` is undefined",
    (name) => {
      expect(() => run(id(name))).toThrow(/undefined reference/)
    },
  )

  it.each(["constructor", "toString", "valueOf"])("calling `%s()` is not whitelisted", (name) => {
    expect(() => run(call(id(name)))).toThrow(/non-whitelisted/)
  })

  it("hasOwnProperty(x) is not whitelisted", () => {
    expect(() => run(call(id("hasOwnProperty"), lit("x")))).toThrow(/non-whitelisted/)
  })

  it.each(["toString", "valueOf", "hasOwnProperty", "constructor"])(
    "Math.%s(...) is an unknown method",
    (method) => {
      expect(() => run(call(mem(id("Math"), method), lit("x")))).toThrow(/unknown Math method|forbidden method/)
    },
  )
})


describe("disallowed node types are rejected (defense in depth)", () => {
  it.each(["NewExpression", "AssignmentExpression", "UpdateExpression", "SequenceExpression", "FunctionExpression", "TaggedTemplateExpression", "AwaitExpression"])(
    "%s",
    (type) => {
      expect(() => run(raw(type))).toThrow(/unsupported expression/)
    },
  )

  it("rejects the `in` and `instanceof` operators", () => {
    expect(() => run(bin("in", lit("x"), obj({})))).toThrow(/unsupported binary operator/)
    expect(() => run(bin("instanceof", id("o"), id("o")), { o: {} })).toThrow(/unsupported binary operator/)
  })

  it("rejects delete / void unary operators", () => {
    expect(() => run(un("delete", id("o")), { o: {} })).toThrow(/unsupported unary operator/)
    expect(() => run(un("void", lit(1)))).toThrow(/unsupported unary operator/)
  })
})


describe("denial-of-service is bounded", () => {
  it("caps array-method input length", () => {
    const big = { xs: new Array(10_001).fill(0) }
    expect(() => run(call(mem(id("xs"), "map"), arrow(["x"], id("x"))), big)).toThrow(/array length/)
  })

  it("caps huge string construction (repeat / padStart)", () => {
    expect(() => run(call(mem(lit("a"), "repeat"), lit(200_000)))).toThrow(/string length/)
    expect(() => run(call(mem(lit("a"), "padStart"), lit(200_000), lit("x")))).toThrow(/string length/)
  })

  it("caps expression depth", () => {
    let deep: Expr = lit(1)
    for (let i = 0; i < 200; i++) deep = un("!", deep)
    expect(() => run(deep)).toThrow(/too deep|too many operations/)
  })

  it("caps total operations (nested maps)", () => {
    const scope = { xs: new Array(400).fill(0), ys: new Array(400).fill(0) }
    const inner = call(mem(id("ys"), "map"), arrow(["y"], id("y")))
    const outer = call(mem(id("xs"), "map"), arrow(["x"], inner))
    expect(() => run(outer, scope)).toThrow(/too many operations/)
  })

  it("rejects spreading a non-array", () => {
    expect(() => run(arr(spread(lit(5))))).toThrow(/spread of a non-array/)
  })

  it("caps a huge array spread into a namespace call (Math.max(...huge))", () => {
    const big = { xs: new Array(10_001).fill(1) }
    expect(() => run(call(mem(id("Math"), "max"), spread(id("xs"))), big)).toThrow(/array length/)
  })

  it("caps a huge object spread ({...bigObject})", () => {
    const huge: Record<string, number> = {}
    for (let i = 0; i < 10_001; i++) huge["k" + i] = 1
    expect(() => run(objSpread(id("h")), { h: huge })).toThrow(/array length/)
  })
})


// Native methods can throw TypeError/RangeError; the interpreter must convert
// those to AppletError so the renderer's graceful-degradation catch always applies
// (errors.ts). A native error escaping here would tear down the board.
describe("AppletError-only contract holds for native throws", () => {
  it("[].reduce(fn) with no initial value throws AppletError, not TypeError", () => {
    const sum = arrow(["a", "b"], bin("+", id("a"), id("b")))
    expect(() => run(call(mem(arr(), "reduce"), sum))).toThrow(AppletError)
  })

  it("toFixed with an out-of-range digit count throws AppletError", () => {
    expect(() => run(call(mem(lit(5), "toFixed"), lit(500)))).toThrow(AppletError)
  })

  it("toString with an out-of-range radix throws AppletError", () => {
    expect(() => run(call(mem(lit(5), "toString"), lit(100)))).toThrow(AppletError)
  })
})
