// Shared chrome for the floating node-surface panels (mini-app / applet). The
// positioning + sizing shell is identical across kinds, so it lives here once
// instead of drifting copy-by-copy in each panel.


/** Centered floating panel: fixed inset on mobile, inset from the toolbars on md+. */
export const SURFACE_PANEL_CLASS =
  "absolute left-1/2 -translate-x-1/2 top-4 bottom-4 md:top-20 md:bottom-[96px] w-[min(960px,calc(100vw-2rem))] z-[55] flex flex-col rounded-lg border bg-background shadow-xl overflow-hidden"
