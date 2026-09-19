// Author-time compile error with a source position, so the agent can self-correct
// in the same turn (applet-design.md §8.9, §10).

export interface Loc {
  line: number
  column: number
}


export class CompileError extends Error {
  line?: number
  column?: number

  constructor(message: string, loc?: Loc) {
    super(message)
    this.name = "CompileError"
    this.line = loc?.line
    this.column = loc?.column
  }
}
