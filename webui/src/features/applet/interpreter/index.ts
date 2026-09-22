// Public API of the applet interpreter (Phase 0). Pure — no React, no board.
// The Phase-1 transformer produces the `Expr`/`Action` inputs; the Phase-2
// renderer consumes `evalExpr`/`runHandler` to render an applet tree inline.

export { evalExpr, makeCtx, truthy, type Ctx } from "./eval-expr"
export { runHandler, type HandlerResult, type StateObject, type Toast } from "./run-action"
export { AppletError } from "./errors"
export { Budget, LIMITS } from "./budget"
export type { Action, Env, Expr, Pattern } from "./types"
