import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FontSizeInput } from "./font-size-input"
import { normalizeFontSizeInput } from "./font-size"


afterEach(cleanup)


describe("font size input", () => {
  it("clamps supported values and rejects empty drafts", () => {
    expect(normalizeFontSizeInput("")).toBeNull()
    expect(normalizeFontSizeInput("2")).toBe(8)
    expect(normalizeFontSizeInput("24.4")).toBe(24)
    expect(normalizeFontSizeInput("999")).toBe(256)
  })

  it("commits once on blur instead of on every keystroke", () => {
    const onCommit = vi.fn()
    render(<FontSizeInput fontSize="M" onCommit={onCommit} />)
    const input = screen.getByRole("spinbutton")

    fireEvent.change(input, { target: { value: "2" } })
    fireEvent.change(input, { target: { value: "24" } })
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledOnce()
    expect(onCommit).toHaveBeenCalledWith(24)
  })

  it("restores the current value when the draft is empty", () => {
    const onCommit = vi.fn()
    render(<FontSizeInput fontSize="L" onCommit={onCommit} />)
    const input = screen.getByRole("spinbutton")

    fireEvent.change(input, { target: { value: "" } })
    fireEvent.blur(input)

    expect(onCommit).not.toHaveBeenCalled()
    expect((input as HTMLInputElement).value).toBe("24")
  })

  it("commits once when Enter is pressed", () => {
    const onCommit = vi.fn()
    render(<FontSizeInput fontSize="M" onCommit={onCommit} />)
    const input = screen.getByRole("spinbutton")

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "72" } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(onCommit).toHaveBeenCalledOnce()
    expect(onCommit).toHaveBeenCalledWith(72)
  })
})
