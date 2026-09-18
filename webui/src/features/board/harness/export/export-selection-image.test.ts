import { describe, expect, it } from "vitest"

import { containRect, injectAppletImages, stripAppletSourceText, type SvgAppletPlacement } from "./export-selection-image"


// A harness SVG export has the shape the compositor keys off: an outer
// `<g transform="translate(tx ty)">` whose children are drawn at world coords.
const BASE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="232" height="152" viewBox="0 0 232 152">` +
  `<rect width="100%" height="100%" fill="#ffffff" />` +
  `<g transform="translate(-84 -34)"><g><rect x="100" y="50" width="200" height="120" /></g></g>` +
  `</svg>`

const HREF = "data:image/png;base64,AAAA"


describe("injectAppletImages", () => {
  it("returns the SVG untouched when there are no placements", () => {
    expect(injectAppletImages(BASE_SVG, [])).toBe(BASE_SVG)
  })

  it("appends an overlay group reusing the base translate, at the node's world box", () => {
    const p: SvgAppletPlacement = { x: 100, y: 50, w: 200, h: 120, angle: 0, href: HREF }
    const out = injectAppletImages(BASE_SVG, [p])

    // Overlay is inserted before the closing tag (painted last ⇒ on top).
    expect(out.endsWith(`</g></svg>`)).toBe(true)
    expect(out.indexOf("<image")).toBeGreaterThan(out.indexOf(`translate(-84 -34)`))
    // Same translate as the base group, and the image at world coords, not offset.
    expect(out).toContain(`<g transform="translate(-84 -34)"><image x="100" y="50" width="200" height="120"`)
    expect(out).toContain(`href="${HREF}"`)
    // No rotation wrapper for an axis-aligned node.
    expect(out).not.toContain("rotate(")
  })

  it("wraps a rotated node in a rotate() group about its center (radians → degrees)", () => {
    const p: SvgAppletPlacement = { x: 0, y: 0, w: 100, h: 100, angle: Math.PI / 2, href: HREF }
    const out = injectAppletImages(BASE_SVG, [p])
    expect(out).toContain(`<g transform="rotate(90 50 50)"><image`)
  })

  it("escapes XML-significant characters in the href", () => {
    const p: SvgAppletPlacement = { x: 0, y: 0, w: 1, h: 1, angle: 0, href: `a&b"<>` }
    const out = injectAppletImages(BASE_SVG, [p])
    expect(out).toContain(`href="a&amp;b&quot;&lt;&gt;"`)
  })

  it("returns the SVG unmodified when the translate group is missing (unexpected shape)", () => {
    const weird = `<svg><rect /></svg>`
    expect(injectAppletImages(weird, [{ x: 0, y: 0, w: 1, h: 1, angle: 0, href: HREF }])).toBe(weird)
  })

  it("emits an opaque backing rect before the image when a background color is given", () => {
    const p: SvgAppletPlacement = { x: 10, y: 20, w: 30, h: 40, angle: 0, href: HREF }
    const out = injectAppletImages(BASE_SVG, [p], "#ffffff")
    // rect precedes image (painted under it), same box, given fill.
    expect(out).toContain(`<rect x="10" y="20" width="30" height="40" fill="#ffffff" /><image x="10" y="20"`)
  })

  it("omits the backing rect when no background color is given (transparent export)", () => {
    const out = injectAppletImages(BASE_SVG, [{ x: 0, y: 0, w: 1, h: 1, angle: 0, href: HREF }])
    // The overlay group opens straight into the <image> — no backing rect before it.
    expect(out).toContain(`<g transform="translate(-84 -34)"><image x="0" y="0"`)
  })

  it("aspect-fits the image (meet), not stretch (none)", () => {
    const out = injectAppletImages(BASE_SVG, [{ x: 0, y: 0, w: 1, h: 1, angle: 0, href: HREF }])
    expect(out).toContain(`preserveAspectRatio="xMidYMid meet"`)
    expect(out).not.toContain(`preserveAspectRatio="none"`)
  })
})


describe("containRect", () => {
  it("fills exactly when aspect ratios match", () => {
    expect(containRect(200, 100, 400, 200)).toEqual({ dx: 0, dy: 0, dw: 400, dh: 200 })
  })

  it("letterboxes (pillarbox) a wider image, centered", () => {
    // 2:1 image into a 1:1 box → width-limited, vertical bars.
    expect(containRect(200, 100, 100, 100)).toEqual({ dx: 0, dy: 25, dw: 100, dh: 50 })
  })

  it("letterboxes a taller image, centered", () => {
    // 1:2 image into a 1:1 box → height-limited, horizontal bars.
    expect(containRect(100, 200, 100, 100)).toEqual({ dx: 25, dy: 0, dw: 50, dh: 100 })
  })

  it("degrades to the full box for a zero-sized image", () => {
    expect(containRect(0, 0, 100, 80)).toEqual({ dx: 0, dy: 0, dw: 100, dh: 80 })
  })
})


describe("stripAppletSourceText", () => {
  // The applet's JSX source; the harness renders it as a <text> with escaped, wrapped tspans.
  const source = '<Widget data={{ rows: [1, 2, 3] }}>\n  <span className="bg-chart-5"></span>\n</Widget>'
  const sourceText =
    '<text fill="#1f2937" text-anchor="middle">' +
    '<tspan x="200" y="20">&lt;Widget data={{ rows: [1, 2, 3] }}&gt;</tspan>' +
    '<tspan x="200" y="40">  &lt;span className=&quot;bg-chart-5&quot;&gt;&lt;/span&gt;</tspan>' +
    '<tspan x="200" y="60">&lt;/Widget&gt;</tspan>' +
    "</text>"
  const legendText = '<text x="10" y="10">40%</text>'

  it("removes the applet-source <text> block (whitespace/entity-insensitive) but keeps other text", () => {
    const svg = `<svg>${legendText}${sourceText}</svg>`
    const out = stripAppletSourceText(svg, [source])
    expect(out).not.toContain("&lt;Widget")
    expect(out).not.toContain("bg-chart-5")
    expect(out).toContain(legendText) // legend value untouched
  })

  it("leaves the SVG unchanged when no applet content is given", () => {
    const svg = `<svg>${sourceText}</svg>`
    expect(stripAppletSourceText(svg, [])).toBe(svg)
  })

  it("does not strip a short text block that merely prefixes a source", () => {
    const svg = `<svg><text x="0" y="0">&lt;Widget</text></svg>` // "<Widget" is < MIN_SOURCE_MATCH_LEN
    expect(stripAppletSourceText(svg, [source])).toContain("&lt;Widget")
  })
})
