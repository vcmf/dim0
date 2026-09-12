import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AppletRenderer } from "./renderer"


// sonner needs no <Toaster> mounted for toast() to be a harmless no-op, but stub
// it so tests don't depend on its runtime.
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))


afterEach(() => {
  document.body.innerHTML = ""
})


describe("static rendering", () => {
  it("renders text, bindings, and template literals", () => {
    render(
      <AppletRenderer
        source={`<Widget data={{ name: "Ada", n: 3 }}><div data-testid="out">{name}: {n * 2}</div></Widget>`}
      />,
    )
    expect(screen.getByTestId("out").textContent).toBe("Ada: 6")
  })

  it("renders a component (Table) from data", () => {
    render(
      <AppletRenderer
        source={`<Widget data={{ rows: [{ a: 1 }, { a: 2 }] }}><Table columns={["a"]} rows={rows} /></Widget>`}
      />,
    )
    expect(screen.getAllByRole("row").length).toBe(3) // header + 2 rows
  })
})


describe("interactivity", () => {
  it("counter: set updates state and re-renders", () => {
    render(
      <AppletRenderer
        source={`
          <Widget state={{ count: 0 }}>
            <div>
              <span data-testid="count">{count}</span>
              <button onClick={set("count", count + 1)}>inc</button>
              <button onClick={set("count", count - 1)}>dec</button>
            </div>
          </Widget>
        `}
      />,
    )
    expect(screen.getByTestId("count").textContent).toBe("0")
    fireEvent.click(screen.getByText("inc"))
    fireEvent.click(screen.getByText("inc"))
    expect(screen.getByTestId("count").textContent).toBe("2")
    fireEvent.click(screen.getByText("dec"))
    expect(screen.getByTestId("count").textContent).toBe("1")
  })

  it("todo: $event, append/batch, and .map list", () => {
    render(
      <AppletRenderer
        source={`
          <Widget state={{ items: [], draft: "" }}>
            <div>
              <input data-testid="draft" value={draft} onChange={set("draft", $event.value)} />
              <button onClick={batch(append("items", draft), set("draft", ""))}>add</button>
              <ul>{items.map((it, i) => <li>{it}</li>)}</ul>
            </div>
          </Widget>
        `}
      />,
    )
    const input = screen.getByTestId("draft") as HTMLInputElement
    fireEvent.change(input, { target: { value: "milk" } })
    expect(input.value).toBe("milk")
    fireEvent.click(screen.getByText("add"))
    expect(screen.getByText("milk")).toBeTruthy()
    expect(input.value).toBe("") // draft cleared by the batch
  })

  it("toggle flips a boolean shown via a conditional", () => {
    render(
      <AppletRenderer
        source={`
          <Widget state={{ open: false }}>
            <div>
              <button onClick={toggle("open")}>t</button>
              <span data-testid="s">{open ? "on" : "off"}</span>
            </div>
          </Widget>
        `}
      />,
    )
    expect(screen.getByTestId("s").textContent).toBe("off")
    fireEvent.click(screen.getByText("t"))
    expect(screen.getByTestId("s").textContent).toBe("on")
  })
})


describe("conditionals & lists", () => {
  it("renders an element conditional and its empty branch", () => {
    render(
      <AppletRenderer
        source={`<Widget state={{ v: true }}><div>{v ? <span data-testid="y">yes</span> : null}</div></Widget>`}
      />,
    )
    expect(screen.getByTestId("y").textContent).toBe("yes")
  })

  it("renders a filtered .map list", () => {
    render(
      <AppletRenderer
        source={`<Widget data={{ xs: [1, 2, 3, 4] }}><ul>{xs.filter(x => x % 2 === 0).map(x => <li>{x}</li>)}</ul></Widget>`}
      />,
    )
    const items = screen.getAllByRole("listitem").map((li) => li.textContent)
    expect(items).toEqual(["2", "4"])
  })
})


describe("review-round fixes", () => {
  it("resets state when the source changes (keyed remount)", () => {
    const s1 = `<Widget state={{ count: 0 }}><div><span data-testid="c">{count}</span><button onClick={set("count", count + 1)}>inc</button></div></Widget>`
    const { rerender } = render(<AppletRenderer source={s1} />)
    fireEvent.click(screen.getByText("inc"))
    expect(screen.getByTestId("c").textContent).toBe("1")
    rerender(<AppletRenderer source={`<Widget state={{ count: 99 }}><div><span data-testid="c">{count}</span></div></Widget>`} />)
    expect(screen.getByTestId("c").textContent).toBe("99") // fresh defaults, not stale 1
  })

  it("renders two sibling .map lists without dropping items", () => {
    render(
      <AppletRenderer
        source={`<Widget data={{ a: [1, 2], b: [3, 4] }}><ul>{a.map(x => <li>{x}</li>)}{b.map(x => <li>{x}</li>)}</ul></Widget>`}
      />,
    )
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["1", "2", "3", "4"])
  })

  it("sorts a table with missing/mixed cells without crashing", () => {
    render(
      <AppletRenderer
        source={`<Widget data={{ rows: [{ a: 2 }, { a: null }, { a: 1 }] }}><Table columns={["a"]} rows={rows} sortable /></Widget>`}
      />,
    )
    fireEvent.click(screen.getByRole("columnheader"))
    expect(screen.getAllByRole("row").length).toBe(4) // header + 3 rows, no throw
  })
})


describe("review round 2 fixes", () => {
  it("renders an object/array binding as nothing (not '[object Object]')", () => {
    render(
      <AppletRenderer source={`<Widget data={{ o: { a: 1 }, arr: [1, 2] }}><div data-testid="out">[{o}][{arr}]</div></Widget>`} />,
    )
    expect(screen.getByTestId("out").textContent).toBe("[][]")
  })

  it("degrades a non-array Table binding to an empty table (no throw)", () => {
    render(<AppletRenderer source={`<Widget data={{ rows: { bad: true } }}><Table columns={["a"]} rows={rows} /></Widget>`} />)
    expect(screen.getAllByRole("row").length).toBe(1) // header only
  })

  it("caps a huge list and shows a '… N more' note", () => {
    const nums = Array.from({ length: 1001 }, (_, i) => i).join(", ")
    render(<AppletRenderer source={`<Widget data={{ xs: [${nums}] }}><ul>{xs.map(x => <li>{x}</li>)}</ul></Widget>`} />)
    expect(screen.getAllByRole("listitem").length).toBe(1000)
    expect(screen.getByText("… 1 more")).toBeTruthy()
  })
})


describe("failure handling", () => {
  it("shows an error card for a compile error", () => {
    render(<AppletRenderer source={`<Widget><Nope/></Widget>`} />)
    expect(screen.getByText("Applet error")).toBeTruthy()
    expect(screen.getByText(/unknown component/)).toBeTruthy()
  })

  it("degrades a binding that throws at render to nothing (no crash)", () => {
    // `x.toFixed` validates (a value method) but throws at runtime on a string
    render(<AppletRenderer source={`<Widget data={{ x: "hi" }}><div data-testid="out">{x.toFixed(2)}</div></Widget>`} />)
    expect(screen.getByTestId("out").textContent).toBe("")
  })
})
