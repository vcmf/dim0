// Per-widget error boundary (applet-design.md §5.3). A throw from the interpreter
// or a registered component during render is contained here so one bad applet
// shows an error card instead of tearing down the board. The error is cleared when
// `resetKey` changes (e.g. the source is edited) or when the fallback calls
// `reset` (a retry), so a transient failure isn't permanently fatal.

import { Component, type ReactNode } from "react"


interface Props {
  children: ReactNode
  /** When this value changes, a captured error is cleared (recover on new source). */
  resetKey?: unknown
  fallback: (error: Error, reset: () => void) => ReactNode
}


interface State {
  error: Error | null
}


export class AppletErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  /** React error-boundary hook: capture the error into state to render the fallback. */
  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  /** Log the render error in dev; the fallback UI is driven by state. */
  componentDidCatch(error: Error): void {
    if (import.meta.env.DEV) console.error("[applet] render error", error)
  }

  /** Clear a captured error when the reset key changes (e.g. source edited). */
  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  /** Clear the error to retry rendering (bound to the fallback's retry action). */
  reset = (): void => this.setState({ error: null })

  render(): ReactNode {
    return this.state.error ? this.props.fallback(this.state.error, this.reset) : this.props.children
  }
}
