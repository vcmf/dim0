import { describe, expect, it } from "vitest"

import { compileApplet, validateApplet } from "./index"


// Assert compilation fails with a message matching `re`.
function failsWith(source: string, re: RegExp) {
  const r = compileApplet(source)
  expect(r.ok, `expected failure for: ${source}`).toBe(false)
  if (!r.ok) expect(r.message).toMatch(re)
}


describe("structural errors", () => {
  it("root must be <Widget>", () => {
    failsWith(`<div/>`, /root element must be <Widget>/)
  })

  it("<Widget> must wrap exactly one child", () => {
    failsWith(`<Widget><div/><div/></Widget>`, /exactly one child/)
  })

  it("unknown <Widget> attribute", () => {
    failsWith(`<Widget onClick={set("x", 1)}><div/></Widget>`, /unknown <Widget> attribute/)
  })

  it("unknown component", () => {
    failsWith(`<Widget><Sparkline/></Widget>`, /unknown component <Sparkline>/)
  })

  it("syntax error surfaces as a failure", () => {
    failsWith(`<Widget><div>{</div></Widget>`, /./)
  })
})


describe("expression-grammar errors", () => {
  it.each([
    [`<Widget><div>{a = 1}</div></Widget>`, /AssignmentExpression is not allowed/],
    [`<Widget><div>{a in b}</div></Widget>`, /operator 'in' is not allowed/],
    [`<Widget><div>{a instanceof b}</div></Widget>`, /operator 'instanceof' is not allowed/],
    [`<Widget><div>{[].constructor}</div></Widget>`, /forbidden property access: constructor/],
    [`<Widget><div>{delete a.b}</div></Widget>`, /operator 'delete' is not allowed/],
    [`<Widget><div>{(x => x)}</div></Widget>`, /arrow functions are only allowed/],
    [`<Widget><div>{new Thing()}</div></Widget>`, /NewExpression is not allowed/],
  ])("%s", (source, re) => {
    failsWith(source, re)
  })
})


describe("attribute + handler errors", () => {
  it("forbidden style attribute", () => {
    failsWith(`<Widget><div style={{}}/></Widget>`, /'style' attribute is not allowed/)
  })

  it("disallowed event handler", () => {
    failsWith(`<Widget><div onMouseOver={set("x", 1)}/></Widget>`, /event handler 'onMouseOver' is not allowed/)
  })

  it("action path must be static", () => {
    failsWith(`<Widget state={{ k: "" }}><Button onClick={set(k, 1)}>x</Button></Widget>`, /path must be a static string literal/)
  })

  it("handler must be an action", () => {
    failsWith(`<Widget><Button onClick={42}>x</Button></Widget>`, /must be an action/)
  })

  it("unknown action verb", () => {
    failsWith(`<Widget><Button onClick={reset("x")}>x</Button></Widget>`, /unknown action 'reset'/)
  })
})


describe("error positions", () => {
  it("carries a line number for a multi-line source", () => {
    const source = `<Widget>\n  <div>\n    {a = 1}\n  </div>\n</Widget>`
    const r = compileApplet(source)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.line).toBe(3)
  })
})


describe("validateApplet gate", () => {
  it("returns ok for a valid applet", () => {
    expect(validateApplet(`<Widget state={{ n: 0 }}><div>{n}</div></Widget>`)).toEqual({ ok: true })
  })

  it("returns the error for an invalid one", () => {
    const v = validateApplet(`<Widget><Nope/></Widget>`)
    expect(v.ok).toBe(false)
  })
})
