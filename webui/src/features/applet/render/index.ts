export { AppletRenderer, type AppletRendererProps } from "./renderer"
export { deleteAppletState, fetchAppletState, saveAppletState } from "./state-client"
// NOTE: snapshotApplet (→ @zumer/snapdom, ~50 KB) is intentionally NOT re-exported here.
// The board eagerly imports this barrel, and snapDOM is only needed when a capture runs,
// so use-applet-snapshot dynamic-imports it — keeping snapDOM out of the initial bundle.
// A capture consumer (e.g. board export) should import it from "./snapshot" directly.
export { evictAppletSnapshot, getAppletSnapshot } from "./snapshot-cache"
export { useAppletSnapshot } from "./use-applet-snapshot"
export { useAppletInitialState, type AppletInitialState } from "./use-applet-initial-state"
