import { describe, expect, it } from "vitest"

import { compileApplet } from "./index"


// Helper: compile and assert success, returning the tree.
function tree(source: string) {
  const r = compileApplet(source)
  if (!r.ok) throw new Error(`expected compile success, got: ${r.message} (${r.line}:${r.column})`)
  return r.tree
}


describe("counter (full tree)", () => {
  it("compiles state, persist, literal props, text, and a set handler", () => {
    const t = tree(`
      <Widget state={{ count: 0 }} persist>
        <Card>
          <CardTitle>Counter</CardTitle>
          <div className="text-3xl">{count}</div>
          <Button onClick={set("count", count - 1)}>-</Button>
        </Card>
      </Widget>
    `)
    expect(t).toEqual({
      v: 1,
      scopes: { state: { count: 0 } },
      persist: true,
      root: {
        k: "el",
        tag: "Card",
        children: [
          { k: "el", tag: "CardTitle", children: [{ k: "txt", v: "Counter" }] },
          { k: "el", tag: "div", props: { className: "text-3xl" }, children: [{ k: "txt", x: { type: "Identifier", name: "count" } }] },
          {
            k: "el",
            tag: "Button",
            on: {
              click: {
                do: "set",
                path: "count",
                arg: {
                  type: "BinaryExpression",
                  operator: "-",
                  left: { type: "Identifier", name: "count" },
                  right: { type: "Literal", value: 1 },
                },
              },
            },
            children: [{ k: "txt", v: "-" }],
          },
        ],
      },
    })
  })
})


describe("static dashboard", () => {
  it("puts constant arrays in `data` and literal chart props in `props`", () => {
    const t = tree(`
      <Widget data={{ revenue: [120, 132, 145], months: ["Jan", "Feb", "Mar"] }}>
        <Chart kind="line" labels={months} data={revenue} height={200} />
      </Widget>
    `)
    expect(t.scopes.data).toEqual({ revenue: [120, 132, 145], months: ["Jan", "Feb", "Mar"] })
    expect(t.persist).toBeUndefined()
    const chart = t.root
    expect(chart).toMatchObject({ k: "el", tag: "Chart", props: { kind: "line", height: 200 } })
    // `labels`/`data` reference scope identifiers → binds, not literal props
    expect((chart as { bind: Record<string, unknown> }).bind).toEqual({
      labels: { type: "Identifier", name: "months" },
      data: { type: "Identifier", name: "revenue" },
    })
  })
})


describe("list rendering via .map", () => {
  it("compiles items.map(item => <li>) to a list node", () => {
    const t = tree(`
      <Widget data={{ items: [] }}>
        <ul>{items.map((it, i) => <li>{it.text}</li>)}</ul>
      </Widget>
    `)
    const ul = t.root as { children: unknown[] }
    expect(ul.children[0]).toEqual({
      k: "list",
      src: { type: "Identifier", name: "items" },
      item: "it",
      index: "i",
      tpl: { k: "el", tag: "li", children: [{ k: "txt", x: { type: "MemberExpression", object: { type: "Identifier", name: "it" }, property: { type: "Identifier", name: "text" }, computed: false, optional: false } }] },
    })
  })

  it("a value-returning .map stays an expression (text), not a list", () => {
    const t = tree(`<Widget data={{ xs: [] }}><div>{xs.map(x => x).length}</div></Widget>`)
    const div = t.root as { children: Array<{ k: string }> }
    expect(div.children[0].k).toBe("txt")
  })
})


describe("conditionals", () => {
  it("ternary with element branches → cond node", () => {
    const t = tree(`
      <Widget state={{ open: false }}>
        <div>{open ? <span>on</span> : <span>off</span>}</div>
      </Widget>
    `)
    const div = t.root as { children: Array<{ k: string; test: unknown; then: unknown; else: unknown }> }
    expect(div.children[0]).toMatchObject({
      k: "cond",
      test: { type: "Identifier", name: "open" },
      then: { k: "el", tag: "span" },
      else: { k: "el", tag: "span" },
    })
  })

  it("`cond && <el>` → cond node with no else", () => {
    const t = tree(`<Widget state={{ v: false }}><div>{v && <span>x</span>}</div></Widget>`)
    const div = t.root as { children: Array<{ k: string; else?: unknown }> }
    expect(div.children[0].k).toBe("cond")
    expect(div.children[0].else).toBeUndefined()
  })
})


describe("handlers", () => {
  it("guarded action: $event.key === 'Enter' && batch(...)", () => {
    const t = tree(`
      <Widget state={{ items: [], draft: "" }}>
        <input value={draft}
          onChange={set("draft", $event.value)}
          onKeyDown={$event.key === "Enter" && batch(append("items", draft), set("draft", ""))} />
      </Widget>
    `)
    const input = t.root as { on: Record<string, unknown> }
    expect(input.on.change).toEqual({ do: "set", path: "draft", arg: { type: "MemberExpression", object: { type: "Identifier", name: "$event" }, property: { type: "Identifier", name: "value" }, computed: false, optional: false } })
    expect(input.on.keydown).toMatchObject({
      guard: { type: "BinaryExpression", operator: "===" },
      then: { do: "batch", actions: [{ do: "append", path: "items" }, { do: "set", path: "draft" }] },
    })
  })

  it("array-item removal via set + immutable filter (the §9.1 idiom)", () => {
    const t = tree(`
      <Widget state={{ items: [] }}>
        <Button onClick={set("items", items.filter(x => x.id !== 2))}>x</Button>
      </Widget>
    `)
    const btn = t.root as { on: Record<string, { do: string; path: string; arg: { type: string } }> }
    expect(btn.on.click.do).toBe("set")
    expect(btn.on.click.path).toBe("items")
    expect(btn.on.click.arg.type).toBe("CallExpression")
  })
})


describe("edge cases (review round 1)", () => {
  it("does not treat a plain 'on'-prefixed attribute as a handler", () => {
    const t = tree(`<Widget><div once="x">y</div></Widget>`)
    expect((t.root as { props: Record<string, unknown> }).props.once).toBe("x")
  })

  it("trims multi-line JSX text the way JSX does", () => {
    const t = tree(`<Widget><p>\n    Hello world\n  </p></Widget>`)
    expect((t.root as { children: Array<{ v: string }> }).children[0].v).toBe("Hello world")
  })

  it("lifts a .map list inside a ternary branch", () => {
    const t = tree(`
      <Widget data={{ items: [] }}>
        <div>{items.length ? items.map(x => <li>{x}</li>) : <span>none</span>}</div>
      </Widget>
    `)
    const cond = (t.root as { children: Array<{ k: string; then: { k: string } }> }).children[0]
    expect(cond.k).toBe("cond")
    expect(cond.then.k).toBe("list")
  })
})


describe("derived scope", () => {
  it("stores derived values as expressions", () => {
    const t = tree(`
      <Widget data={{ xs: [1, 2, 3] }} derived={{ total: xs.reduce((a, b) => a + b, 0) }}>
        <div>{total}</div>
      </Widget>
    `)
    expect(t.scopes.derived?.total).toMatchObject({ type: "CallExpression" })
  })
})
