import {
  AppletUrl,
  CodeSandboxUrl,
  LocalAppletUrl,
  LocalCodeSandboxUrl,
  LocalMiniAppUrl,
  LocalSheetUrl,
  LocalWidgetUrl,
  MiniAppUrl,
  SheetUrl,
  WidgetUrl,
} from "@/routes"
import type { NodeSurfaceKind } from "../harness/store/board-app-store"


/**
 * Map a node-surface kind to its URL path. The dialog system shares one
 * sub-tree under the board route — only the path segment (`sheets`,
 * `code-sandbox`, `widgets`, `mini-apps`, `applets`) differs per kind. `local`
 * selects the `/local/$boardId/*` mirror of the synced `/boards/$id/*` routes.
 */
export function nodeSurfacePath(kind: NodeSurfaceKind, local = false): string {
  switch (kind) {
    case "sheet": return local ? LocalSheetUrl : SheetUrl
    case "code-sandbox": return local ? LocalCodeSandboxUrl : CodeSandboxUrl
    case "widget": return local ? LocalWidgetUrl : WidgetUrl
    case "mini-app": return local ? LocalMiniAppUrl : MiniAppUrl
    case "applet": return local ? LocalAppletUrl : AppletUrl
  }
}


/**
 * Detect a node-surface kind from a URL pathname. Returns `null` if the
 * pathname doesn't match any of the dialog routes — caller should treat
 * that as "no surface open".
 */
export function nodeSurfaceKindFromPath(pathname: string): NodeSurfaceKind | null {
  if (pathname.includes("/sheets/")) return "sheet"
  if (pathname.includes("/code-sandbox/")) return "code-sandbox"
  if (pathname.includes("/widgets/")) return "widget"
  if (pathname.includes("/mini-apps/")) return "mini-app"
  if (pathname.includes("/applets/")) return "applet"
  return null
}
