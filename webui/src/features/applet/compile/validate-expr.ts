// Author-time expression validator (applet-design.md §8). Walks an acorn ESTree
// expression, enforces the SAME deny-by-default allowlist the interpreter enforces
// at runtime, and emits a clean `Expr` (spans stripped). Violations throw a
// CompileError with line/col so the agent can self-correct in the same turn.
//
// It does NOT handle JSX — a `.map(x => <li>)` returning elements is lifted to a
// list node by the transformer before it reaches here; this sees value
// expressions only.

import { BLOCKED_KEYS } from "../interpreter/safe-get"
import type { Arrow, Expr, Lit, Pattern, PatternProp, Prop, RestEl, Spread } from "../interpreter/types"
import { CompileError } from "./errors"
import { locOf, type RawNode } from "./parse"


const UNARY_OPS = new Set(["!", "-", "+", "~", "typeof"])
const BINARY_OPS = new Set([
  "+", "-", "*", "/", "%", "**",
  "==", "!=", "===", "!==",
  "<", "<=", ">", ">=",
  "&", "|", "^", "<<", ">>", ">>>",
])
const LOGICAL_OPS = new Set(["&&", "||", "??"])


export function validateExpr(node: RawNode): Expr {
  return vExpr(node, false)
}


function err(message: string, node: RawNode): CompileError {
  return new CompileError(message, locOf(node))
}


function vExpr(node: RawNode, allowArrow: boolean): Expr {
  switch (node.type) {
    case "Literal":
      return vLiteral(node)
    case "Identifier":
      return { type: "Identifier", name: node.name as string }
    case "TemplateLiteral":
      return vTemplate(node)
    case "ArrayExpression":
      return { type: "ArrayExpression", elements: vElements(node.elements as (RawNode | null)[]) }
    case "ObjectExpression":
      return { type: "ObjectExpression", properties: vObjectProps(node.properties as RawNode[]) }
    case "UnaryExpression": {
      const op = node.operator as string
      if (!UNARY_OPS.has(op)) throw err(`operator '${op}' is not allowed`, node)
      return { type: "UnaryExpression", operator: op, argument: vExpr(node.argument as RawNode, false), prefix: true }
    }
    case "BinaryExpression": {
      const op = node.operator as string
      if (!BINARY_OPS.has(op)) throw err(`operator '${op}' is not allowed`, node)
      return { type: "BinaryExpression", operator: op, left: vExpr(node.left as RawNode, false), right: vExpr(node.right as RawNode, false) }
    }
    case "LogicalExpression": {
      const op = node.operator as string
      if (!LOGICAL_OPS.has(op)) throw err(`operator '${op}' is not allowed`, node)
      return { type: "LogicalExpression", operator: op, left: vExpr(node.left as RawNode, false), right: vExpr(node.right as RawNode, false) }
    }
    case "ConditionalExpression":
      return {
        type: "ConditionalExpression",
        test: vExpr(node.test as RawNode, false),
        consequent: vExpr(node.consequent as RawNode, false),
        alternate: vExpr(node.alternate as RawNode, false),
      }
    case "MemberExpression":
      return vMember(node)
    case "CallExpression":
      return vCall(node)
    case "ChainExpression":
      // acorn wraps optional chains (`a?.b`) — unwrap to the inner member/call
      return vExpr(node.expression as RawNode, allowArrow)
    case "ArrowFunctionExpression":
      if (!allowArrow) throw err("arrow functions are only allowed as array-method arguments (e.g. .map, .filter)", node)
      return vArrow(node)
    default:
      throw err(`${node.type} is not allowed in an applet expression`, node)
  }
}


function vLiteral(node: RawNode): Lit {
  if (node.regex) throw err("regular expressions are not allowed", node)
  if (typeof node.value === "bigint") throw err("bigint literals are not allowed", node)
  return { type: "Literal", value: node.value as string | number | boolean | null }
}


function vTemplate(node: RawNode): Expr {
  const quasis = (node.quasis as RawNode[]).map((q) => ({
    value: { cooked: (q.value as { cooked: string | null }).cooked ?? "" },
  }))
  const expressions = (node.expressions as RawNode[]).map((e) => vExpr(e, false))
  return { type: "TemplateLiteral", quasis, expressions }
}


function vElements(list: (RawNode | null)[]): (Expr | Spread | null)[] {
  return list.map((el) => {
    if (el === null) return null
    if (el.type === "SpreadElement") return { type: "SpreadElement", argument: vExpr(el.argument as RawNode, false) }
    return vExpr(el, false)
  })
}


function vObjectProps(list: RawNode[]): (Prop | Spread)[] {
  return list.map((p) => {
    if (p.type === "SpreadElement") return { type: "SpreadElement", argument: vExpr(p.argument as RawNode, false) }
    if (p.type !== "Property") throw err(`${p.type} is not allowed in an object literal`, p)
    if (p.kind !== "init") throw err("object getters/setters are not allowed", p)
    if (p.method) throw err("object methods are not allowed", p)
    const computed = Boolean(p.computed)
    return { type: "Property", key: vKey(p.key as RawNode, computed), value: vExpr(p.value as RawNode, false), computed, kind: "init" }
  })
}


function vKey(key: RawNode, computed: boolean): Expr {
  if (computed) return vExpr(key, false)
  if (key.type === "Identifier") {
    if (BLOCKED_KEYS.has(key.name as string)) throw err(`forbidden key: ${key.name}`, key)
    return { type: "Identifier", name: key.name as string }
  }
  if (key.type === "Literal") {
    if (BLOCKED_KEYS.has(String(key.value))) throw err(`forbidden key: ${key.value}`, key)
    return { type: "Literal", value: key.value as string | number | boolean | null }
  }
  throw err("unsupported object key", key)
}


function vMember(node: RawNode): Expr {
  const object = vExpr(node.object as RawNode, false)
  const computed = Boolean(node.computed)
  const optional = Boolean(node.optional)
  if (computed) {
    return { type: "MemberExpression", object, property: vExpr(node.property as RawNode, false), computed, optional }
  }
  const prop = node.property as RawNode
  if (prop.type !== "Identifier") throw err("unsupported member access", prop)
  if (BLOCKED_KEYS.has(prop.name as string)) throw err(`forbidden property access: ${prop.name}`, prop)
  return { type: "MemberExpression", object, property: { type: "Identifier", name: prop.name as string }, computed, optional }
}


function vCall(node: RawNode): Expr {
  const callee = node.callee as RawNode
  if (callee.type !== "Identifier" && callee.type !== "MemberExpression") {
    throw err("only method calls and whitelisted functions may be called", callee)
  }
  const args: (Expr | Spread)[] = (node.arguments as RawNode[]).map((a) => {
    if (a.type === "SpreadElement") return { type: "SpreadElement", argument: vExpr(a.argument as RawNode, false) }
    return vExpr(a, true) // arrows allowed only here
  })
  return { type: "CallExpression", callee: vExpr(callee, false), arguments: args, optional: Boolean(node.optional) }
}


function vArrow(node: RawNode): Arrow {
  if (node.async) throw err("async arrow functions are not allowed", node)
  const params = (node.params as RawNode[]).map(vPattern)
  const body = node.body as RawNode
  if (body.type === "BlockStatement") throw err("arrow bodies must be a single expression (no { … } block)", body)
  return { type: "ArrowFunctionExpression", params, body: vExpr(body, false) }
}


function vPattern(node: RawNode): Pattern {
  switch (node.type) {
    case "Identifier":
      return { type: "Identifier", name: node.name as string }
    case "ObjectPattern":
      return { type: "ObjectPattern", properties: (node.properties as RawNode[]).map(vPatternProp) }
    case "ArrayPattern":
      return { type: "ArrayPattern", elements: (node.elements as (RawNode | null)[]).map((e) => (e === null ? null : vPattern(e))) }
    case "AssignmentPattern":
      return { type: "AssignmentPattern", left: vPattern(node.left as RawNode), right: vExpr(node.right as RawNode, false) }
    case "RestElement":
      return { type: "RestElement", argument: vPattern(node.argument as RawNode) }
    default:
      throw err(`unsupported parameter pattern: ${node.type}`, node)
  }
}


function vPatternProp(node: RawNode): PatternProp | RestEl {
  if (node.type === "RestElement") return { type: "RestElement", argument: vPattern(node.argument as RawNode) }
  if (node.type !== "Property") throw err(`${node.type} is not allowed in a destructuring pattern`, node)
  const computed = Boolean(node.computed)
  return { type: "Property", key: vKey(node.key as RawNode, computed), value: vPattern(node.value as RawNode), computed, kind: "init" }
}
