import { describe, expect, it } from "vitest"

import { compileApplet, validateApplet } from "./index"
import { smokeTestApplet } from "./dry-eval"


// Compile to a tree (asserting success) so a smoke-test case starts from a valid
// tree — the smoke test's whole job is catching what compilation can't.
function tree(source: string) {
  const r = compileApplet(source)
  if (!r.ok) throw new Error(`expected compile success, got: ${r.message} (${r.line}:${r.column})`)
  return r.tree
}


describe("smokeTestApplet — array-prop contract", () => {
  it("passes a Chart whose data binds to an array", () => {
    const t = tree(`
      <Widget data={{ revenue: [120, 132, 145], months: ["Jan", "Feb", "Mar"] }}>
        <Chart kind="line" labels={months} data={revenue} height={200} />
      </Widget>
    `)
    expect(smokeTestApplet(t)).toEqual({ ok: true })
  })

  it("fails a Chart whose data binds to a non-array (the `e is not iterable` class)", () => {
    const t = tree(`
      <Widget data={{ revenue: 5 }}>
        <Chart kind="line" data={revenue} />
      </Widget>
    `)
    const r = smokeTestApplet(t)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toContain("<Chart>")
      expect(r.message).toContain("`data`")
      expect(r.message).toContain("must be an array")
      expect(r.message).toContain("a number")
    }
  })

  it("fails a Chart with a literal non-array data prop", () => {
    const t = tree(`<Widget><Chart kind="bar" data={42} /></Widget>`)
    expect(smokeTestApplet(t).ok).toBe(false)
  })

  it("fails a Graph whose nodes bind to an object, not an array", () => {
    const t = tree(`
      <Widget data={{ n: { a: 1 }, e: [] }}>
        <Graph nodes={n} edges={e} />
      </Widget>
    `)
    const r = smokeTestApplet(t)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toContain("<Graph>")
      expect(r.message).toContain("`nodes`")
      expect(r.message).toContain("an object")
    }
  })

  it("fails a Map whose markers bind to a non-array", () => {
    const t = tree(`
      <Widget data={{ pins: "here" }}>
        <Map markers={pins} />
      </Widget>
    `)
    expect(smokeTestApplet(t).ok).toBe(false)
  })

  it("does not flag a Chart that omits the data prop (component default, not an applet bug)", () => {
    const t = tree(`<Widget><Chart kind="line" /></Widget>`)
    expect(smokeTestApplet(t)).toEqual({ ok: true })
  })

  it("does not flag a nullish binding (left to the component's own handling)", () => {
    // `series` is null initially — conservative: not our crash to flag (Map/Chart
    // may default it), so this passes rather than false-positiving.
    const t = tree(`<Widget state={{ series: null }}><Chart kind="line" data={series} /></Widget>`)
    expect(smokeTestApplet(t)).toEqual({ ok: true })
  })
})


describe("smokeTestApplet — walk fidelity", () => {
  it("passes a plain counter (no iterating components)", () => {
    const t = tree(`
      <Widget state={{ count: 0 }}>
        <Card>
          <div>{count}</div>
          <Button onClick={set("count", count + 1)}>+</Button>
        </Card>
      </Widget>
    `)
    expect(smokeTestApplet(t)).toEqual({ ok: true })
  })

  it("does not walk the untaken cond branch (a guard protects it)", () => {
    // `sel` is null initially, so the `sel ? <Chart data={sel}/> : …` branch that
    // would flag a non-array must NOT be evaluated — the guard is the point.
    const t = tree(`
      <Widget state={{ sel: null }}>
        <div>{sel ? <Chart data={sel} /> : <span>none</span>}</div>
      </Widget>
    `)
    expect(smokeTestApplet(t)).toEqual({ ok: true })
  })

  it("walks the first list item's template", () => {
    // A well-formed list over an array is fine; the walk binds the first item.
    const t = tree(`
      <Widget data={{ items: [{ label: "a" }, { label: "b" }] }}>
        <ul>{items.map((it) => <li>{it.label}</li>)}</ul>
      </Widget>
    `)
    expect(smokeTestApplet(t)).toEqual({ ok: true })
  })

  it("does not throw on a list over a non-array (renderer degrades it)", () => {
    const t = tree(`
      <Widget data={{ items: 3 }}>
        <ul>{items.map((it) => <li>{it}</li>)}</ul>
      </Widget>
    `)
    expect(smokeTestApplet(t)).toEqual({ ok: true })
  })
})


describe("validateApplet — smoke test folded into the write_note gate", () => {
  it("rejects a compiling-but-throwing applet with the smoke message", () => {
    const r = validateApplet(`<Widget data={{ revenue: 5 }}><Chart data={revenue} /></Widget>`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain("must be an array")
  })

  it("accepts a valid applet", () => {
    const r = validateApplet(`
      <Widget data={{ revenue: [1, 2, 3] }}>
        <Chart kind="line" data={revenue} />
      </Widget>
    `)
    expect(r).toEqual({ ok: true })
  })
})
