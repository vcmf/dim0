// Per-widget error boundary (applet-design.md §5.3). A throw from the interpreter
// during render is contained here so one bad applet shows an error card instead of
// tearing down the board; the host and sibling widgets keep rendering.

import { Component, type ReactNode } from "react"


interface Props {
  children: ReactNode
  fallback: (error: Error) => ReactNode
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

  render(): ReactNode {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children
  }
}
