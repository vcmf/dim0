import { useEffect, useRef, useState } from "react"
import {
  ChevronDownIcon,
  CircleClusterIcon,
  CircleShapeIcon,
  ConnectorPathIcon,
  CursorSelectIcon,
  DiamondShapeIcon,
  EraserIcon,
  GraphViewIcon,
  GridViewIcon,
  HandGrabIcon,
  HandPanIcon,
  LayerStackIcon,
  ListViewIcon,
  NotepadIcon,
  PencilEditIcon,
  PresentationIcon,
  ShapesMenuIcon,
  SquareShapeIcon,
  TagIcon,
  TextTIcon,
  WeatherCloudIcon,
} from "@/components/icons"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Slider } from "@/components/ui/slider"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { isWebKitWebview } from "@/platform"
import { useBoardAppStore } from "../store/board-app-store"
import { HarnessToolbarMore } from "./toolbar-more"


type ShapeTool = {
  id: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  shortcut?: string
}


/**
 * All built-in canvas-harness shape tools the user can pick from the
 * Shapes dropdown. Order + icon choices mirror prod's `top-bar.tsx`
 * shapeOptions. Tool ids are canvas-harness names (see
 * `convert/node-type.ts` for the dim0↔canvas mapping).
 */
const SHAPE_TOOLS: ReadonlyArray<ShapeTool> = [
  { id: "rect", label: "Rectangle", icon: SquareShapeIcon, shortcut: "R" },
  { id: "layered-rect", label: "Layered card", icon: LayerStackIcon },
  { id: "ellipse", label: "Ellipse", icon: CircleShapeIcon, shortcut: "O" },
  { id: "diamond", label: "Diamond", icon: DiamondShapeIcon, shortcut: "D" },
  { id: "soft-diamond", label: "Double diamond", icon: DiamondShapeIcon },
  { id: "layered-diamond", label: "Layered diamond", icon: LayerStackIcon },
  { id: "layered-ellipse", label: "Layered circle", icon: CircleClusterIcon },
  { id: "tag", label: "Tag", icon: TagIcon },
  { id: "thought-cloud", label: "Cloud", icon: WeatherCloudIcon },
  { id: "capsule", label: "Capsule", icon: TagIcon },
]


const SHAPE_TOOL_IDS = new Set(SHAPE_TOOLS.map((t) => t.id))


// The `border` width sits on EVERY state so toggling a visible border on
// hover/active doesn't shift the icon — the border COLOR carries the
// affordance and is set per-state (not on the base): these strings are
// assigned straight to `className` and never pass through tailwind-merge, so a
// base `border-transparent` would collide with the active `border-…/30` and
// win by CSS source order — swallowing the active border entirely.
//
// Hover is a lighter preview (translucent fill + faint border); active is the
// full-strength fill + border, so the two states read distinctly.
const baseButtonClass =
  "transition-colors !p-2.5 rounded-lg flex items-center justify-center gap-2 border"
const inactiveClass = `${baseButtonClass} border-transparent text-card-foreground hover:bg-secondary/50 hover:text-secondary-foreground hover:border-secondary-foreground/20`
const activeClass = `${baseButtonClass} border-secondary-foreground/30 bg-secondary text-secondary-foreground`


/**
 * Compact keyboard hint badge in the corner of a tool button.
 */
const ShortcutHint = ({ shortcut }: { shortcut: string }) => (
  <span className="pointer-events-none absolute -bottom-1 -right-1 px-0 text-[9px] font-semibold leading-none text-muted-foreground/80">
    {shortcut}
  </span>
)


/**
 * Floating tool tray for the canvas-harness board — center-top. Mirrors
 * prod's `TopBar` styling (sidebar surface, rounded-xl, blurred bg) and
 * icon set while preserving the harness's tool-mode contract (each
 * button sets `tool` on board-app-store; canvas-harness reacts to it).
 */
const VIEW_OPTIONS = [
  { id: "board" as const, label: "Board", icon: GraphViewIcon },
  { id: "files" as const, label: "Files", icon: GridViewIcon },
  { id: "list" as const, label: "List", icon: ListViewIcon },
]


const TRAY_H = 46
const TRAY_R = 13


/**
 * SVG silhouette for the toolbar "tray": concave top corners that flare OUTWARD
 * to the top edge, convex rounded bottom corners, open top. One path, sized to
 * the measured content width so the corners stay circular at any width.
 */
const trayPath = (w: number, h: number, r: number): string =>
  `M0 0 A${r} ${r} 0 0 1 ${r} ${r}` +
  ` L${r} ${h - r} A${r} ${r} 0 0 0 ${2 * r} ${h}` +
  ` L${w - 2 * r} ${h} A${r} ${r} 0 0 0 ${w - r} ${h - r}` +
  ` L${w - r} ${r} A${r} ${r} 0 0 1 ${w} 0`


/**
 * Toolbar shell shaped as a flared tray docked to the top edge. The blurred,
 * themed fill is clipped to the path; a hairline SVG stroke draws the outline;
 * a drop-shadow (stronger on hover) follows the silhouette. Width is measured
 * from the content row so the path fits the current toolbar exactly.
 */
function FlaredTray({
  children,
  className,
  ...rest
}: { children: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  const rowRef = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  const [hover, setHover] = useState(false)
  // WebKit webviews only (see isWebKitWebview) — Windows/Chromium keeps the blur.
  const webkit = isWebKitWebview()

  useEffect(() => {
    const el = rowRef.current
    if (!el) return
    // Measure the BORDER box (offsetWidth) so the tray path spans the full row
    // incl. its horizontal padding. contentRect excludes padding, which drew the
    // path ~32px short and let the rightmost ("…") button spill past the border.
    const ro = new ResizeObserver(() => setW(el.offsetWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const d = w > 0 ? trayPath(w, TRAY_H, TRAY_R) : ""

  return (
    <div
      className={cn("absolute left-1/2 top-0 z-50 -translate-x-1/2", className)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...rest}
    >
      <div className="relative">
        {d && (
          <>
            {/* Frosted backdrop. CRITICAL: nothing above this in the tree may set
                `filter`/`opacity`/`mask` — such an ancestor becomes a "backdrop
                root" and silently no-ops backdrop-filter (the blur had nothing to
                sample). So the drop-shadow lives on the sibling tint layer below,
                never on a wrapper.
                SKIPPED on WebKit webviews (macOS/Linux): `backdrop-filter`
                re-samples the canvas behind the tray every pan frame, a real jank
                source there — the tint below goes near-opaque instead. Kept on
                Windows/Chromium (cheap) and web. */}
            {!webkit && (
              <div
                className="pointer-events-none absolute inset-0 backdrop-blur-xl backdrop-saturate-[1.8]"
                style={{ clipPath: `path('${d}')` }}
              />
            )}
            {/* Translucent tint + the tray's drop-shadow. A sibling of the blur
                layer (not an ancestor), so it doesn't isolate the backdrop. On
                WebKit it carries the fill alone (near-opaque, no blur). */}
            <div
              className={cn("pointer-events-none absolute inset-0", webkit ? "bg-sidebar/95" : "bg-sidebar/60")}
              style={{
                clipPath: `path('${d}')`,
                filter: hover
                  ? "drop-shadow(0 10px 22px rgba(0,0,0,0.22))"
                  : "drop-shadow(0 2px 5px rgba(0,0,0,0.10))",
                transition: "filter .2s ease",
              }}
            />
            <svg
              className="pointer-events-none absolute inset-0"
              width={w}
              height={TRAY_H}
              style={{ overflow: "visible" }}
              aria-hidden
            >
              <path d={d} fill="none" stroke="var(--border)" strokeWidth={1} />
            </svg>
          </>
        )}
        {/* px chosen so the first/last button sit ~5px inside the tray's side
            border (x = TRAY_R), matching the ~5px top/bottom gap → balanced. */}
        <div ref={rowRef} className="relative flex items-center gap-1 px-[18px]" style={{ height: TRAY_H }}>
          {children}
        </div>
      </div>
    </div>
  )
}


export function HarnessToolbar({ local = false }: { local?: boolean } = {}) {
  const tool = useBoardAppStore((s) => s.tool)
  const setTool = useBoardAppStore((s) => s.setTool)
  const inkColor = useBoardAppStore((s) => s.inkColor)
  const setInkColor = useBoardAppStore((s) => s.setInkColor)
  const inkSize = useBoardAppStore((s) => s.inkSize)
  const setInkSize = useBoardAppStore((s) => s.setInkSize)
  const chromeDialog = useBoardAppStore((s) => s.chromeDialog)
  const setChromeDialog = useBoardAppStore((s) => s.setChromeDialog)
  const slidesPanelOpen = useBoardAppStore((s) => s.slidesPanelOpen)
  const setSlidesPanelOpen = useBoardAppStore((s) => s.setSlidesPanelOpen)
  const viewMode = useBoardAppStore((s) => s.viewMode)
  const setViewMode = useBoardAppStore((s) => s.setViewMode)
  // Controlled so the trigger can show hover feedback normally and flip to the
  // active style only while its menu is open (uncontrolled gives no open signal
  // for styling, and the nested Tooltip/Dropdown triggers both write
  // `data-state`, so a `data-[state=open]:` variant would be ambiguous).
  const [viewMenuOpen, setViewMenuOpen] = useState(false)

  const isBoard = viewMode === "board"
  const isPan = tool === "pan"
  const isSelect = tool === "select"
  const isShape = SHAPE_TOOL_IDS.has(tool)
  const ActiveShape = SHAPE_TOOLS.find((s) => s.id === tool)?.icon ?? ShapesMenuIcon
  const shapeMenuOpen = chromeDialog === "shape-menu"
  const activeView = VIEW_OPTIONS.find((v) => v.id === viewMode) ?? VIEW_OPTIONS[0]
  const ActiveViewIcon = activeView.icon

  return (
    <FlaredTray
      className="text-sidebar-foreground"
      role="toolbar"
      aria-label="Board toolbar"
      data-coachmark="toolbar"
    >
      <DropdownMenu open={viewMenuOpen} onOpenChange={setViewMenuOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Change view"
                aria-pressed={viewMenuOpen}
                className={viewMenuOpen ? activeClass : inactiveClass}
              >
                <ActiveViewIcon className="size-4 shrink-0" weight="fill" />
                <span className="sr-only text-[10px] md:not-sr-only">
                  {activeView.label}
                </span>
                <ChevronDownIcon className="hidden size-3 shrink-0 text-muted-foreground md:block" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={10}>Change view</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" side="bottom" sideOffset={8} className="min-w-[160px]">
          {VIEW_OPTIONS.map((option) => {
            const Icon = option.icon
            return (
              <DropdownMenuItem
                key={option.id}
                onSelect={() => setViewMode(option.id)}
                className="gap-2 text-sm"
              >
                <Icon
                  className="size-4 shrink-0"
                  weight={option.id === viewMode ? "fill" : undefined}
                />
                <span>{option.label}</span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <Separator orientation="vertical" className="hidden md:!h-6 md:block" />

      {/*
        Canvas-only tools are hidden in non-board view modes. The
        view dropdown and the More menu (create-only actions) stay
        visible everywhere so users can navigate + create from any
        surface.
      */}
      {isBoard && (
      <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setTool("pan")}
            aria-label="Pan"
            aria-pressed={isPan}
            className={isPan ? activeClass : inactiveClass}
          >
            <div className="relative">
              {isPan ? (
                <HandGrabIcon className="size-4 shrink-0" weight="fill" />
              ) : (
                <HandPanIcon className="size-4 shrink-0" />
              )}
              <ShortcutHint shortcut="P" />
            </div>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={10}>Pan</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setTool("select")}
            aria-label="Select"
            aria-pressed={isSelect}
            className={isSelect ? activeClass : inactiveClass}
          >
            <div className="relative">
              <CursorSelectIcon
                className="size-4 shrink-0"
                weight={isSelect ? "fill" : undefined}
              />
              <ShortcutHint shortcut="V" />
            </div>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={10}>Select</TooltipContent>
      </Tooltip>

      <div className="flex items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setTool("ink")}
              aria-label="Pen"
              aria-pressed={tool === "ink"}
              className={tool === "ink" ? activeClass : inactiveClass}
            >
              <PencilEditIcon className="size-4 shrink-0" weight={tool === "ink" ? "fill" : undefined} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={10}>Pen</TooltipContent>
        </Tooltip>
        {tool === "ink" && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Pen settings"
                className="ml-0.5 flex size-6 items-center justify-center rounded-md hover:bg-secondary/60"
              >
                <span
                  className="size-3 rounded-full border border-foreground/20"
                  style={{ backgroundColor: inkColor }}
                />
              </button>
            </PopoverTrigger>
            <PopoverContent side="bottom" sideOffset={10} className="w-56 space-y-4">
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>Color</span>
                <input
                  type="color"
                  value={inkColor}
                  onChange={(event) => setInkColor(event.target.value)}
                  className="h-8 w-12 cursor-pointer rounded border border-border bg-transparent p-0.5"
                />
              </label>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span>Width</span>
                  <span className="text-muted-foreground">{inkSize}px</span>
                </div>
                <Slider
                  min={1}
                  max={24}
                  step={1}
                  value={[inkSize]}
                  onValueChange={([value]) => setInkSize(value)}
                  aria-label="Pen width"
                />
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setTool("eraser")}
            aria-label="Eraser"
            aria-pressed={tool === "eraser"}
            className={tool === "eraser" ? activeClass : inactiveClass}
          >
            <EraserIcon className="size-4 shrink-0" weight={tool === "eraser" ? "fill" : undefined} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={10}>Eraser</TooltipContent>
      </Tooltip>

      <Separator orientation="vertical" className="hidden md:!h-6 md:block" />

      <DropdownMenu
        open={shapeMenuOpen}
        onOpenChange={(open) => setChromeDialog(open ? "shape-menu" : null)}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Add shape"
                className={isShape ? activeClass : inactiveClass}
              >
                <div className="relative flex flex-col items-center gap-0.5">
                  <ActiveShape
                    className="size-4 shrink-0"
                    weight={isShape ? "fill" : undefined}
                  />
                  <ShortcutHint shortcut="S" />
                  <ChevronDownIcon className="absolute inset-x-0 -bottom-3.5 size-3 text-muted-foreground" />
                </div>
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={10}>Shapes</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="center" side="bottom" sideOffset={8} className="min-w-[180px]">
          {SHAPE_TOOLS.map((s) => {
            const Icon = s.icon
            return (
              <DropdownMenuItem
                key={s.id}
                onSelect={() => setTool(s.id)}
                className="gap-2 text-sm"
              >
                <Icon className="size-4 shrink-0" />
                <span>{s.label}</span>
                {s.shortcut ? <DropdownMenuShortcut>{s.shortcut}</DropdownMenuShortcut> : null}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setTool("arrow")}
            aria-label="Connector"
            aria-pressed={tool === "arrow"}
            className={tool === "arrow" ? activeClass : inactiveClass}
          >
            <div className="relative">
              <ConnectorPathIcon
                className="size-4 shrink-0"
                weight={tool === "arrow" ? "fill" : undefined}
              />
              <ShortcutHint shortcut="A" />
            </div>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={10}>Connector</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setTool("text")}
            aria-label="Text"
            aria-pressed={tool === "text"}
            className={tool === "text" ? activeClass : inactiveClass}
          >
            <div className="relative">
              <TextTIcon
                className="size-4 shrink-0"
                weight={tool === "text" ? "fill" : undefined}
              />
              <ShortcutHint shortcut="T" />
            </div>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={10}>Text</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setTool("sheet")}
            aria-label="Note"
            aria-pressed={tool === "sheet"}
            className={tool === "sheet" ? activeClass : inactiveClass}
          >
            <div className="relative">
              <NotepadIcon
                className="size-4 shrink-0"
                weight={tool === "sheet" ? "fill" : undefined}
              />
              <ShortcutHint shortcut="N" />
            </div>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={10}>Note</TooltipContent>
      </Tooltip>

      <Separator orientation="vertical" className="hidden md:!h-6 md:block" />

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setSlidesPanelOpen(!slidesPanelOpen)}
            aria-label="Slides"
            aria-pressed={slidesPanelOpen}
            className={slidesPanelOpen ? activeClass : inactiveClass}
          >
            <div className="relative">
              <PresentationIcon
                className="size-4 shrink-0"
                weight={slidesPanelOpen ? "fill" : undefined}
              />
              <ShortcutHint shortcut="M" />
            </div>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={10}>Slides</TooltipContent>
      </Tooltip>

      <Separator orientation="vertical" className="hidden md:!h-6 md:block" />
      </>
      )}

      <HarnessToolbarMore local={local} />
    </FlaredTray>
  )
}
