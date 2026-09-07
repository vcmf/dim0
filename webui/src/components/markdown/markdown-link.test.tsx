// Tests for the document-citation (`#doc-<id>`) branch of MarkdownLink.
//
// Vanilla react-dom + act (repo convention). useNavigate is mocked — the doc
// branch doesn't route, but MarkdownLink calls the hook unconditionally.

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => {} }))

import { MarkdownLink, REVEAL_SOURCE_EVENT } from "./markdown-link"


describe("MarkdownLink — #doc- citation", () => {
  let container: HTMLDivElement
  let root: Root


  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    // jsdom doesn't implement scrollIntoView.
    Element.prototype.scrollIntoView = vi.fn()
  })


  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.querySelectorAll("details").forEach((d) => d.remove())
  })


  it("renders the title text as an anchor (not the bare link icon)", () => {
    act(() => root.render(<MarkdownLink href="#doc-abc">Report.pdf</MarkdownLink>))
    const a = container.querySelector("a")
    expect(a?.getAttribute("href")).toBe("#doc-abc")
    expect(a?.textContent).toBe("Report.pdf") // label kept, not replaced by an icon
  })


  it("opens the target <details> and scrolls to it on click", () => {
    const details = document.createElement("details")
    details.id = "doc-abc"
    document.body.appendChild(details)
    expect(details.open).toBe(false)

    act(() => root.render(<MarkdownLink href="#doc-abc">Report.pdf</MarkdownLink>))
    act(() => container.querySelector("a")?.click())

    expect(details.open).toBe(true)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })


  it("dispatches REVEAL_SOURCE_EVENT on a non-<details> target (React-controlled card) and scrolls", () => {
    const card = document.createElement("div")
    card.id = "doc-abc"
    document.body.appendChild(card)
    const onReveal = vi.fn()
    card.addEventListener(REVEAL_SOURCE_EVENT, onReveal)

    act(() => root.render(<MarkdownLink href="#doc-abc">Report.pdf</MarkdownLink>))
    act(() => container.querySelector("a")?.click())

    expect(onReveal).toHaveBeenCalledTimes(1)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    card.remove()
  })
})


describe("MarkdownLink — href scheme allowlist", () => {
  let container: HTMLDivElement
  let root: Root


  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })


  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })


  const render = (href: string) =>
    act(() => root.render(<MarkdownLink href={href}>link</MarkdownLink>))

  const hrefOf = () => container.querySelector("a")?.getAttribute("href") ?? null

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "blob:https://example.com/abc",
    "file:///etc/passwd",
  ])("neutralizes the dangerous href %j (no href attribute emitted)", (href) => {
    render(href)
    expect(hrefOf()).toBeNull()
  })

  it.each([
    "https://example.com/",
    "http://example.com/",
    "//example.com/",
    "mailto:hi@example.com",
    "tel:+15551234567",
    "sms:+15551234567",
    "/boards/b1/n/n1",
    "#section",
    "?q=1",
    "relative/path",
  ])("preserves the legitimate href %j", (href) => {
    render(href)
    expect(hrefOf()).toBe(href)
  })
})
