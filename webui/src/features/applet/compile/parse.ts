// acorn + acorn-jsx wrapper. Parses applet JSX source to an ESTree (with
// locations, so downstream errors carry line/col). Pure, runs client-side.

import { Parser } from "acorn"
import jsx from "acorn-jsx"

import { CompileError } from "./errors"


const JsxParser = Parser.extend(jsx())


// A loose view of an ESTree/JSX node — the transformer narrows by `type` and reads
// only the fields it needs, so it tolerates acorn's extra fields.
export interface RawNode {
  type: string
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } }
  [key: string]: unknown
}


// Parse applet JSX source into an ESTree Program (with locations). Wraps acorn's
// syntax errors as CompileError so callers get a uniform, positioned failure.
export function parseSource(source: string): RawNode {
  try {
    return JsxParser.parse(source, {
      ecmaVersion: 2022,
      sourceType: "module",
      locations: true,
    }) as unknown as RawNode
  } catch (e) {
    const err = e as { message?: string; loc?: { line: number; column: number } }
    throw new CompileError(err.message ?? "syntax error", err.loc)
  }
}


/** Read a node's 1-based line + 0-based column for error reporting. */
export function locOf(node: RawNode): { line: number; column: number } | undefined {
  return node.loc?.start
}
