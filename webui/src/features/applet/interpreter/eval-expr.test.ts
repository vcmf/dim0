import { describe, expect, it } from "vitest"

import { evalExpr, makeCtx } from "./eval-expr"
import type { Env, Expr } from "./types"
import {
  arr,
  arrow,
  arrPat,
  bin,
  call,
  cond,
  id,
  lit,
  logic,
  mem,
  obj,
  objPat,
  omem,
  spread,
  tpl,
  un,
} from "./test-ast"


const E = (scope: Record<string, unknown> = {}): Env => new Map(Object.entries(scope))
const run = (node: Expr, scope: Record<string, unknown> = {}): unknown => evalExpr(node, E(scope), makeCtx())


describe("literals & operators", () => {
  it("arithmetic respects precedence", () => {
    expect(run(bin("+", lit(1), bin("*", lit(2), lit(3))))).toBe(7)
  })

  it("+ concatenates when either side is a string", () => {
    expect(run(bin("+", lit("a"), lit("b")))).toBe("ab")
    expect(run(bin("+", lit(1), lit("x")))).toBe("1x")
  })

  it("unary ! - + ~ typeof", () => {
    expect(run(un("!", lit(0)))).toBe(true)
    expect(run(un("-", lit(3)))).toBe(-3)
    expect(run(un("typeof", lit("s")))).toBe("string")
  })

  it("typeof of an unbound identifier is 'undefined' (matches JS)", () => {
    expect(run(un("typeof", id("missing")))).toBe("undefined")
    expect(run(bin("===", un("typeof", id("x")), lit("undefined")))).toBe(true)
    // but a bound identifier still reports its real type
    expect(run(un("typeof", id("x")), { x: 5 })).toBe("number")
  })

  it("comparisons and equality", () => {
    expect(run(bin("<", lit(1), lit(2)))).toBe(true)
    expect(run(bin("===", lit(1), lit(1)))).toBe(true)
    expect(run(bin("!==", lit(1), lit("1")))).toBe(true)
  })

  it("logical && || ?? short-circuit and return operands", () => {
    expect(run(logic("&&", lit(1), lit(2)))).toBe(2)
    expect(run(logic("||", lit(0), lit("fallback")))).toBe("fallback")
    expect(run(logic("??", lit(null), lit("d")))).toBe("d")
    expect(run(logic("??", lit(0), lit("d")))).toBe(0)
  })

  it("ternary", () => {
    expect(run(cond(lit(true), lit("yes"), lit("no")))).toBe("yes")
  })

  it("template literals interleave", () => {
    expect(run(tpl(["a=", "!"], [id("x")]), { x: 2 })).toBe("a=2!")
  })
})


describe("identifiers & scope", () => {
  it("resolves a scope variable", () => {
    expect(run(id("count"), { count: 5 })).toBe(5)
  })

  it("throws on an undefined reference", () => {
    expect(() => run(id("missing"))).toThrow(/undefined reference/)
  })
})


describe("member access", () => {
  it("reads object and array members, length, and string index", () => {
    expect(run(mem(obj({ a: lit(1) }), "a"))).toBe(1)
    expect(run(mem(arr(lit(10), lit(20)), lit(1), true))).toBe(20)
    expect(run(mem(id("xs"), "length"), { xs: [1, 2, 3] })).toBe(3)
    expect(run(mem(lit("hi"), lit(0), true))).toBe("h")
  })

  it("optional chaining stops at null/undefined", () => {
    expect(run(omem(id("u"), "name"), { u: null })).toBeUndefined()
  })
})


describe("literals with spread", () => {
  it("array spread", () => {
    expect(run(arr(lit(1), spread(id("xs")), lit(4)), { xs: [2, 3] })).toEqual([1, 2, 3, 4])
  })

  it("object build", () => {
    expect(run(obj({ a: lit(1), b: id("x") }), { x: 9 })).toEqual({ a: 1, b: 9 })
  })
})


describe("globals", () => {
  it("Math methods incl. spread args", () => {
    expect(run(call(mem(id("Math"), "max"), spread(id("nums"))), { nums: [1, 5, 2] })).toBe(5)
    expect(run(call(mem(id("Math"), "round"), lit(2.6)))).toBe(3)
  })

  it("Object.keys / Array.isArray", () => {
    expect(run(call(mem(id("Object"), "keys"), id("o")), { o: { a: 1, b: 2 } })).toEqual(["a", "b"])
    expect(run(call(mem(id("Array"), "isArray"), id("xs")), { xs: [] })).toBe(true)
  })

  it("coercions Number/String/Boolean", () => {
    expect(run(call(id("Number"), lit("3")))).toBe(3)
    expect(run(call(id("String"), lit(4)))).toBe("4")
  })

  it("cn helper merges class names (incl. a falsy conditional)", () => {
    expect(run(call(id("cn"), lit("a"), lit("b")))).toBe("a b")
    expect(run(call(id("cn"), lit("a"), logic("&&", lit(false), lit("hidden"))))).toBe("a")
  })
})


describe("array higher-order methods", () => {
  const xs = { xs: [1, 2, 3, 4] }

  it("map", () => {
    expect(run(call(mem(id("xs"), "map"), arrow(["x"], bin("*", id("x"), lit(10)))), xs)).toEqual([10, 20, 30, 40])
  })

  it("filter with index param", () => {
    const even = arrow(["x"], bin("===", bin("%", id("x"), lit(2)), lit(0)))
    expect(run(call(mem(id("xs"), "filter"), even), xs)).toEqual([2, 4])
  })

  it("reduce with initial value", () => {
    const sum = arrow(["a", "b"], bin("+", id("a"), id("b")))
    expect(run(call(mem(id("xs"), "reduce"), sum, lit(0)), xs)).toBe(10)
  })

  it("find / some / every", () => {
    expect(run(call(mem(id("xs"), "find"), arrow(["x"], bin(">", id("x"), lit(2)))), xs)).toBe(3)
    expect(run(call(mem(id("xs"), "some"), arrow(["x"], bin(">", id("x"), lit(3)))), xs)).toBe(true)
    expect(run(call(mem(id("xs"), "every"), arrow(["x"], bin(">", id("x"), lit(0)))), xs)).toBe(true)
  })

  it("sort does not mutate the source", () => {
    const src = [3, 1, 2]
    const desc = arrow(["a", "b"], bin("-", id("b"), id("a")))
    expect(run(call(mem(id("xs"), "sort"), desc), { xs: src })).toEqual([3, 2, 1])
    expect(src).toEqual([3, 1, 2])
  })
})


describe("destructuring params", () => {
  it("object pattern", () => {
    const rows = { rows: [{ v: 1 }, { v: 2 }] }
    expect(run(call(mem(id("rows"), "map"), arrow([objPat(["v"])], id("v"))), rows)).toEqual([1, 2])
  })

  it("array pattern", () => {
    const pairs = { pairs: [[1, 2], [3, 4]] }
    expect(run(call(mem(id("pairs"), "map"), arrow([arrPat(["a", "b"])], bin("+", id("a"), id("b")))), pairs)).toEqual([
      3, 7,
    ])
  })
})


describe("string & number methods", () => {
  it("string methods", () => {
    expect(run(call(mem(lit("hello"), "toUpperCase")))).toBe("HELLO")
    expect(run(call(mem(lit("a,b,c"), "split"), lit(",")))).toEqual(["a", "b", "c"])
    expect(run(call(mem(lit("5"), "padStart"), lit(3), lit("0")))).toBe("005")
  })

  it("number methods", () => {
    expect(run(call(mem(lit(3.14159), "toFixed"), lit(2)))).toBe("3.14")
  })
})


describe("rejections", () => {
  it("a bare arrow outside a higher-order method throws", () => {
    expect(() => run(arrow(["x"], id("x")))).toThrow(/arrow functions are allowed only/)
  })

  it("an unknown array method throws", () => {
    expect(() => run(call(mem(arr(lit(1)), "forEach"), arrow(["x"], id("x"))))).toThrow(/unknown array method/)
  })
})
