You are authoring an **applet** — a declarative, interactive widget for the board. Follow this skill over generic note-writing habits.

Your goal is to produce one applet source string and store it via `write_note(note_type="applet", content=<source>)`.

Use an applet for anything custom-rendered or interactive that isn't a sheet, code-sandbox, or document: charts, dashboards, node-link diagrams, maps, comparison tables, counters, todo lists, steppers, quizzes, calculators, flashcards, visual explainers.

---

## What you're authoring — this is NOT free-form React

An applet is **declarative**. You compose from a fixed palette of components, values are a **restricted subset of JS expressions**, and behavior is a **small closed set of action verbs**. There is no `useState`, no `useEffect`, no closures, no imports, no host globals. The runtime interprets your source directly (no `eval`), so anything outside the grammar below is rejected at write time with a `line:col` error — fix it and retry.

Think of it as: **structure looks like JSX, values are JS expressions, behavior is a few verbs.**

---

## The exact contract

You write **one** `<Widget>` element with **exactly one child**:

```jsx
<Widget state={{ … }} data={{ … }} derived={{ … }} persist>
  <Card> … </Card>
</Widget>
```

The three scopes on `<Widget>` are all optional; their keys are in scope as bare identifiers everywhere inside:

- **`state={{ … }}`** — mutable state (literal JSON). The only thing actions change. e.g. `state={{ count: 0, items: [] }}`.
- **`data={{ … }}`** — constants (literal JSON), computed once. Put fixed data here (chart data, table rows, quiz questions) — NOT in `state`. e.g. `data={{ rows: [...] }}`.
- **`derived={{ … }}`** — named **expressions** (not literals) memoized from `state`/`data`. Use to avoid repeating a computation. e.g. `derived={{ total: revenue.reduce((a, b) => a + b, 0) }}`.
- **`persist`** — a bare boolean flag. Add it when the widget's `state` should survive a reload (counter value, todo items). Omit it for ephemeral widgets (a stepper, a calculator). State persists per-device, local-first; the applet's source itself is board content and syncs normally.

**Rules — these reject at write time:**
- No `import`, no `require`, no `function`/`const`/`useState`/`useEffect` — there is no component body, just the `<Widget>` tree.
- No globals: `window`, `document`, `fetch`, `localStorage`, `setTimeout`, `console`, `eval`, `Function`, `Math.random`, `Date.now`. (Randomness/time are banned — expressions must be deterministic.)
- Keys defined in more than one scope (state/data/derived) are rejected — pick one.
- **Reference scope values by their BARE name — never `data.x` / `state.x` / `derived.x`.** The scopes are spread into scope; `data`/`state`/`derived` are not objects you dot into. With `data={{ steps: [...] }}` you write `steps` and `steps.length`, NOT `data.steps`. (`data.steps` throws `undefined reference: data` at render.)

---

## Structure — components + intrinsics only

Use only these tags. Anything else ("unknown component") rejects.

### Components
- `<Card className?>`, `<CardHeader>`, `<CardTitle>`, `<CardContent>`, `<CardFooter>` — the container family.
- `<Button variant? size? onClick?>` — variants: `default | destructive | outline | secondary | ghost | link`.
- `<Chart>`, `<Graph>`, `<Map>`, `<Table>` — see signatures below.

### HTML intrinsics (whitelisted)
`div span p ul ol li h1`–`h6` · `table thead tbody tr th td` · `b i em strong small code pre kbd br hr` · `img` · `input textarea select option label button`.
No `style` attribute and no `dangerouslySetInnerHTML` (rejected). `className` + normal attributes (`type`, `placeholder`, `value`, `checked`, `disabled`, `colSpan`, …) are fine.

---

## Values — the expression grammar

Anywhere you write `{ … }` (a prop value or a child), you may use a **strict subset of JS expressions**:

- **Literals**: strings, numbers, booleans, null. (No regex, no bigint.)
- **Identifiers**: any `state`/`data`/`derived` key, a `.map` parameter, or `$event` (in handlers).
- **Member access**: `a.b`, `a[i]`, optional `a?.b`.
- **Operators**: arithmetic `+ - * / % **`, comparison `=== !== < <= > >=`, logical `&& || ??`, ternary `cond ? a : b`, unary `! - + typeof`.
- **Template literals**: `` `${name}: ${count}` ``.
- **Array / object literals** with spread: `[...items, x]`, `{ ...it, done: true }`.
- **Whitelisted method calls only**:
  - Array: `map filter reduce find findIndex some every sort flatMap includes indexOf slice at concat join flat`
  - String: `toUpperCase toLowerCase slice substring includes indexOf startsWith endsWith split trim padStart padEnd replace repeat at charAt`
  - Number: `toFixed toString`
  - Globals: `Math.*` (abs/min/max/round/floor/ceil/sqrt/pow/sign/trunc/hypot/log/…), `Object.keys/values/entries`, `Array.isArray`, and the coercions `Number(x)` / `String(x)` / `Boolean(x)`.
  - Helper: `cn(...classes)` — merge Tailwind class names (clsx + tailwind-merge). The idiomatic way to compose a conditional `className`, e.g. `className={cn("text-sm", done && "line-through text-muted-foreground")}`.
- **Arrows** are allowed **only as an array-method callback**: `items.filter(x => x.done)`, `rows.map(({ id, name }) => …)` (destructuring params ok). A bare arrow anywhere else rejects.

**Not allowed** (reject): assignment (`x = 1`), `++`/`--`, `new`, `delete`, calling anything not whitelisted, and every banned global above.

---

## Lists and conditionals (structure from expressions)

- **List** — a `.map` returning an element becomes a list:
  ```jsx
  <ul>{items.map((it, i) => <li key={it.id}>{it.text}</li>)}</ul>
  ```
  Prefer items that carry a stable **`id`** (used as the React key); otherwise the index is used and reordering is unstable.
- **Conditional** — a ternary or `&&` with an element branch:
  ```jsx
  {open ? <span>on</span> : <span>off</span>}
  {items.length === 0 && <p className="text-muted-foreground">no items yet</p>}
  ```

---

## Behavior — the 5 action verbs (event handlers only)

Actions appear **only** in event handlers (`onClick`, `onChange`, `onKeyDown`, `onInput`, `onKeyUp`, `onSubmit`, `onBlur`, `onFocus`). There are exactly five verbs:

| Verb | Meaning |
|---|---|
| `set(path, expr)` | set `state.<path>` to the evaluated expression |
| `toggle(path)` | flip a boolean at `state.<path>` |
| `append(path, expr)` | push onto an array at `state.<path>` |
| `toast(message, level?)` | flash a message (`level`: `"info"` \| `"error"`) |
| `batch(a, b, …)` | run several actions in one commit |

- **`path` is a static string literal** — `"count"`, `"user.name"`. Never a computed/interpolated path.
- **Array-item edits use `set` with an immutable expression**, not an index path:
  ```jsx
  onClick={set("items", items.filter(x => x.id !== it.id))}                          // remove
  onChange={set("items", items.map(x => x.id === it.id ? { ...x, done: !x.done } : x))}  // toggle one
  ```
- **Guarded handlers**: `cond && action`, `cond ? actionA : actionB`, and chains (`a && b && action`).
- **`$event`** is the sanitized event, with `.value` (input value), `.checked` (checkbox), `.key` (keydown): `onChange={set("draft", $event.value)}`, `onKeyDown={$event.key === "Enter" && append("items", draft)}`.
- **`$event.value` is always a string** — even for `<input type="number">`. Wrap it with the `Number(...)` coercion when you need a number: `onChange={set("bill", Number($event.value))}`.

---

## Component signatures

### `<Chart kind data? datasets? labels? yAxis? xAxis? legend? tooltip? height? />`
- `kind`: `"bar" | "line" | "area" | "scatter" | "pie" | "composed"`.
- Single series: `data={[42, 58, 71]}`. Multi-series: `datasets={[{ label, data: [...], color? }, …]}`. Use `data` OR `datasets`, never both.
- `labels` default to `"0","1",…`. `kind="pie"`: pass `data={[{ name, value }, …]}`.
- Colors: palette names (`"primary"`, `"chart-1"`…`"chart-5"`, …) that re-theme; avoid raw hex.

### `<Graph nodes edges layout? directed? root? viewBox? height? />`
- `nodes`: `[{ id, label?, sublabel?, color?, x?, y? }]`; `edges`: `[{ a, b, label?, color? }]` (`a → b`).
- `layout`: `"force"` (default, auto-arranges networks) · `"tree"` (top-down hierarchy; set `root`) · `"manual"` (you supply `x`/`y`). `directed` draws arrowheads.

### `<Map data? markers? color? height? />`
- `data`: `[{ id, value?, color? }]` — `id` is a country's English name (`"France"`) or ISO numeric code; `value` shades `color` by magnitude.
- `markers`: `[{ lat, lng, label?, color?, r? }]`. Geometry is built in — supply data only.

### `<Table columns rows sortable? className? />`
- `columns`: `["name", "score"]` or `[{ key, label? }, …]`. `rows`: `[{ name: …, score: … }, …]`.
- `sortable` makes headers click-to-sort.

---

## Worked examples

### Counter (persisted)
```jsx
<Widget state={{ count: 0 }} persist>
  <Card className="p-4 max-w-sm">
    <CardHeader><CardTitle>Counter</CardTitle></CardHeader>
    <CardContent>
      <div className="text-3xl font-bold mb-3">{count}</div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={set("count", count - 1)}>–</Button>
        <Button onClick={set("count", count + 1)}>+</Button>
        <Button variant="ghost" onClick={set("count", 0)}>reset</Button>
      </div>
    </CardContent>
  </Card>
</Widget>
```

### Todo (input + $event + append/batch + .map + immutable edits)
```jsx
<Widget state={{ items: [], draft: "", nextId: 1 }} persist>
  <Card className="p-4 max-w-md">
    <CardHeader><CardTitle>Todo</CardTitle></CardHeader>
    <CardContent>
      <div className="flex gap-2 mb-3">
        <input
          className="flex-1 rounded-md border px-2 py-1 text-sm"
          placeholder="add a task"
          value={draft}
          onChange={set("draft", $event.value)}
          onKeyDown={$event.key === "Enter" && draft.trim() !== "" && batch(
            append("items", { id: nextId, text: draft, done: false }),
            set("nextId", nextId + 1),
            set("draft", "")
          )}
        />
        <Button onClick={draft.trim() !== "" && batch(
          append("items", { id: nextId, text: draft, done: false }),
          set("nextId", nextId + 1),
          set("draft", "")
        )}>add</Button>
      </div>
      <ul className="space-y-1">
        {items.map(it => (
          <li key={it.id} className="flex items-center gap-2">
            <input type="checkbox" checked={it.done}
              onChange={set("items", items.map(x => x.id === it.id ? { ...x, done: !x.done } : x))} />
            <span className={cn("flex-1 text-sm", it.done && "line-through text-muted-foreground")}>{it.text}</span>
            <Button variant="ghost" size="sm" onClick={set("items", items.filter(x => x.id !== it.id))}>✕</Button>
          </li>
        ))}
        {items.length === 0 && <li className="text-sm text-muted-foreground">no items yet</li>}
      </ul>
    </CardContent>
  </Card>
</Widget>
```

### Stepper (ephemeral — no `persist`; `data` holds the fixed steps)
```jsx
<Widget state={{ i: 0 }} data={{ steps: ["Buy ingredients", "Mix batter", "Bake at 180°C for 25min", "Cool + frost"] }}>
  <Card className="p-4 max-w-sm">
    <CardHeader><CardTitle>Step {i + 1} of {steps.length}</CardTitle></CardHeader>
    <CardContent>
      <p className="mb-3">{steps[i]}</p>
      <div className="flex gap-2">
        <Button variant="outline" disabled={i === 0} onClick={set("i", i - 1)}>back</Button>
        <Button disabled={i === steps.length - 1} onClick={set("i", i + 1)}>next</Button>
      </div>
    </CardContent>
  </Card>
</Widget>
```

### Bar chart (static — `data` only)
```jsx
<Widget data={{ labels: ["Oct", "Nov", "Dec"], sales: [42, 58, 71] }}>
  <Card className="p-4 max-w-md">
    <CardHeader><CardTitle>Q4 sales (k$)</CardTitle></CardHeader>
    <CardContent>
      <Chart kind="bar" labels={labels} data={sales} color="primary" height={220} />
    </CardContent>
  </Card>
</Widget>
```

### Multi-series line chart
```jsx
<Widget data={{
  months: ["Jan", "Feb", "Mar", "Apr", "May"],
  revenue: [120, 132, 145, 160, 178],
  cost: [80, 88, 95, 102, 110]
}}>
  <Card className="p-4 max-w-md">
    <CardHeader><CardTitle>Revenue vs cost</CardTitle></CardHeader>
    <CardContent>
      <Chart kind="line" labels={months}
        datasets={[
          { label: "Revenue", data: revenue, color: "chart-1" },
          { label: "Cost", data: cost, color: "chart-2" }
        ]}
        height={220} />
    </CardContent>
  </Card>
</Widget>
```

### Dashboard (`data` + `derived` stat tiles + chart)
```jsx
<Widget
  data={{ months: ["Jan", "Feb", "Mar", "Apr", "May"], revenue: [120, 132, 145, 160, 178] }}
  derived={{
    total: revenue.reduce((a, b) => a + b, 0),
    peak: Math.max(...revenue),
    avg: Math.round(revenue.reduce((a, b) => a + b, 0) / revenue.length)
  }}
>
  <Card className="p-4 max-w-2xl">
    <CardHeader><CardTitle className="font-handwriting text-xl">Q1 Overview</CardTitle></CardHeader>
    <CardContent>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="rounded-lg bg-secondary text-secondary-foreground p-3">
          <div className="text-xs text-muted-foreground">Total</div>
          <div className="text-2xl font-bold">{total}</div>
        </div>
        <div className="rounded-lg bg-secondary text-secondary-foreground p-3">
          <div className="text-xs text-muted-foreground">Peak</div>
          <div className="text-2xl font-bold">{peak}</div>
        </div>
        <div className="rounded-lg bg-secondary text-secondary-foreground p-3">
          <div className="text-xs text-muted-foreground">Avg</div>
          <div className="text-2xl font-bold">{avg}</div>
        </div>
      </div>
      <Chart kind="line" labels={months} data={revenue} color="chart-1" height={200} />
    </CardContent>
  </Card>
</Widget>
```

### Sortable table
```jsx
<Widget data={{ rows: [
  { name: "Alice", score: 88 },
  { name: "Bob", score: 92 },
  { name: "Cara", score: 79 }
] }}>
  <Card className="p-4 max-w-md">
    <CardHeader><CardTitle>Scores</CardTitle></CardHeader>
    <CardContent>
      <Table columns={["name", "score"]} rows={rows} sortable />
    </CardContent>
  </Card>
</Widget>
```

---

## Style guidelines

- Default to compact widgets — `max-w-sm` for single-purpose, `max-w-md` for lists, `max-w-2xl` for dashboards.
- Use `Card` as the outer child so the widget feels native to the board.
- For a bounded scroll area inside the widget (a long log, a fixed-height list), pair `overflow-y-auto` with the `scrollbar-thin` utility.

---

## Typography

Mix three families like a notebook layout — handwriting for headings, mono for code, sans for everything else (utility classes ship with the runtime).

- `font-handwriting` — titles/callouts. Use sparingly, usually on `<CardTitle>`.
- `font-mono` — code-like things: shortcuts, variable names, raw values.
- `font-sans` — the default; body copy, labels, buttons.

```jsx
<CardHeader>
  <CardTitle className="font-handwriting text-2xl">Counter</CardTitle>
  <p className="text-sm text-muted-foreground">Press <kbd className="font-mono">+</kbd> to add</p>
</CardHeader>
```

Don't apply `font-handwriting` to long blocks — playful but tiring past a sentence.

---

## Colors

The host runs six themes × {light, dark}, and the applet inherits whichever is active. Stay inside the semantic palette so it themes for free.

**Two rules that matter most:**

1. **Every colored background needs its matching foreground** — use them together:
   `bg-primary text-primary-foreground` · `bg-secondary text-secondary-foreground` · `bg-destructive text-destructive-foreground` · `bg-muted text-muted-foreground` / `bg-accent text-accent-foreground`. Body text on a colored background with no paired foreground is the #1 cause of unreadable widgets.
2. **`primary` is a high-contrast extreme — use it sparingly** (the one main action). Reach for `secondary` (with `text-secondary-foreground`) as your default themed surface; `muted` / `accent` are the calm neutral surfaces.

**For variety / categorical color, use the `chart-1`…`chart-5` ramp** — tuned per theme to be vivid *and* harmonious. Available as `color="chart-1"` props (Chart/Graph) and as `bg-chart-1` / `text-chart-1` / `border-chart-1` classes.

**Semantic token cheat-sheet.**

| Want | Class |
|---|---|
| Card background | `bg-card` |
| Page background | `bg-background` |
| Default themed surface | `bg-secondary text-secondary-foreground` |
| Main action (use once) | `bg-primary text-primary-foreground` |
| Muted / neutral surface | `bg-muted` / `bg-accent` |
| Body text | `text-foreground` (default) |
| Subdued text | `text-muted-foreground` |
| Destructive action | `bg-destructive text-destructive-foreground` |
| Categorical color | `bg-chart-1`…`bg-chart-5` (and `text-`/`border-`) |
| Border | `border` |

For charts/graphs, pass `color="chart-1"`…`"chart-5"` (or `"primary"` / `"destructive"`) rather than literal hex.

**Never** use raw hex (`#965e30`), `rgb()`, named colors (`"red"`), or pure black/white — they don't theme. (Applet elements can't set a raw `style` attribute anyway; stick to classes.)

Theming is automatic — when the user flips themes, the applet re-themes without losing its state. Just stay inside the semantic palette.

---

## Verification before you submit

Walk these before calling `write_note(note_type="applet", …)`:

1. The source is a single `<Widget>` with **exactly one** child element.
2. Every identifier is a `state`/`data`/`derived` key, a `.map` param, `$event` (handlers only), a registered component, or a whitelisted intrinsic.
3. Values use only the allowed expression grammar — no `useState`/`useEffect`/`function`, no `import`, no `window`/`fetch`/`Math.random`, no regex.
4. Every event handler is one of the 5 verbs (optionally guarded), and every `set`/`toggle`/`append` path is a **static string literal**. Array-item edits use `set` + an immutable `.map`/`.filter`.
5. Add `persist` iff the state should survive reload. Fixed data lives in `data`, not `state`.

If you can't tick all five, fix the source first — the validator rejects grammar violations at write time with a `line:col` message you can correct in the same turn.
