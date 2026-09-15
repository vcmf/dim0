export { AppletRenderer, type AppletRendererProps } from "./renderer"
export { deleteAppletState, fetchAppletState, saveAppletState } from "./state-client"
// NOTE: snapshotApplet (→ @zumer/snapdom, ~50 KB) is intentionally NOT re-exported here.
// The board eagerly imports this barrel, and snapDOM is only needed on demand (PNG/SVG
// export of selected nodes), so an export consumer imports it from "./snapshot" directly
// — keeping snapDOM out of the initial bundle.
export { useAppletInitialState, type AppletInitialState } from "./use-applet-initial-state"
