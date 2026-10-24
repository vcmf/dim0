import { type ReactElement, useMemo } from "react"
import type { Arrowhead, PathStyle, Style as CanvasStyle } from "@canvas-harness/core"
import { Label } from "@/components/ui/label"
import { Card, CardContent } from "@/components/ui/card"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  TextAlignCenterIcon,
  TextAlignRightIcon,
  TextParagraphIcon,
} from "@/components/icons"
import { useTheme } from "@/components/theme-provider"
import { darkModeDisplayHex } from "@/features/board/lib/colors/dark-variants"
import { SloppyPresets, StrokeWidthPresets, TRANSPARENT_HEX } from "@/features/board/types/style"
import type {
  FontFamily,
  FontSizePreset,
  StrokeStyle,
  TextAlign,
} from "@/features/board/types/style"
import { cn } from "@/lib/utils"
import { ColorGrid } from "./color-panel"
import { ARROWHEAD_OPTIONS, PATH_STYLE_OPTIONS } from "./edge-glyph-options"
import { ArrowheadGlyph, PathStyleGlyph } from "./edge-glyphs"
import { FontSizeInput } from "./font-size-input"


// canvas-harness's Style augmented with edge-only fields (arrowheads,
// pathStyle) so the panel can drive both kinds from one snapshot.
// `pathStyle` lives on the Edge itself (not in style) — the sidebar's
// dispatch helper splits the patch on commit. `roundness` only varies
// 0..1 in canvas-harness but Dim0 historically uses 0/2; convert layer
// clamps for us.
export type StylePanelStyle = CanvasStyle & {
  sourceArrowhead?: Arrowhead
  targetArrowhead?: Arrowhead
  pathStyle?: PathStyle
}


export type StylePanelProps = {
  /** Tells the panel which feature set to expose. */
  kind: "node" | "edge"
  style: StylePanelStyle
  onStyleChange: (next: Partial<StylePanelStyle>) => void
  className?: string
}


type SettingKey =
  | "strokeColor"
  | "backgroundColor"
  | "textColor"
  | "strokeWidth"
  | "strokeStyle"
  | "roughness"
  | "roundness"
  | "textAlign"
  | "fontFamily"
  | "fontSize"
  | "pathStyle"
  | "sourceArrowhead"
  | "targetArrowhead"


const SETTING_TITLES: Record<SettingKey, string> = {
  strokeColor: "Border color",
  backgroundColor: "Background",
  textColor: "Text color",
  strokeWidth: "Stroke width",
  strokeStyle: "Stroke style",
  roughness: "Sloppiness",
  roundness: "Roundness",
  textAlign: "Text align",
  fontFamily: "Font family",
  fontSize: "Font size",
  pathStyle: "Path style",
  sourceArrowhead: "Source arrowhead",
  targetArrowhead: "Target arrowhead",
}


const NODE_SETTING_ORDER: SettingKey[] = [
  "strokeColor",
  "backgroundColor",
  "textColor",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "roundness",
  "textAlign",
  "fontFamily",
  "fontSize",
]


const EDGE_SETTING_ORDER: SettingKey[] = [
  "strokeColor",
  "textColor",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "pathStyle",
  "sourceArrowhead",
  "targetArrowhead",
  "fontFamily",
  "fontSize",
]


const resolveDisplay = (color: string | null | undefined, isDark: boolean): string | null =>
  isDark ? (darkModeDisplayHex(color) ?? color ?? null) : (color ?? null)


function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground">{title}</Label>
      {children}
    </div>
  )
}


function ColorDot({ color }: { color?: string | null }) {
  return (
    <span
      className="inline-flex size-6 rounded-sm border border-border/60"
      style={{ backgroundColor: color ?? "transparent" }}
    />
  )
}


function LineGlyph({ width = 2, dash }: { width?: number; dash?: number[] }) {
  return (
    <svg width="24" height="14" viewBox="0 0 24 14" className="text-foreground/80">
      <line
        x1="2"
        y1="7"
        x2="22"
        y2="7"
        stroke="currentColor"
        strokeWidth={width}
        strokeLinecap="round"
        strokeDasharray={dash?.join(", ")}
      />
    </svg>
  )
}


function WavyGlyph({ amount }: { amount: number }) {
  return (
    <svg width="24" height="14" viewBox="0 0 24 14" className="text-foreground/80">
      <path
        d={`M2 7 C6 ${7 - amount}, 10 ${7 + amount}, 14 ${7 - amount} S 22 ${7 + amount}, 22 7`}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  )
}


function CornerGlyph({ r }: { r: 0 | 3 }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" className="text-foreground/80">
      <rect
        x="4"
        y="4"
        width="16"
        height="16"
        rx={r * 2}
        ry={r * 2}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
      />
    </svg>
  )
}


function RailButton({
  title,
  indicator,
}: {
  title: string
  indicator: React.ReactNode
}): ReactElement {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors",
        "text-muted-foreground hover:border-border/60 hover:bg-muted/30 hover:text-foreground",
      )}
    >
      <span className="truncate font-sans text-xs font-normal">{title}</span>
      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center">
        {indicator}
      </span>
    </button>
  )
}


/**
 * Rail-style style panel — rows are popover triggers, content opens on
 * the right when clicked. Adapted from dim0's panel.tsx; covers both
 * node + edge styling. The dispatcher (`onStyleChange`) is responsible
 * for routing edge-only fields (pathStyle, arrowheads) and for the
 * stored↔displayed color split — see `sidebar.tsx`.
 */
export function StylePanel({
  kind,
  style,
  onStyleChange,
  className,
}: StylePanelProps): ReactElement {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === "dark"
  const s = style
  const ORDER = kind === "edge" ? EDGE_SETTING_ORDER : NODE_SETTING_ORDER

  const settingIndicator = useMemo<Record<SettingKey, React.ReactNode>>(
    () => ({
      strokeColor: <ColorDot color={resolveDisplay(s.strokeColor, isDark)} />,
      backgroundColor: <ColorDot color={resolveDisplay(s.backgroundColor, isDark)} />,
      textColor: <ColorDot color={resolveDisplay(s.textColor, isDark)} />,
      strokeWidth: <LineGlyph width={s.strokeWidth ?? 2} />,
      pathStyle: <PathStyleGlyph kind={s.pathStyle ?? "bezier"} />,
      sourceArrowhead: <ArrowheadGlyph kind={s.sourceArrowhead ?? "none"} flip />,
      targetArrowhead: <ArrowheadGlyph kind={s.targetArrowhead ?? "arrow-filled"} />,
      strokeStyle: (
        <LineGlyph
          width={2}
          dash={
            s.strokeStyle === "dashed"
              ? [6, 4]
              : s.strokeStyle === "dotted"
                ? [1, 5]
                : undefined
          }
        />
      ),
      roughness: <WavyGlyph amount={(s.roughness ?? 0) * 4} />,
      roundness: <CornerGlyph r={(s.roundness ?? 0) >= 1 ? 3 : 0} />,
      textAlign:
        s.textAlign === "center" ? (
          <TextAlignCenterIcon className="size-4" />
        ) : s.textAlign === "right" ? (
          <TextAlignRightIcon className="size-4" />
        ) : (
          <TextParagraphIcon className="size-4" />
        ),
      fontFamily: (
        <span className="inline-flex size-6 items-center justify-center rounded-sm border border-border/60 text-xs font-normal">
          Aa
        </span>
      ),
      fontSize: (
        <span className="inline-flex size-6 items-center justify-center rounded-sm border border-border/60 text-[10px] font-normal">
          {s.fontSize ?? "M"}
        </span>
      ),
    }),
    [s, isDark],
  )

  const settingContent: Record<SettingKey, React.ReactNode> = {
    strokeColor: (
      <Section title="Border color">
        <ColorGrid
          value={s.strokeColor}
          onPick={(v) => onStyleChange({ strokeColor: v ?? TRANSPARENT_HEX })}
          allowTransparent
          variant="compact"
        />
      </Section>
    ),
    backgroundColor: (
      <Section title="Background color">
        <ColorGrid
          value={s.backgroundColor ?? null}
          onPick={(v) => onStyleChange({ backgroundColor: v ?? TRANSPARENT_HEX })}
          allowTransparent
          variant="compact"
        />
      </Section>
    ),
    textColor: (
      <Section title="Text color">
        <ColorGrid
          value={s.textColor}
          onPick={(v) => onStyleChange({ textColor: v ?? undefined })}
          variant="compact"
        />
      </Section>
    ),
    strokeWidth: (
      <Section title="Stroke width">
        <ToggleGroup
          type="single"
          value={String(s.strokeWidth ?? 2)}
          onValueChange={(v) => v && onStyleChange({ strokeWidth: Number(v) })}
          className="flex flex-wrap gap-2"
        >
          {StrokeWidthPresets.map((w) => (
            <ToggleGroupItem
              key={w}
              value={String(w)}
              className="h-9 w-9 items-center justify-center rounded-md border bg-muted text-muted-foreground data-[state=on]:bg-secondary-foreground/10 data-[state=on]:text-secondary-foreground"
            >
              <LineGlyph width={w} />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Section>
    ),
    strokeStyle: (
      <Section title="Stroke style">
        <ToggleGroup
          type="single"
          value={s.strokeStyle ?? "solid"}
          onValueChange={(v) => v && onStyleChange({ strokeStyle: v as StrokeStyle })}
          className="flex flex-wrap gap-2"
        >
          <ToggleGroupItem
            value="solid"
            className="h-9 w-9 items-center justify-center rounded-md border bg-muted text-muted-foreground data-[state=on]:bg-secondary-foreground/10 data-[state=on]:text-secondary-foreground"
          >
            <LineGlyph width={2} />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="dashed"
            className="h-9 w-9 items-center justify-center rounded-md border bg-muted text-muted-foreground data-[state=on]:bg-secondary-foreground/10 data-[state=on]:text-secondary-foreground"
          >
            <LineGlyph width={2} dash={[6, 4]} />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="dotted"
            className="h-9 w-9 items-center justify-center rounded-md border bg-muted text-muted-foreground data-[state=on]:bg-secondary-foreground/10 data-[state=on]:text-secondary-foreground"
          >
            <LineGlyph width={2} dash={[1, 5]} />
          </ToggleGroupItem>
        </ToggleGroup>
      </Section>
    ),
    roughness: (
      <Section title="Sloppiness">
        <ToggleGroup
          type="single"
          value={String(s.roughness ?? 0)}
          onValueChange={(v) => v && onStyleChange({ roughness: Number(v) })}
          className="flex flex-wrap gap-2"
        >
          {SloppyPresets.map((val) => (
            <ToggleGroupItem
              key={val}
              value={String(val)}
              className="h-9 w-9 items-center justify-center rounded-md border bg-muted text-muted-foreground data-[state=on]:bg-secondary-foreground/10 data-[state=on]:text-secondary-foreground"
            >
              <WavyGlyph amount={val * 4} />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Section>
    ),
    roundness: (
      <Section title="Roundness">
        <ToggleGroup
          type="single"
          value={String((s.roundness ?? 0) >= 1 ? 3 : 0)}
          onValueChange={(v) => v && onStyleChange({ roundness: Number(v) })}
          className="flex gap-2"
        >
          <ToggleGroupItem
            value="0"
            className="h-9 w-9 items-center justify-center rounded-md border bg-muted data-[state=on]:bg-secondary-foreground/10 data-[state=on]:text-secondary-foreground"
          >
            <CornerGlyph r={0} />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="3"
            className="h-9 w-9 items-center justify-center rounded-md border bg-muted data-[state=on]:bg-secondary-foreground/10 data-[state=on]:text-secondary-foreground"
          >
            <CornerGlyph r={3} />
          </ToggleGroupItem>
        </ToggleGroup>
      </Section>
    ),
    textAlign: (
      <Section title="Text align">
        <ToggleGroup
          type="single"
          value={s.textAlign ?? "left"}
          onValueChange={(v) => v && onStyleChange({ textAlign: v as TextAlign })}
          className="flex gap-2"
        >
          <ToggleGroupItem
            value="left"
            className="h-9 w-9 items-center justify-center rounded-md border bg-muted data-[state=on]:bg-secondary-foreground/10 data-[state=on]:text-secondary-foreground"
          >
            <TextParagraphIcon className="size-4" />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="center"
            className="h-9 w-9 items-center justify-center rounded-md border bg-muted data-[state=on]:bg-secondary-foreground/10 data-[state=on]:text-secondary-foreground"
          >
            <TextAlignCenterIcon className="size-4" />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="right"
            className="h-9 w-9 items-center justify-center rounded-md border bg-muted data-[state=on]:bg-secondary-foreground/10 data-[state=on]:text-secondary-foreground"
          >
            <TextAlignRightIcon className="size-4" />
          </ToggleGroupItem>
        </ToggleGroup>
      </Section>
    ),
    fontFamily: (
      <Section title="Font family">
        <ToggleGroup
          type="single"
          value={s.fontFamily ?? "sans-serif"}
          onValueChange={(v) => v && onStyleChange({ fontFamily: v as FontFamily })}
          className="flex gap-2"
        >
          <ToggleGroupItem
            value="handwriting"
            className="h-9 w-9 items-center justify-center rounded-md border bg-muted font-handwriting data-[state=on]:bg-secondary-foreground/10 data-[state=on]:text-secondary-foreground"
          >
            Aa
          </ToggleGroupItem>
          <ToggleGroupItem
            value="informal"
            className="h-9 w-9 items-center justify-center rounded-md border bg-muted font-informal data-[state=on]:bg-secondary-foreground/10 data-[state=on]:text-secondary-foreground"
          >
            Aa
          </ToggleGroupItem>
          <ToggleGroupItem
            value="sans-serif"
            className="h-9 w-9 items-center justify-center rounded-md border bg-muted font-sans data-[state=on]:bg-secondary-foreground/10 data-[state=on]:text-secondary-foreground"
          >
            Aa
          </ToggleGroupItem>
          <ToggleGroupItem
            value="serif"
            className="h-9 w-9 items-center justify-center rounded-md border bg-muted font-serif data-[state=on]:bg-secondary-foreground/10 data-[state=on]:text-secondary-foreground"
          >
            Aa
          </ToggleGroupItem>
          <ToggleGroupItem
            value="monospace"
            className="h-9 w-9 items-center justify-center rounded-md border bg-muted font-mono data-[state=on]:bg-secondary-foreground/10 data-[state=on]:text-secondary-foreground"
          >
            {"<>"}
          </ToggleGroupItem>
        </ToggleGroup>
      </Section>
    ),
    fontSize: (
      <Section title="Font size">
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            type="single"
            value={typeof s.fontSize === "string" ? s.fontSize : ""}
            onValueChange={(v) => v && onStyleChange({ fontSize: v as FontSizePreset })}
            className="flex gap-2"
          >
            {(["S", "M", "L", "XL"] as FontSizePreset[]).map((size) => (
              <ToggleGroupItem
                key={size}
                value={size}
                className="h-9 w-9 items-center justify-center rounded-md border bg-muted data-[state=on]:bg-secondary-foreground/10 data-[state=on]:text-secondary-foreground"
              >
                {size}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <FontSizeInput
            fontSize={s.fontSize ?? "M"}
            onCommit={(fontSize) => onStyleChange({ fontSize })}
          />
        </div>
      </Section>
    ),
    pathStyle: (
      <Section title="Path style">
        <ToggleGroup
          type="single"
          value={s.pathStyle ?? "bezier"}
          onValueChange={(v) => v && onStyleChange({ pathStyle: v as PathStyle })}
          className="flex gap-2"
        >
          {PATH_STYLE_OPTIONS.map((p) => (
            <ToggleGroupItem
              key={p}
              value={p}
              className="h-9 w-12 items-center justify-center rounded-md border bg-muted data-[state=on]:bg-secondary-foreground/10 data-[state=on]:text-secondary-foreground"
            >
              <PathStyleGlyph kind={p} />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Section>
    ),
    sourceArrowhead: (
      <Section title="Source arrowhead">
        <ToggleGroup
          type="single"
          value={s.sourceArrowhead ?? "none"}
          onValueChange={(v) => v && onStyleChange({ sourceArrowhead: v as Arrowhead })}
          className="flex flex-wrap gap-2"
        >
          {ARROWHEAD_OPTIONS.map((a) => (
            <ToggleGroupItem
              key={a}
              value={a}
              className="h-9 w-12 items-center justify-center rounded-md border bg-muted data-[state=on]:bg-secondary-foreground/10 data-[state=on]:text-secondary-foreground"
            >
              <ArrowheadGlyph kind={a} flip />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Section>
    ),
    targetArrowhead: (
      <Section title="Target arrowhead">
        <ToggleGroup
          type="single"
          value={s.targetArrowhead ?? "arrow-filled"}
          onValueChange={(v) => v && onStyleChange({ targetArrowhead: v as Arrowhead })}
          className="flex flex-wrap gap-2"
        >
          {ARROWHEAD_OPTIONS.map((a) => (
            <ToggleGroupItem
              key={a}
              value={a}
              className="h-9 w-12 items-center justify-center rounded-md border bg-muted data-[state=on]:bg-secondary-foreground/10 data-[state=on]:text-secondary-foreground"
            >
              <ArrowheadGlyph kind={a} />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Section>
    ),
  }

  return (
    <Card
      className={cn(
        "w-full rounded-lg border border-border/60 bg-sidebar px-0 py-0 shadow-md backdrop-blur-md supports-[backdrop-filter]:bg-sidebar/50",
        className,
      )}
    >
      <CardContent className="p-0">
        <div className="scrollbar-thin max-h-[60vh] overflow-y-auto p-1 [scrollbar-gutter:stable_both-edges]">
          <div className="space-y-0">
            {ORDER.map((key) => (
              <Popover key={key}>
                <PopoverTrigger asChild>
                  <div>
                    <RailButton title={SETTING_TITLES[key]} indicator={settingIndicator[key]} />
                  </div>
                </PopoverTrigger>
                <PopoverContent
                  side="right"
                  align="start"
                  sideOffset={10}
                  className="scrollbar-thin max-h-[60vh] w-[260px] overflow-y-auto p-3"
                >
                  {settingContent[key]}
                </PopoverContent>
              </Popover>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
