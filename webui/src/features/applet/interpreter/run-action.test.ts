import { describe, expect, it } from "vitest"

import { makeCtx } from "./eval-expr"
import { runHandler, type StateObject } from "./run-action"
import type { Action } from "./types"
import { arrow, bin, call, id, lit, mem, obj } from "./test-ast"


const applyH = (action: Action, state: StateObject, extra: Record<string, unknown> = {}) =>
  runHandler(action, new Map(Object.entries({ ...state, ...extra })), state, makeCtx())


describe("verbs", () => {
  it("set writes an expression result and leaves the source state untouched", () => {
    const state = { count: 0 }
    const { state: next } = applyH({ do: "set", path: "count", arg: bin("+", id("count"), lit(1)) }, state)
    expect(next.count).toBe(1)
    expect(state.count).toBe(0) // immutable
  })

  it("toggle flips a boolean", () => {
    expect(applyH({ do: "toggle", path: "open" }, { open: false }).state.open).toBe(true)
  })

  it("append pushes onto an array immutably", () => {
    const state = { items: [] as unknown[], draft: "a" }
    const { state: next } = applyH({ do: "append", path: "items", arg: obj({ text: id("draft") }) }, state)
    expect(next.items).toEqual([{ text: "a" }])
    expect(state.items).toEqual([])
  })

  it("toast collects a message without changing state", () => {
    const { state: next, toasts } = applyH({ do: "toast", arg: lit("saved"), level: "info" }, { a: 1 })
    expect(toasts).toEqual([{ message: "saved", level: "info" }])
    expect(next).toEqual({ a: 1 })
  })

  it("batch threads state through several actions", () => {
    const action: Action = {
      do: "batch",
      actions: [
        { do: "append", path: "items", arg: id("draft") },
        { do: "set", path: "draft", arg: lit("") },
      ],
    }
    const { state: next } = applyH(action, { items: ["x"], draft: "y" })
    expect(next).toEqual({ items: ["x", "y"], draft: "" })
  })
})


describe("guarded actions", () => {
  const setEnter: Action = {
    guard: bin("===", id("key"), lit("Enter")),
    then: { do: "set", path: "hit", arg: lit(true) },
  }

  it("runs `then` when the guard holds", () => {
    expect(applyH(setEnter, { hit: false }, { key: "Enter" }).state.hit).toBe(true)
  })

  it("no-ops when the guard fails and there is no else", () => {
    expect(applyH(setEnter, { hit: false }, { key: "a" }).state.hit).toBe(false)
  })

  it("runs `else` when provided", () => {
    const branch: Action = {
      guard: id("ok"),
      then: { do: "set", path: "v", arg: lit(1) },
      else: { do: "set", path: "v", arg: lit(2) },
    }
    expect(applyH(branch, { v: 0 }, { ok: false }).state.v).toBe(2)
  })
})


describe("paths", () => {
  it("sets a nested path immutably, preserving siblings", () => {
    const state = { user: { name: "a", age: 1 } }
    const { state: next } = applyH({ do: "set", path: "user.name", arg: lit("b") }, state)
    expect(next.user).toEqual({ name: "b", age: 1 })
    expect(state.user.name).toBe("a")
  })

  it("sets a static array index, preserving the array", () => {
    const state = { items: [{ done: false }, { done: false }] }
    const { state: next } = applyH({ do: "set", path: "items.0.done", arg: lit(true) }, state)
    expect(Array.isArray(next.items)).toBe(true)
    expect(next.items).toEqual([{ done: true }, { done: false }])
    expect(state.items[0].done).toBe(false)
  })

  it("rejects a forbidden path segment", () => {
    expect(() => applyH({ do: "set", path: "__proto__.x", arg: lit(1) }, {})).toThrow(/forbidden path segment/)
  })
})


describe("real-world patterns", () => {
  it("removes an array item via set + immutable filter (the §9.1 idiom)", () => {
    const remove: Action = {
      do: "set",
      path: "items",
      arg: call(mem(id("items"), "filter"), arrow(["x"], bin("!==", mem(id("x"), "id"), lit(2)))),
    }
    const { state: next } = applyH(remove, { items: [{ id: 1 }, { id: 2 }, { id: 3 }] })
    expect(next.items).toEqual([{ id: 1 }, { id: 3 }])
  })

  it("reads a sanitized $event field", () => {
    const { state: next } = applyH({ do: "set", path: "draft", arg: mem(id("$event"), "value") }, { draft: "" }, {
      $event: { value: "typed" },
    })
    expect(next.draft).toBe("typed")
  })
})
