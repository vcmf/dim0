// Public entry to the applet compiler (Phase 1). `compileApplet` turns JSX source
// into the §6 tree (the renderer's input); `validateApplet` is the thin ok/error
// gate the write_note tool calls so the agent self-corrects in the same turn.

import type { AppletTree } from "../tree"
import { CompileError } from "./errors"
import { parseSource, type RawNode } from "./parse"
import { transform } from "./transform"


export type CompileResult =
  | { ok: true; tree: AppletTree }
  | { ok: false; message: string; line?: number; column?: number }


export function compileApplet(source: string): CompileResult {
  try {
    const program = parseSource(source)
    const tree = transform(extractRootElement(program))
    return { ok: true, tree }
  } catch (e) {
    if (e instanceof CompileError) return { ok: false, message: e.message, line: e.line, column: e.column }
    // deeply-nested source can overflow the parser/transformer stack — return a
    // result rather than throwing out of the write_note gate.
    if (e instanceof RangeError) return { ok: false, message: "the applet is nested too deeply" }
    throw e
  }
}


export type Validation = { ok: true } | { ok: false; message: string; line?: number; column?: number }


export function validateApplet(source: string): Validation {
  const r = compileApplet(source)
  return r.ok ? { ok: true } : { ok: false, message: r.message, line: r.line, column: r.column }
}


// The applet source is a single `<Widget>` expression — a one-statement Program.
function extractRootElement(program: RawNode): RawNode {
  const body = (program.body as RawNode[]).filter((s) => s.type !== "EmptyStatement")
  if (body.length !== 1 || body[0].type !== "ExpressionStatement") {
    throw new CompileError("an applet must be a single <Widget> … </Widget> expression")
  }
  return (body[0] as RawNode).expression as RawNode
}
