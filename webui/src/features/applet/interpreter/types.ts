// AST types for the applet interpreter — a strict, validated subset of ESTree for
// expressions (applet-design.md §8) plus the action AST for event handlers (§9).
// Node `type` strings match ESTree verbatim, so the Phase-1 transformer can feed
// acorn's output (spans stripped) straight in; the evaluator reads only the fields
// declared here and rejects every node type not in this union.

export type Expr =
  | Lit
  | Ident
  | Tpl
  | ArrExpr
  | ObjExpr
  | Unary
  | Binary
  | Logical
  | Conditional
  | Member
  | Call
  | Arrow


export interface Lit {
  type: "Literal"
  value: string | number | boolean | null
}


export interface Ident {
  type: "Identifier"
  name: string
}


export interface Tpl {
  type: "TemplateLiteral"
  quasis: { value: { cooked: string | null } }[]
  expressions: Expr[]
}


export interface Spread {
  type: "SpreadElement"
  argument: Expr
}


export interface ArrExpr {
  type: "ArrayExpression"
  elements: (Expr | Spread | null)[]
}


export interface Prop {
  type: "Property"
  key: Expr
  value: Expr
  computed: boolean
  kind: string
}


export interface ObjExpr {
  type: "ObjectExpression"
  properties: (Prop | Spread)[]
}


export interface Unary {
  type: "UnaryExpression"
  operator: string
  argument: Expr
  prefix: boolean
}


export interface Binary {
  type: "BinaryExpression"
  operator: string
  left: Expr
  right: Expr
}


export interface Logical {
  type: "LogicalExpression"
  operator: string
  left: Expr
  right: Expr
}


export interface Conditional {
  type: "ConditionalExpression"
  test: Expr
  consequent: Expr
  alternate: Expr
}


export interface Member {
  type: "MemberExpression"
  object: Expr
  property: Expr
  computed: boolean
  optional?: boolean
}


export interface Call {
  type: "CallExpression"
  callee: Expr
  arguments: (Expr | Spread)[]
  optional?: boolean
}


export interface Arrow {
  type: "ArrowFunctionExpression"
  params: Pattern[]
  body: Expr
}


// Destructuring patterns for arrow params (§8.6). `AssignmentPattern` (param
// defaults) is allowed ONLY here — it is not a general assignment expression.
export type Pattern = Ident | ObjectPattern | ArrayPattern | AssignPattern | RestEl


export interface PatternProp {
  type: "Property"
  key: Expr
  value: Pattern
  computed: boolean
  kind: string
}


export interface ObjectPattern {
  type: "ObjectPattern"
  properties: (PatternProp | RestEl)[]
}


export interface ArrayPattern {
  type: "ArrayPattern"
  elements: (Pattern | null)[]
}


export interface AssignPattern {
  type: "AssignmentPattern"
  left: Pattern
  right: Expr
}


export interface RestEl {
  type: "RestElement"
  argument: Pattern
}


// Action AST — event-handler behavior (§9). `path` is always a validated static
// string (never an expression); `arg`/`guard` are expressions.
export type Action =
  | { do: "set"; path: string; arg: Expr }
  | { do: "toggle"; path: string }
  | { do: "append"; path: string; arg: Expr }
  | { do: "toast"; arg: Expr; level?: "info" | "error" }
  | { do: "batch"; actions: Action[] }
  | { guard: Expr; then: Action; else?: Action }


// Identifier scope. A Map (not a plain object) so lookups never touch a prototype
// chain and keys like "__proto__" are ordinary entries.
export type Env = Map<string, unknown>
