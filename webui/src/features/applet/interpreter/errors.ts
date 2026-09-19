// The single error type the interpreter throws. Callers (the Phase-2 renderer)
// catch it to degrade a widget gracefully (applet-design.md §5.3) rather than
// letting a bad expression tear down the board.

export class AppletError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AppletError"
  }
}
