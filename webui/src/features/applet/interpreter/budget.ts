// Runtime budgets that guarantee an expression terminates and can never freeze
// the host thread (applet-design.md §8.8, §5.1). One Budget instance is threaded
// through a single evaluation; every node visit spends one op.

import { AppletError } from "./errors"


export const LIMITS = {
  ops: 100_000, // total node visits per evaluation
  depth: 64, // max expression / recursion depth
  arrayLen: 10_000, // max input length for any array method
  stringLen: 100_000, // max result length for repeat / padStart / padEnd
} as const


export class Budget {
  private ops = 0

  /** Spend one operation; throws once the op ceiling is crossed. */
  tick(): void {
    if (++this.ops > LIMITS.ops) {
      throw new AppletError("budget exceeded: too many operations")
    }
  }

  checkDepth(depth: number): void {
    if (depth > LIMITS.depth) {
      throw new AppletError("budget exceeded: expression nested too deep")
    }
  }

  checkArray(len: number): void {
    if (len > LIMITS.arrayLen) {
      throw new AppletError(`budget exceeded: array length ${len} > ${LIMITS.arrayLen}`)
    }
  }

  checkString(len: number): void {
    if (len > LIMITS.stringLen) {
      throw new AppletError(`budget exceeded: string length ${len} > ${LIMITS.stringLen}`)
    }
  }
}
