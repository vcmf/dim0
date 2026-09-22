# SKILL — legacy HTML widget

> **Prefer `learn_generate_applet`** for any new widget. The applet skill handles
> the same chart / dashboard / diagram / flashcard cases via a declarative React +
> Tailwind widget, with interactive state, theme propagation, and the
> same scope of primitives — it's the default custom-rendered artifact.
> This HTML widget skill exists for narrow cases only:
> - the user explicitly asked for raw HTML, or
> - you're editing an existing `note_type="widget"` note that should NOT be migrated.
> If neither applies, stop reading and call `learn_generate_applet` instead.

---

# SKILL (high priority, when applicable)
You are building a self-contained HTML widget for the board. Follow this skill over generic note-writing habits.

Your goal is to produce one widget and store it with `write_note`.

---

## Before you build, pick the intent

Answer in one sentence each — do not skip, do not write HTML yet:

1. **Intent** — is this to *learn* (understand a concept), *note* (capture an insight), or *present* (show one idea to someone else)?
2. **Core concept** — the one thing this widget must convey.
3. **Format** — which item from the menu below, and why.

Intent shapes density:
- *learn* → explanatory, can have multiple panels, more detail
- *note* → compact, one idea, minimal chrome
- *present* → hero-scale, oversized type, one idea per screen

Match scope to complexity. A simple concept needs one clear panel, not five.

---

## The canvas this widget lives on

The widget sits on a warm-parchment board next to handwritten notes. The surrounding nodes are in `Architects Daughter` (handwriting) on a soft off-white background with sienna accents. The widget should feel like it belongs on that surface — not like a shadcn card dropped onto it.

Echo the canvas voice in titles and short captions. Keep dense content (charts, data, labels) in the default sans for legibility.

---

## Format menu — reach for these before defaulting to text

- **Hero / key number / pull-quote** — for *present*: one oversized idea, centered, nothing else competing
- **Small inline chart** — for any quantity, proportion, or trend (Chart.js is fine)
- **Step / flow diagram** — for any process, sequence, or cause-effect chain
- **Animated diagram** — for anything that moves, oscillates, flows, or transforms
- **Slider or toggle** — for any range, tradeoff, or before/after comparison
- **Comparison grid** — for two or more options with shared attributes
- **Progressive reveal** — for concepts that build on each other step by step

Ask yourself: is there a number that could be a chart? A process that could be a flow? A range that could be a slider? Prefer those over static text whenever the concept supports it.

Mix formats within a single widget only when each adds a distinct insight. **Variety should come from what you show, not how you style it.**

---

## Budget rule

The widget's budget is **explanation, not decoration**. Every line of CSS and JS must earn its place by making the concept clearer. A great widget looks like it was designed by an *educator*, not a frontend developer.

Ask *"does this help someone understand?"* not *"does this look polished?"*

---

## Typography pairing

Two font tokens are available inside the iframe:

- `var(--font-sans)` — Atkinson Hyperlegible Next. **This is the default** — body copy, labels, chart ticks, numbers, data, code. Anywhere legibility matters.
- `var(--font-handwriting)` — Architects Daughter. **Use sparingly** for titles, section headers, short captions, and hand-drawn-style annotations. This is what matches the canvas voice.

Rules:
- Never set handwriting on paragraphs, data tables, or numeric displays — it hurts scanning.
- Never set handwriting on code or tick labels.
- A widget with *zero* handwriting is fine if the content is all data.
- A widget with *only* handwriting is wrong — it becomes a sticky note, not an explainer.

Typical good balance: handwriting on the title and one caption; everything else default.

---

## Styling constraints

- Use theme tokens (listed below) rather than hardcoded colors
- 1–2 accent colors max — resist colorizing everything
- Keep `<style>` under ~50 lines; every line beyond that needs a reason
- Spacing: compact by default — small gaps and low padding unless readability clearly requires more
- Outer background: `var(--background)`, no outer border; use `var(--card)` only for intentional inner panels
- Design must work in both light and dark themes without changing the HTML

**Motion encodes meaning, not decoration.** A particle drifting to show flow — yes. A card fading in for no reason — no.

**One accent marks the important thing.** One `var(--chart-1)` on the key threshold beats every step in a different color.

---

## Theme tokens

```
var(--background)         var(--foreground)
var(--card)               var(--card-foreground)
var(--muted)              var(--muted-foreground)
var(--primary)            var(--primary-foreground)
var(--secondary)          var(--secondary-foreground)
var(--accent)             var(--accent-foreground)
var(--border)             var(--destructive)
var(--chart-1) … var(--chart-5)
var(--rounded)            var(--radius)
var(--shadow-sm)          var(--shadow-md)
var(--font-sans)          var(--font-handwriting)
```

Start with `var(--background)`, `var(--card)`, `var(--foreground)`, and one `var(--chart-*)` color. Only reach for more if the concept genuinely needs them.

---

## If nothing in the format menu fits

Some concepts are abstract and resist charts or diagrams. Use a clean typographic layout with one strong visual metaphor — a ratio, a scale, a contrast — rather than forcing an ill-fitting component. A well-structured text hierarchy beats a chart that doesn't encode anything real.

---

## Technical rules

- Put only the HTML that lives inside `<body>` in `content` — no `<!doctype>`, `<html>`, `<head>`, or `<body>` wrappers
- Self-contained: no external dependencies unless truly necessary
- If you need Chart.js or Reveal.js, include a `<script src="...">` tag — the frontend will hoist it to `<head>`
- Keep the widget lightweight and responsive inside an iframe
- Use plain HTML, CSS, and vanilla JS by default
- For first-time creation or substantial redesign: one `write_note` call with the complete widget
- For subsequent user tweaks: prefer targeted `edit_note` calls over full rewrites

---

## Canonical example

A *learn* widget explaining a threshold concept. Handwritten title + one caption; everything else is sans. One chart, one accent.

```html
<section style="padding: 20px; display: grid; gap: 14px;">
  <header style="display: grid; gap: 2px;">
    <h2 style="font-family: var(--font-handwriting); font-weight: 400; font-size: 22px; margin: 0; color: var(--foreground);">
      Fusion ignition threshold
    </h2>
    <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
      Temperature required for a self-sustaining reaction.
    </p>
  </header>

  <div style="background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px;">
    <canvas id="temp-chart" height="140"></canvas>
  </div>

  <p style="font-family: var(--font-handwriting); font-size: 15px; margin: 0; color: var(--muted-foreground);">
    Above <span style="color: var(--chart-1); font-weight: 600;">100M°C</span>, fusion becomes self-sustaining.
  </p>
</section>

<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script>
  const ctx = document.getElementById('temp-chart')
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--chart-1').trim()
  const muted = getComputedStyle(document.documentElement).getPropertyValue('--muted-foreground').trim()
  new Chart(ctx, {
    type: 'line',
    data: {
      labels: ['20M', '50M', '80M', '100M', '130M', '160M'],
      datasets: [{
        data: [0.1, 0.3, 0.7, 1.0, 1.4, 1.7],
        borderColor: accent,
        backgroundColor: 'transparent',
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2,
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: muted, font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: muted, font: { size: 10 } }, grid: { color: 'rgba(120,120,130,.12)' } },
      },
    },
  })
</script>
```

Imitate this voice: handwritten title, sans body, one panel, one accent, one caption.

---

## Call

```
write_note(content=..., note_type="widget", label=...)
```

Give the note a short, descriptive `label`.
