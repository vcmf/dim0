// The serialized applet tree (applet-design.md §6) — the transformer's output and
// the Phase-2 renderer's input. Structure uses our own compact node kinds;
// expressions/actions reuse the interpreter's validated ESTree subset.

import type { Action, Expr } from "./interpreter/types"


export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }


export interface AppletTree {
  v: 1
  scopes: {
    state?: Record<string, JsonValue>
    data?: Record<string, JsonValue>
    derived?: Record<string, Expr>
  }
  persist?: boolean
  root: Node
}


export type Node = ElNode | TxtNode | ListNode | CondNode


export interface ElNode {
  k: "el"
  tag: string
  /** Literal attributes. */
  props?: Record<string, JsonValue>
  /** Attributes whose value is an expression, evaluated per render. */
  bind?: Record<string, Expr>
  /** Event handlers: event name (no "on" prefix) → guarded action. */
  on?: Record<string, Action>
  children?: Node[]
}


export interface TxtNode {
  k: "txt"
  /** A literal string, OR… */
  v?: string
  /** …a dynamic expression. Exactly one of `v` / `x` is set. */
  x?: Expr
}


/** From `src.map((item, index) => <tpl>)`. */
export interface ListNode {
  k: "list"
  src: Expr
  item: string
  index?: string
  tpl: Node
}


/** From `test ? <then> : <else>` or `test && <then>`. */
export interface CondNode {
  k: "cond"
  test: Expr
  then: Node
  else?: Node
}
