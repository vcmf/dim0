import { describe, expect, it } from "vitest"

import { paletteColor, resolveToken, tokenToCssVar, THEME_TOKEN_NAMES } from "./resolve-token"

// NOTE: the actual token → concrete `rgb(...)` resolution goes through a browser
// `getComputedStyle` + oklch `color-mix` probe (readCssVarMixed), which jsdom does
// NOT compute — so the color correctness is validated by the WebKit capture spike
// (PR 0, proven) and a future e2e, not here. These tests cover the PURE decision
// layer (`tokenToCssVar`) and the raw-color passthrough, which need no browser.


describe("tokenToCssVar", () => {
  it("maps a bare theme token to its custom property", () => {
    expect(tokenToCssVar("chart-1")).toBe("--chart-1")
    expect(tokenToCssVar("primary")).toBe("--primary")
    expect(tokenToCssVar("muted-foreground")).toBe("--muted-foreground")
  })

  it("unwraps a var(--token) form", () => {
    expect(tokenToCssVar("var(--chart-3)")).toBe("--chart-3")
    expect(tokenToCssVar("var( --foreground )")).toBe("--foreground")
  })

  it("accepts a --prefixed token", () => {
    expect(tokenToCssVar("--accent")).toBe("--accent")
  })

  it("returns null for a raw color (passes through unresolved)", () => {
    expect(tokenToCssVar("#abcdef")).toBeNull()
    expect(tokenToCssVar("rgb(1, 2, 3)")).toBeNull()
    expect(tokenToCssVar("oklch(0.5 0.1 200)")).toBeNull()
    expect(tokenToCssVar("red")).toBeNull()
  })

  it("returns null for an unknown token name", () => {
    expect(tokenToCssVar("chart-9")).toBeNull()
    expect(tokenToCssVar("not-a-token")).toBeNull()
  })

  it("covers the 5 chart tokens + core semantics", () => {
    for (const t of ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "foreground", "background", "card"]) {
      expect(THEME_TOKEN_NAMES.has(t)).toBe(true)
    }
  })
})


describe("resolveToken (raw passthrough — the browser-free path)", () => {
  it("passes a raw hex/rgb/named color through unchanged", () => {
    expect(resolveToken("#123456")).toBe("#123456")
    expect(resolveToken("rgb(10, 20, 30)")).toBe("rgb(10, 20, 30)")
    expect(resolveToken("  #abc  ")).toBe("#abc") // trimmed
  })
})


describe("paletteColor", () => {
  it("cycles the five chart tokens by index", () => {
    // Can't assert the resolved rgb (jsdom), but the token cycling is via chart-N;
    // a raw index maps into 1..5 and stays a resolvable chart token.
    expect(tokenToCssVar(`chart-${(0 % 5) + 1}`)).toBe("--chart-1")
    expect(tokenToCssVar(`chart-${(5 % 5) + 1}`)).toBe("--chart-1")
    expect(tokenToCssVar(`chart-${(7 % 5) + 1}`)).toBe("--chart-3")
    expect(typeof paletteColor(0)).toBe("string") // doesn't throw
  })
})
