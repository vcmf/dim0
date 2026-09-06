/**
 * @file Style types for the board feature.
 */

import { resolveFamilyShade } from "../lib/colors/tailwind"

/**
 * Type of node in the board.
 */
export type NodeType =
  | "rectangle"
  | "folder"
  | "text"
  | "sheet"
  | "slide"
  | "ellipse"
  | "diamond"
  | "soft-diamond"
  | "tag"
  | "layered-circle"
  | "image"
  | "icon"
  | "layered-rectangle"
  | "thought-cloud"
  | "capsule"
  | "layered-diamond"
  | "code-sandbox"
  | "widget"
  | "mini-app"
  | "ink"

/**
 * Stroke style for the node.
 */
export type StrokeStyle = "solid" | "dashed" | "dotted"

/**
 * Fill style for the node.
 */
export type FillStyle = "solid" | "hachure" | "cross-hatch" | "zigzag" | "dots"

/**
 * Text alignment options for the node.
 */
export type TextAlign = "left" | "center" | "right"

/**
 * Font size options for the node.
 */
export type FontSize = "S" | "M" | "L" | "XL"

// Convert font size to Tailwind CSS class
export function fontSizeToTwClass(size?: FontSize): string {
  switch (size) {
    case "S":
      return "text-sm"
    case "M":
      return "text-base"
    case "L":
      return "text-2xl"
    case "XL":
      return "text-4xl"
    default:
      return "text-base"
  }
}


/**
 * Font family options for the node.
 */
export type FontFamily = "handwriting" | "sans-serif" | "serif" | "monospace" | "informal"


// Convert font family to Tailwind CSS class
export function fontFamilyToTwClass(family?: FontFamily): string {
  switch (family) {
    case "handwriting":
      return "font-handwriting"
    case "sans-serif":
      return "font-sans"
    case "serif":
      return "font-serif"
    case "monospace":
      return "font-mono"
    case "informal":
      return "font-informal"
    default:
      return "font-sans"
  }
}


/**
 * Text style options for the node.
 */
export type TextStyle = "normal" | "bold" | "italic" | "underline" | "strikethrough"


// Convert text style to Tailwind CSS class
export function textStyleToTwClass(style?: TextStyle): string {
  switch (style) {
    case "normal":
      return "font-normal"
    case "bold":
      return "font-bold"
    case "italic":
      return "italic"
    case "underline":
      return "underline"
    case "strikethrough":
      return "line-through"
    default:
      return "font-normal"
  }
}


/**
 * Sloppiness (roughness) options for the node.
 */
export const SloppyPresets = [0, 0.5, 1]

export type Sloppiness = typeof SloppyPresets[number]

/**
 * Stroke width options for the node.
 */
export const StrokeWidthPresets = [1, 2, 4]

export type StrokeWidth = typeof StrokeWidthPresets[number]


export interface BaseStyle {
  angle: number
  strokeColor: string
  strokeWidth: number
  strokeStyle: StrokeStyle
  backgroundColor: string
  fillStyle: FillStyle
  roughness: number
  roundness: number
  opacity: number
  groupIds: string[]
  fontFamily: FontFamily
  fontSize: FontSize
  textAlign: TextAlign
  textColor: string
  textStyle: TextStyle
}


/**
 * Interface for the style of a node in the board.
 */
export interface Style extends BaseStyle {
  type: NodeType
}


// Arrowhead types for links
export type ArrowheadType = 'none' | 'arrow' | 'barb' | 'arrow-filled'


/**
 * Interface for the style of a link in the board.
 */
export interface LinkStyle extends BaseStyle {
  type: "arrow"
  sourceArrowhead: ArrowheadType
  targetArrowhead: ArrowheadType
  pathStyle: "bezier" | "straight" | "polyline"
}


export const TRANSPARENT_HEX = "#00000000"


const BLACK_HEX = "#000000"


const ORANGE_200 = resolveFamilyShade("orange", 200) ?? "#fed7aa"


const BLUE_200 = resolveFamilyShade("blue", 200) ?? "#bfdbfe"


const STONE_200 = resolveFamilyShade("stone", 200) ?? "#e7e5e4"


const STONE_800 = resolveFamilyShade("stone", 800) ?? "#292524"


const TEAL_200 = resolveFamilyShade("teal", 200) ?? "#99f6e4"


const SLATE_400 = resolveFamilyShade("slate", 400) ?? "#94a3b8"


const ROSE_PINE_LIGHT = "#faf4ed"


/**
 * Default style for nodes in the board.
 */
export const createDefaultStyle = ({
  type = "rectangle"
}: {
  type?: NodeType
}): Style => {
  const defaultOptions = {
    type: type,
    angle: 0.0,
    strokeColor: TRANSPARENT_HEX,
    strokeWidth: 2,
    strokeStyle: "solid",
    backgroundColor: ORANGE_200,
    fillStyle: "solid",
    textColor: BLACK_HEX,
    textStyle: "normal",
    opacity: 100,
    groupIds: []
  }

  switch (type) {
    case "rectangle":
    case "folder":
    case "layered-rectangle":
    case "layered-circle":
    case "tag":
      return {
        ...defaultOptions,
        roughness: 0.5,
        roundness: 0,
        fontFamily: "handwriting",
        fontSize: "M",
        textAlign: "center",
        backgroundColor: BLUE_200,
      } as Style
    case "thought-cloud":
      return {
        ...defaultOptions,
        roughness: 0.5,
        roundness: 0,
        fontFamily: "handwriting",
        fontSize: "M",
        textAlign: "center",
        backgroundColor: STONE_200
      } as Style
    case "capsule":
      return {
        ...defaultOptions,
        roughness: 0.5,
        roundness: 0,
        fontFamily: "handwriting",
        fontSize: "M",
        textAlign: "center",
        backgroundColor: TEAL_200
      } as Style
    case "ellipse":
      return {
        ...defaultOptions,
        roughness: 0.5,
        roundness: 0,
        fontFamily: "handwriting",
        fontSize: "M",
        textAlign: "center"
      } as Style
    case "diamond":
    case "layered-diamond":
    case "soft-diamond":
      return {
        ...defaultOptions,
        roughness: 0.5,
        roundness: 0,
        fontFamily: "handwriting",
        fontSize: "M",
        textAlign: "center"
      } as Style
    case "sheet":
      return {
        ...defaultOptions,
        roughness: 0,
        roundness: 0,
        fontFamily: "handwriting",
        fontSize: "M",
        textAlign: "left",
        backgroundColor: TRANSPARENT_HEX,
        strokeColor: TRANSPARENT_HEX,
      } as Style
    case "text":
    case "ink":
      return {
        ...defaultOptions,
        roughness: 0,
        roundness: 0,
        fontFamily: "handwriting",
        fontSize: "M",
        textAlign: "left",
        backgroundColor: TRANSPARENT_HEX,
        strokeColor: type === "ink" ? STONE_800 : TRANSPARENT_HEX,
      } as Style
    case "image":
      return {
        ...defaultOptions,
        roughness: 1,
        roundness: 0,
        fontFamily: "handwriting",
        fontSize: "M",
        textAlign: "center",
        backgroundColor: TRANSPARENT_HEX,
        strokeColor: TRANSPARENT_HEX,
      } as Style
    case "icon":
      return {
        ...defaultOptions,
        roughness: 1,
        roundness: 0,
        fontFamily: "handwriting",
        fontSize: "M",
        textAlign: "center",
        backgroundColor: TRANSPARENT_HEX,
        strokeColor: TRANSPARENT_HEX,
      } as Style
    case "slide":
      return {
        ...defaultOptions,
        roughness: 0,
        roundness: 2,
        fontFamily: "sans-serif",
        fontSize: "M",
        textAlign: "left",
        backgroundColor: TRANSPARENT_HEX,
        strokeColor: SLATE_400,
        strokeStyle: "dashed",
        opacity: 90,
      } as Style
    case "code-sandbox":
    case "widget":
    case "mini-app":
      return {
        ...defaultOptions,
        roughness: 0,
        roundness: 1,
        fontFamily: type === "code-sandbox" ? "monospace" : "sans-serif",
        fontSize: "S",
        textAlign: "left",
        backgroundColor: ROSE_PINE_LIGHT,
        strokeColor: TRANSPARENT_HEX,
        opacity: 100,
      } as Style
  }
}


/**
 * Default style for links in the board.
 */
export const createDefaultLinkStyle = (): LinkStyle => ({
  type: "arrow",
  angle: 0.0,
  strokeColor: STONE_800,
  strokeWidth: 2,
  strokeStyle: "solid",
  backgroundColor: TRANSPARENT_HEX,
  fillStyle: "solid",
  roughness: 1,
  roundness: 0,
  opacity: 100,
  groupIds: [],
  fontFamily: "handwriting",
  fontSize: "M",
  textAlign: "center",
  textColor: BLACK_HEX,
  textStyle: "normal",
  sourceArrowhead: "none",
  targetArrowhead: "arrow-filled",
  pathStyle: "bezier"
})
