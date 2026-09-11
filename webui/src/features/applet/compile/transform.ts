// The JSX → §6 tree transformer. Walks the acorn/JSX tree of a `<Widget>` root:
// reads the state/data/derived/persist scopes, then compiles the child structure —
// elements to `el`, `.map(x => <JSX>)` to `list`, ternary/`&&` with JSX to `cond`,
// text/`{expr}` to `txt`, attributes to literal props / expr binds / action
// handlers. All expressions/actions go through the §8/§9 validators.

import type { Expr } from "../interpreter/types"
import { EVENT_HANDLERS, FORBIDDEN_ATTRS, isKnownTag } from "../registry"
import type { AppletTree, CondNode, ElNode, JsonValue, ListNode, Node, TxtNode } from "../tree"
import { compileAction } from "./compile-action"
import { CompileError } from "./errors"
import { locOf, type RawNode } from "./parse"
import { validateExpr } from "./validate-expr"


export function transform(root: RawNode): AppletTree {
  if (root.type !== "JSXElement") {
    throw new CompileError("an applet must be a single <Widget> … </Widget> element", locOf(root))
  }
  const opening = root.openingElement as RawNode
  const name = jsxName(opening.name as RawNode, root)
  if (name !== "Widget") throw new CompileError(`the root element must be <Widget>, not <${name}>`, locOf(root))

  const { scopes, persist } = readWidgetAttrs(opening.attributes as RawNode[])
  const kids = elementChildren(root.children as RawNode[])
  if (kids.length !== 1) throw new CompileError("<Widget> must wrap exactly one child element", locOf(root))

  const tree: AppletTree = { v: 1, scopes, root: compileNode(kids[0]) }
  if (persist) tree.persist = true
  return tree
}


// ---- <Widget> scopes ----

function readWidgetAttrs(attrs: RawNode[]): { scopes: AppletTree["scopes"]; persist: boolean } {
  const scopes: AppletTree["scopes"] = {}
  let persist = false

  for (const attr of attrs) {
    if (attr.type !== "JSXAttribute") throw new CompileError("spread attributes are not allowed on <Widget>", locOf(attr))
    const an = jsxAttrName(attr)
    if (an === "persist") {
      if ((attr.value ?? null) !== null) throw new CompileError("`persist` is a boolean flag — write it bare, not persist={…}", locOf(attr))
      persist = true
    } else if (an === "state" || an === "data") {
      const lit = asLiteralJson(attrExpr(attr, an))
      if (!lit || typeof lit.value !== "object" || lit.value === null || Array.isArray(lit.value)) {
        throw new CompileError(`\`${an}\` must be a literal object, e.g. ${an}={{ count: 0 }}`, locOf(attr))
      }
      scopes[an] = lit.value as Record<string, JsonValue>
    } else if (an === "derived") {
      scopes.derived = derivedObject(attrExpr(attr, an))
    } else {
      throw new CompileError(`unknown <Widget> attribute '${an}' (allowed: state, data, derived, persist)`, locOf(attr))
    }
  }
  return { scopes, persist }
}


function derivedObject(node: RawNode): Record<string, Expr> {
  if (node.type !== "ObjectExpression") throw new CompileError("`derived` must be an object of expressions", locOf(node))
  const out: Record<string, Expr> = {}
  for (const p of node.properties as RawNode[]) {
    if (p.type !== "Property" || p.computed) throw new CompileError("`derived` keys must be plain names", locOf(p))
    out[keyName(p.key as RawNode)] = validateExpr(p.value as RawNode)
  }
  return out
}


// ---- structure nodes ----

function compileNode(node: RawNode): Node {
  if (node.type !== "JSXElement") throw new CompileError("expected an element here", locOf(node))
  const opening = node.openingElement as RawNode
  const tag = jsxName(opening.name as RawNode, node)
  if (!isKnownTag(tag)) {
    throw new CompileError(`unknown component <${tag}> — not a known applet component or HTML element`, locOf(node))
  }

  const el: ElNode = { k: "el", tag }
  const props: Record<string, JsonValue> = {}
  const bind: Record<string, Expr> = {}
  const on: ElNode["on"] = {}

  for (const attr of opening.attributes as RawNode[]) {
    if (attr.type === "JSXSpreadAttribute") throw new CompileError("spread attributes are not allowed", locOf(attr))
    const an = jsxAttrName(attr)
    if (FORBIDDEN_ATTRS.has(an)) throw new CompileError(`the '${an}' attribute is not allowed`, locOf(attr))

    if (an.startsWith("on")) {
      if (!EVENT_HANDLERS.has(an)) throw new CompileError(`event handler '${an}' is not allowed`, locOf(attr))
      on![an.slice(2).toLowerCase()] = compileAction(attrExpr(attr, an))
      continue
    }

    const v = attrValue(attr)
    if (v.kind === "literal") props[an] = v.value
    else bind[an] = v.expr
  }

  if (Object.keys(props).length) el.props = props
  if (Object.keys(bind).length) el.bind = bind
  if (on && Object.keys(on).length) el.on = on
  const children = compileChildren(node.children as RawNode[])
  if (children.length) el.children = children
  return el
}


function compileChildren(children: RawNode[]): Node[] {
  const out: Node[] = []
  for (const child of children) {
    if (child.type === "JSXText") {
      const text = (child.value as string).replace(/\s+/g, " ")
      if (text.trim() === "") continue
      out.push({ k: "txt", v: text })
    } else if (child.type === "JSXElement") {
      out.push(compileNode(child))
    } else if (child.type === "JSXExpressionContainer") {
      const node = compileChild(child.expression as RawNode)
      if (node) out.push(node)
    } else if (child.type === "JSXFragment") {
      throw new CompileError("fragments <>…</> are not supported — use a wrapper element", locOf(child))
    } else {
      throw new CompileError(`unsupported child: ${child.type}`, locOf(child))
    }
  }
  return out
}


// A child expression: a list (`.map`), a conditional element, an inline element,
// or a value → text. Returns null for a `{/* comment */}`.
function compileChild(expr: RawNode): Node | null {
  if (expr.type === "JSXEmptyExpression") return null
  if (expr.type === "JSXElement") return compileNode(expr)
  if (expr.type === "JSXFragment") throw new CompileError("fragments <>…</> are not supported — use a wrapper element", locOf(expr))

  const list = asMapList(expr)
  if (list) return list

  if (expr.type === "ConditionalExpression" && (isJsx(expr.consequent as RawNode) || isJsx(expr.alternate as RawNode))) {
    const cond: CondNode = {
      k: "cond",
      test: validateExpr(expr.test as RawNode),
      then: compileBranch(expr.consequent as RawNode),
    }
    const alt = compileBranchOpt(expr.alternate as RawNode)
    if (alt) cond.else = alt
    return cond
  }

  if (expr.type === "LogicalExpression" && expr.operator === "&&" && isJsx(expr.right as RawNode)) {
    return { k: "cond", test: validateExpr(expr.left as RawNode), then: compileBranch(expr.right as RawNode) }
  }

  const txt: TxtNode = { k: "txt", x: validateExpr(expr) }
  return txt
}


// `src.map((item, index) => <JSX>)` → list node. Returns null when it's not a
// JSX-returning map (then it's an ordinary value expression, handled as text).
function asMapList(expr: RawNode): ListNode | null {
  if (expr.type !== "CallExpression") return null
  const callee = expr.callee as RawNode
  if (callee.type !== "MemberExpression" || callee.computed) return null
  if ((callee.property as RawNode).name !== "map") return null
  const args = expr.arguments as RawNode[]
  if (args.length !== 1 || args[0].type !== "ArrowFunctionExpression") return null

  const arrow = args[0]
  const body = arrow.body as RawNode
  if (body.type !== "JSXElement") return null // value-returning map → not a list

  const params = arrow.params as RawNode[]
  if (!params[0] || params[0].type !== "Identifier") {
    throw new CompileError("the .map item parameter must be a simple name, e.g. items.map(item => …)", locOf(arrow))
  }
  const list: ListNode = {
    k: "list",
    src: validateExpr(callee.object as RawNode),
    item: params[0].name as string,
    tpl: compileNode(body),
  }
  if (params[1]) {
    if (params[1].type !== "Identifier") throw new CompileError("the .map index parameter must be a simple name", locOf(arrow))
    list.index = params[1].name as string
  }
  return list
}


function compileBranch(node: RawNode): Node {
  if (node.type === "JSXElement") return compileNode(node)
  return { k: "txt", x: validateExpr(node) }
}


function compileBranchOpt(node: RawNode): Node | null {
  if (node.type === "Literal" && node.value === null) return null
  return compileBranch(node)
}


// ---- attributes ----

type AttrValue = { kind: "literal"; value: JsonValue } | { kind: "expr"; expr: Expr }

function attrValue(attr: RawNode): AttrValue {
  const value = (attr.value ?? null) as RawNode | null
  if (value === null) return { kind: "literal", value: true } // boolean attr, e.g. `disabled`
  if (value.type === "Literal") return { kind: "literal", value: value.value as JsonValue }
  if (value.type === "JSXExpressionContainer") {
    const expr = value.expression as RawNode
    if (expr.type === "JSXEmptyExpression") throw new CompileError("empty attribute expression", locOf(value))
    const lit = asLiteralJson(expr)
    return lit ? { kind: "literal", value: lit.value } : { kind: "expr", expr: validateExpr(expr) }
  }
  throw new CompileError("unsupported attribute value", locOf(value))
}


// ---- literal JSON extraction (state/data + literal props) ----

function asLiteralJson(node: RawNode): { value: JsonValue } | null {
  switch (node.type) {
    case "Literal":
      if (node.regex || typeof node.value === "bigint") return null
      return { value: node.value as JsonValue }
    case "UnaryExpression": {
      const inner = asLiteralJson(node.argument as RawNode)
      if (!inner || typeof inner.value !== "number") return null
      if (node.operator === "-") return { value: -inner.value }
      if (node.operator === "+") return { value: +inner.value }
      return null
    }
    case "ArrayExpression": {
      const out: JsonValue[] = []
      for (const el of node.elements as (RawNode | null)[]) {
        if (el === null || el.type === "SpreadElement") return null
        const v = asLiteralJson(el)
        if (!v) return null
        out.push(v.value)
      }
      return { value: out }
    }
    case "ObjectExpression": {
      const out: Record<string, JsonValue> = {}
      for (const p of node.properties as RawNode[]) {
        if (p.type !== "Property" || p.computed || p.kind !== "init") return null
        const v = asLiteralJson(p.value as RawNode)
        if (!v) return null
        out[keyName(p.key as RawNode)] = v.value
      }
      return { value: out }
    }
    default:
      return null
  }
}


// ---- JSX name helpers ----

function isJsx(node: RawNode): boolean {
  return node.type === "JSXElement" || node.type === "JSXFragment"
}


function jsxName(name: RawNode, at: RawNode): string {
  if (name.type !== "JSXIdentifier") throw new CompileError("namespaced/member element names are not supported", locOf(at))
  return name.name as string
}


function jsxAttrName(attr: RawNode): string {
  const name = attr.name as RawNode
  if (name.type !== "JSXIdentifier") throw new CompileError("namespaced attributes are not supported", locOf(attr))
  return name.name as string
}


function attrExpr(attr: RawNode, name: string): RawNode {
  const value = (attr.value ?? null) as RawNode | null
  if (!value || value.type !== "JSXExpressionContainer") {
    throw new CompileError(`\`${name}\` must be an expression, e.g. ${name}={…}`, locOf(attr))
  }
  return value.expression as RawNode
}


function keyName(key: RawNode): string {
  if (key.type === "Identifier") return key.name as string
  if (key.type === "Literal") return String(key.value)
  throw new CompileError("unsupported key", locOf(key))
}


function elementChildren(children: RawNode[]): RawNode[] {
  return children.filter((c) => {
    if (c.type === "JSXText") return (c.value as string).trim() !== ""
    if (c.type === "JSXExpressionContainer") return (c.expression as RawNode).type !== "JSXEmptyExpression"
    return true
  })
}
