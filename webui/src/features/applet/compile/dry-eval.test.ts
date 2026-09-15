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
  // NOTE: `Chart` isn't array-validated here (its config is an object, not a top-level
  // array); it has its own config-shape check — see the "Chart config shape" block below.

  it("passes a Graph/Map with array props", () => {
    const t = tree(`
      <Widget data={{ nodes: [{ id: "a" }], edges: [], pins: [{ lat: 0, lng: 0 }] }}>
        <div><Graph nodes={nodes} edges={edges} /><Map markers={pins} /></div>
      </Widget>
    `)
    expect(smokeTestApplet(t)).toEqual({ ok: true })
  })

  it("fails a Graph whose edges bind to a non-array (the `e is not iterable` class)", () => {
    const t = tree(`
      <Widget data={{ nodes: [], e: 5 }}>
        <Graph nodes={nodes} edges={e} />
      </Widget>
    `)
    const r = smokeTestApplet(t)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toContain("<Graph>")
      expect(r.message).toContain("`edges`")
      expect(r.message).toContain("must be an array")
      expect(r.message).toContain("a number")
    }
  })

  it("fails a Map with a literal non-array markers prop", () => {
    const t = tree(`<Widget><Map markers={42} /></Widget>`)
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

  it("does not flag a Map that omits its props (component default, not an applet bug)", () => {
    const t = tree(`<Widget><Map /></Widget>`)
    expect(smokeTestApplet(t)).toEqual({ ok: true })
  })

  it("does not flag a nullish binding (left to the component's own handling)", () => {
    // `pins` is null initially — conservative: not our crash to flag (Map defaults
    // it), so this passes rather than false-positiving.
    const t = tree(`<Widget state={{ pins: null }}><Map markers={pins} /></Widget>`)
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
    // `sel` is null, so the `sel ? <Graph nodes={bad}/> : …` branch — whose non-array
    // `nodes` WOULD flag if walked — must NOT be evaluated. The guard is the point.
    const t = tree(`
      <Widget state={{ sel: null }} data={{ bad: 5 }}>
        <div>{sel ? <Graph nodes={bad} edges={[]} /> : <span>none</span>}</div>
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
    const r = validateApplet(`<Widget data={{ n: 5 }}><Graph nodes={n} edges={[]} /></Widget>`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain("must be an array")
  })

  it("accepts a valid applet", () => {
    const r = validateApplet(`
      <Widget data={{ revenue: [1, 2, 3], labels: ["a", "b", "c"] }}>
        <Chart type="line" data={{ labels: labels, datasets: [{ data: revenue }] }} />
      </Widget>
    `)
    expect(r).toEqual({ ok: true })
  })
})


describe("smokeTestApplet — Chart config shape", () => {
  const ok = (source: string) => expect(validateApplet(source)).toEqual({ ok: true })
  const failsWith = (source: string, needle: string) => {
    const r = validateApplet(source)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain(needle)
  }

  it("passes the canonical bar/pie shape (same { labels, datasets } for both)", () => {
    ok(`<Widget data={{ nums: [10, 20, 30] }}><Chart type="bar" data={{ labels: ["a", "b", "c"], datasets: [{ data: nums }] }} /></Widget>`)
    ok(`<Widget data={{ nums: [40, 30, 20, 10] }}><Chart type="pie" data={{ labels: ["A", "B", "C", "D"], datasets: [{ data: nums }] }} /></Widget>`)
  })

  it("passes a Chart with no data (an empty chart, not a crash)", () => {
    ok(`<Widget data={{}}><Chart type="line" /></Widget>`)
  })

  it("flags a missing type", () => {
    failsWith(`<Widget data={{ nums: [1, 2] }}><Chart data={{ datasets: [{ data: nums }] }} /></Widget>`, "needs a `type`")
  })

  it("flags an invalid (string) type", () => {
    failsWith(`<Widget data={{ nums: [1, 2] }}><Chart type="piechart" data={{ datasets: [{ data: nums }] }} /></Widget>`, "must be one of")
  })

  it("flags a non-string type from a bad binding (not just a string typo)", () => {
    failsWith(`<Widget data={{ t: 5 }}><Chart type={t} data={{ datasets: [{ data: [1] }] }} /></Widget>`, "must be one of")
  })

  it("flags data as a top-level array (the old recharts/pie shape)", () => {
    failsWith(`<Widget data={{ rows: [{ name: "A", value: 10 }] }}><Chart type="pie" data={rows} /></Widget>`, "not a top-level array")
  })

  it("flags a data object with no datasets", () => {
    failsWith(`<Widget data={{ nums: [10, 20, 30] }}><Chart type="bar" data={{ data: nums }} /></Widget>`, "needs a `datasets` array")
  })

  it("flags a dataset with no data key (per-slice { name, value } — the old shape)", () => {
    failsWith(`<Widget data={{ slices: [{ name: "A", value: 10 }] }}><Chart type="pie" data={{ datasets: slices }} /></Widget>`, "has no `data` array")
  })

  it("allows a dataset whose data binding is nullish on the initial state (populated later)", () => {
    ok(`<Widget state={{ sales: null }}><Chart type="bar" data={{ datasets: [{ label: "Sales", data: sales }] }} /></Widget>`)
  })

  it("allows an intentionally-empty datasets array", () => {
    ok(`<Widget data={{}}><Chart type="bar" data={{ labels: [], datasets: [] }} /></Widget>`)
  })
})
