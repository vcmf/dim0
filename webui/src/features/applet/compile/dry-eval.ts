// Author-time render smoke-test (applet-implementation.md Phase 6).
//
// `validateApplet` compiles the source to a tree, but a tree that *compiles* can
// still *throw at render* — the class the agent never learned about, because the
// live renderer degrades expression failures to blank and lets a bad component
// prop escape to the on-canvas error boundary (e.g. a `<Chart>` whose `data`
// evaluates to a non-array → recharts throws "e is not iterable").
//
// This does a headless, DOM-free dry-run over the tree with the applet's DECLARED
// initial state: it runs every rendered expression through the real interpreter
// (un-degraded, so a throw surfaces instead of being swallowed) and asserts that
// array-iterating components receive arrays. It mirrors the renderer's walk — only
// the taken `cond` branch, the first `list` item — so a correctly-guarded branch
// (`user ? <div>{user.name}</div> : null`) is never falsely flagged. Runtime-only
// failures (state reached only after an interaction, a bad datum *shape* inside an
// array) are out of scope and documented as such.

import { CHART_TYPES } from "../render/chart/types"
import { evalExpr, makeCtx, type Env, type Expr } from "../interpreter"
import type { AppletTree, ElNode, JsonValue, Node } from "../tree"


export type SmokeResult = { ok: true } | { ok: false; message: string }


// Props that a component iterates internally and that throw ("e is not iterable")
// when handed a non-array. From the real component impls: GraphElement maps
// `nodes`/`edges` unguarded; MapElement maps `data`/`markers`. Kept small + explicit;
// a general per-component prop schema on the registry would subsume this (§14.4).
//
// NOTE: `Chart` is intentionally absent HERE. The Chart.js applet chart takes a config
// OBJECT (`data={{ labels, datasets: [{ data }] }}`), not a top-level array, so the
// array-prop heuristic doesn't apply — it has its own config-shape check (`checkChart`),
// which catches the silent-blank mistakes (wrong `data` shape, bad `type`).
//
// The check is deliberately conservative — see `walkElement`: it flags only a prop
// that is present AND evaluates to a non-array, non-nullish value. A nullish value
// is left to the component's own handling (Map defaults it), so we never
// false-positive on an intentionally-empty binding. The cost is missing the
// "required prop left undefined" crash (e.g. Graph without edges) — a documented gap.
const ARRAY_PROPS: Record<string, readonly string[]> = {
  Graph: ["nodes", "edges"],
  Map: ["data", "markers"],
}


/** Signals a smoke-test failure with an author-facing message (distinct from an
 *  interpreter throw, which we wrap with its own context). */
class SmokeFail extends Error {}


/**
 * Dry-run the compiled tree against its declared initial state. Returns `ok` when
 * nothing throws and every array-iterating component gets an array; otherwise a
 * message describing the first failure, for the agent to self-correct on.
 */
export function smokeTestApplet(tree: AppletTree): SmokeResult {
  const state = { ...(tree.scopes.state ?? {}) }
  const data = tree.scopes.data ?? {}

  // Compute `derived` first (un-degraded): a throwing derived is a real bug the
  // renderer would otherwise hide.
  const derived: Record<string, unknown> = {}
  const derivedEnv = buildEnv(state, data, {})
  for (const [name, expr] of Object.entries(tree.scopes.derived ?? {})) {
    try {
      derived[name] = evalExpr(expr, derivedEnv, makeCtx())
    } catch (e) {
      return { ok: false, message: `the \`derived\` value \`${name}\` fails to evaluate: ${errText(e)}` }
    }
  }

  const env = buildEnv(state, data, derived)
  try {
    walk(tree.root, env)
  } catch (e) {
    if (e instanceof SmokeFail) return { ok: false, message: e.message }
    return { ok: false, message: `the applet throws while rendering: ${errText(e)}` }
  }
  return { ok: true }
}


/** Recursively evaluate a node's expressions, mirroring the renderer's walk. Throws
 *  a `SmokeFail` (array-prop violation) or an interpreter error (bad expression). */
function walk(node: Node, env: Env): void {
  switch (node.k) {
    case "txt":
      if (node.x) evalExpr(node.x, env, makeCtx())
      return
    case "el":
      walkElement(node, env)
      return
    case "cond": {
      // Only the taken branch renders, so only it is walked — an untaken,
      // correctly-guarded branch must not be evaluated (it may legitimately throw
      // on the initial state the guard is protecting against).
      const branch = evalExpr(node.test, env, makeCtx()) ? node.then : node.else
      if (branch) walk(branch, env)
      return
    }
    case "list": {
      const src = evalExpr(node.src, env, makeCtx())
      // A non-array `src` renders nothing (the renderer guards it) — not a throw,
      // so not a failure here. Walk the template once (first item) to surface
      // template-level expression errors.
      if (Array.isArray(src) && src.length > 0) {
        const childEnv: Env = new Map(env)
        childEnv.set(node.item, src[0])
        if (node.index) childEnv.set(node.index, 0)
        walk(node.tpl, childEnv)
      }
      return
    }
  }
}


/** Evaluate an element's bound props, enforce the array-prop contract for
 *  iterating components, then walk its children. Handlers are skipped (they need a
 *  `$event` that only exists at interaction time). */
function walkElement(node: ElNode, env: Env): void {
  const bound: Record<string, unknown> = {}
  if (node.bind) {
    for (const [name, expr] of Object.entries(node.bind)) {
      bound[name] = evalExpr(expr as Expr, env, makeCtx())
    }
  }

  if (node.tag === "Chart") checkChart(node, bound)

  const arrayProps = ARRAY_PROPS[node.tag]
  if (arrayProps) {
    for (const prop of arrayProps) {
      // Only check a prop the author actually set (bound or literal); an absent
      // prop is the component's own default, not this applet's bug.
      const isBound = node.bind ? prop in node.bind : false
      const isLiteral = node.props ? prop in node.props : false
      if (!isBound && !isLiteral) continue
      const value: unknown = isBound ? bound[prop] : (node.props as Record<string, JsonValue>)[prop]
      // Nullish is left to the component (see ARRAY_PROPS note); only a concrete
      // non-array value is a definite crash.
      if (value != null && !Array.isArray(value)) {
        throw new SmokeFail(
          `<${node.tag}> prop \`${prop}\` must be an array, but it evaluates to ${typeName(value)} on the ` +
            `initial state. Initialize it as an array (e.g. a \`data\`/\`state\` array literal) so the ` +
            `applet renders instead of throwing.`,
        )
      }
    }
  }

  if (node.children) for (const child of node.children) walk(child, env)
}


/**
 * Validate a `<Chart>`'s config shape — the silent-blank class the live renderer swallows
 * (a wrong `data` shape makes Chart.js draw nothing; a bad `type` breaks it) — against the
 * resolved props on the initial state. Throws a `SmokeFail` with an actionable message.
 * Conservative like the array-prop check: an absent/nullish `data`, or empty `datasets`,
 * is left to the renderer (an intentionally-empty chart), never flagged.
 */
function checkChart(node: ElNode, bound: Record<string, unknown>): void {
  // A prop's value if the author set it (as a `{expr}` binding or a literal attr), else absent.
  const resolve = (name: string): { present: boolean; value: unknown } => {
    if (node.bind && name in node.bind) return { present: true, value: bound[name] }
    if (node.props && name in node.props) return { present: true, value: (node.props as Record<string, JsonValue>)[name] }
    return { present: false, value: undefined }
  }
  const valid = CHART_TYPES.join(", ")

  const type = resolve("type")
  if (!type.present) {
    throw new SmokeFail(`<Chart> needs a \`type\` — one of ${valid}. e.g. \`<Chart type="bar" data={{ labels, datasets: [{ data }] }} />\`.`)
  }
  // Reject any present, non-nullish type that isn't a valid kind — a string typo AND a
  // non-string (a number/object from a bad binding), both of which break the renderer. A
  // nullish resolved value (a dynamic type not yet set) is left alone, like `data` below.
  if (type.value != null && !(typeof type.value === "string" && (CHART_TYPES as readonly string[]).includes(type.value))) {
    throw new SmokeFail(`<Chart> \`type\` must be one of ${valid} — got ${JSON.stringify(type.value)}.`)
  }

  // `data` is optional (omitted → an empty chart, not a crash); only a PRESENT, non-nullish
  // value is shape-checked.
  const data = resolve("data")
  if (!data.present || data.value == null) return
  const d = data.value
  if (Array.isArray(d)) {
    throw new SmokeFail(
      `<Chart> \`data\` must be an object \`{ labels, datasets: [{ data: [...] }] }\`, not a top-level array. ` +
        `Every type — pie/doughnut included — uses that same shape (no per-slice \`{ name, value }\` objects).`,
    )
  }
  if (typeof d !== "object") {
    throw new SmokeFail(`<Chart> \`data\` must be an object \`{ labels, datasets: [{ data: [...] }] }\`, but it evaluates to ${typeName(d)}.`)
  }
  const datasets = (d as Record<string, unknown>).datasets
  if (!Array.isArray(datasets)) {
    throw new SmokeFail(
      `<Chart> \`data\` needs a \`datasets\` array: \`data={{ labels: [...], datasets: [{ data: [...] }] }}\`. ` +
        `Put the numbers under \`datasets[].data\`, not directly on \`data\`.`,
    )
  }
  datasets.forEach((ds, i) => {
    if (ds == null || typeof ds !== "object" || Array.isArray(ds)) {
      throw new SmokeFail(`<Chart> dataset ${i} must be an object like \`{ label: "Sales", data: [10, 20, 30] }\`, but it is ${typeName(ds)}.`)
    }
    const dsObj = ds as Record<string, unknown>
    // A MISSING `data` key is the recharts/`{ name, value }` mistake → flag. A present but
    // nullish `data` (a dynamic binding not yet populated) renders empty → leave it, like
    // the top-level nullish policy.
    if (!("data" in dsObj)) {
      throw new SmokeFail(
        `<Chart> dataset ${i} has no \`data\` array — put the numbers under \`data\`: \`{ data: [10, 20, 30] }\`. ` +
          `Even pie/doughnut use this; a \`{ name, value }\` per-slice object is the old shape.`,
      )
    }
    if (dsObj.data != null && !Array.isArray(dsObj.data)) {
      throw new SmokeFail(`<Chart> dataset ${i}'s \`data\` must be an array (e.g. \`[10, 20, 30]\`), but it is ${typeName(dsObj.data)}.`)
    }
  })
}


/** Identifier scope: data < state < derived (later wins), matching the renderer. */
function buildEnv(
  state: Record<string, unknown>,
  data: Record<string, unknown>,
  derived: Record<string, unknown>,
): Env {
  return new Map<string, unknown>([...Object.entries(data), ...Object.entries(state), ...Object.entries(derived)])
}


/** A short, human type label (with article) for the array-prop failure message. */
function typeName(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (Array.isArray(value)) return "an array"
  const t = typeof value
  return `${t === "object" ? "an" : "a"} ${t}`
}


/** The message of a thrown value, defensively (interpreter errors are `Error`s). */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
