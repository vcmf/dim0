# Tool-result lifecycle — stop truncating results the model still needs (problem + proposal)

> **Status:** proposal, for review before implementation. Participants: dev04 +
> Claude. Targets `main` (a general agent-loop bug, independent of the applet
> epic). Promote the durable decision to an ADR once the shape is agreed.

## TL;DR

The browser agent applies one eager, lossy, 8000-char truncation to **every**
tool result **at the moment it's produced**, and that truncated string is the
only copy that ever reaches the model — on the very next step **and** forever
after. There is no distinction between *"a result the model must act on right
now"* and *"a result 20 steps old being carried as history."* Compressing the
latter is good hygiene; truncating the former is a correctness bug. Today the
code conflates them.

The immediate visible casualty: the `learn_generate_applet` skill (18,477 chars)
is cut to ~43% on the same turn the model reads it — the model never receives the
component signatures, any of the 7 worked examples, or the color rules, then
authors a broken applet. But the skill is just one symptom of a general
tool-result-lifecycle flaw.

## 1. Symptoms observed

- **Applets author badly and repeatedly** — wrong component prop shapes
  (`yAxis={{min,max}}`), raw hex colors (`#2563eb`) despite an explicit
  "never use hex" rule, no pattern-matching to the worked examples.
- **The model calls `learn_generate_applet` twice** in a row, every time.
- Both trace back to the same place.

## 2. Root cause

### 2.1 One eager, lossy truncation for all results

`webui/src/features/agent/engine/agent-loop.ts`:

```
27  export const MAX_TOOL_RESULT_CHARS = 8000

32  const serializeToolResult = (output: unknown): string => {
33    const s = JSON.stringify(output) ?? "null"
34    if (s.length <= MAX_TOOL_RESULT_CHARS) return s
35    return `${s.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated … — call the tool again with a narrower query for more]`
36  }

230       yield { type: "tool_result", toolName: call.name, result: output }   // UI gets the FULL output
231       messages.push({ role: "tool", toolCallId: call.id, content: serializeToolResult(output) })  // MODEL gets TRUNCATED
```

The loop then re-sends `messages` on the next iteration
(`llm.complete(messages, defs)`), so the model, on the **step where it must act
on the fresh result**, already sees the truncated string. The full `output` is
yielded to the **UI** (line 230) and then **discarded** — it is never retained
in the message record, so the system couldn't serve it in full later even if it
wanted to. The compression is eager, lossy, and irreversible.

### 2.2 The conflation

There is exactly **one** representation of a tool result in `messages`: the
8000-char-truncated string. It is used identically for:

1. **the current step** — the model is still reasoning about this result, and
2. **all history** — the result recedes into the transcript over later turns.

Compression is appropriate for (2) — bounding context growth is why a cap exists.
It is wrong for (1) — the model needs the *whole* fresh output to act. The code
draws no line between them: **no recency awareness, no retention of the full
value, no per-tool policy.**

Because browser-agent transcripts are stored as opaque JSON (ADR-AGENT-001), the
truncated form is also what gets **persisted** — the loss is permanent across
reloads, not just within a run.

### 2.3 The skill is the worst-hit case

`skills.ts` returns the full authored skill as the tool result
(`run: async () => SKILLS[name]`). `applet.md` is **18,477 chars**; JSON-stringified
it is ~18,962. The 8000-char cut lands **at the start of `## Component
signatures`**:

| Skill section | Reaches the model? |
|---|---|
| Intro / contract / expression grammar / action verbs | ✅ |
| Component signatures (Chart/Graph/Map/Table) | ⚠️ cut ~300 chars in |
| All 7 worked examples | ❌ truncated |
| Colors ("never use raw hex", palette) | ❌ truncated |
| Verification checklist | ❌ truncated |

So the model authors applets on ~43% of the skill. This retroactively explains
the symptoms: the color rules it "ignored" were never delivered; it had no
examples to imitate; the signatures were cut mid-section.

**This is not applet-specific — it is a live bug on `main` today.** Measuring the
existing skills against the 8000-char cap (JSON-stringified, as the code measures):

| Skill on `main` | Stringified chars | Delivered to the model |
|---|---|---|
| `diagram.md` | 5,795 | full |
| `html-widget.md` | 8,836 | **truncated** |
| `mini-app.md` | 21,046 | **truncated to ~38%** |

The legacy mini-app authoring skill has been reaching the model at roughly a third
of its length. Whatever happens to the applet epic, `main` benefits from the fix —
which is why both PRs below target `main`, not the epic branch.

### 2.4 The truncation marker causes the double-call

The marker appended on truncation — *"call the tool again with a narrower query
for more"* — is written for **search-style** tools. For a skill (no query
param, deterministic output), the model dutifully re-calls
`learn_generate_applet`, and `serializeToolResult` returns the **identical**
truncated 8000 chars. The retry is futile and wastes a turn. The marker is
misleading for every non-search tool.

## 3. Why this is dangerous beyond the skill

Any tool whose *fresh* output exceeds 8000 chars is handed to the model
pre-truncated on the turn it needs the whole thing:

- `read_note` of a long note,
- a document-chunk fetch,
- a `web_search` / `web_fetch` result the model is about to synthesize,
- any future tool returning structured data.

The "narrower query" nudge then pushes a re-call that, for deterministic tools,
changes nothing. It is a general tool-result-lifecycle flaw that happens to be
most visible on the skill.

## 4. Reference implementation — how Claude Code does it

We studied the deobfuscated Claude Code source (the local `leak-claude-code`
tree). Its tool-result lifecycle is the mature version of exactly the split we're
missing. The load-bearing idea: **an immutable full-fidelity log, and a derived
context-window view recomputed every turn.** Compression is never baked into
storage.

### 4.1 Two representations, retained source of truth

Each tool result exists as a retained typed `Output` object; the **model-facing**
wire block (`mapToolResultToToolResultBlockParam`) and the **UI/transcript** view
(`renderToolResultMessage`) are both *derived* from it (`Tool.ts:557`, `:566`).
The raw result is **never discarded at serialization**. Per-tool rendering means
Bash trims stdout, Read switches on type — each tool owns how its result is shown.

### 4.2 Log vs view — compression is lazy, at assembly

`QueryEngine` keeps `mutableMessages` and records every message verbatim, full
size, to the transcript (`QueryEngine.ts:708-716`) — the authoritative history
for resume. Nothing is truncated on the way in. Each loop iteration then
**recomputes** what the model sees from scratch (`query.ts:365-454`): drop
pre-compaction-boundary → `applyToolResultBudget` → `snipCompactIfNeeded` →
`microcompact` → `contextCollapse` → `autocompact`, each returning a *new*
`messagesForQuery`. A second pure pass (`normalizeMessagesForAPI`,
`utils/messages.ts:1989`) shapes the request just before the HTTP call, with no
write-back. Summaries "live in the collapse store, not the REPL array."

### 4.3 The current-vs-past split — three mechanisms

1. **Per-result overflow (eager):** if one result exceeds the tool's
   `maxResultSizeChars`, the **full** text is spilled to disk
   (`<session>/tool-results/<id>.txt`) and the block becomes a `<persisted-output>`
   **preview + filepath the model can re-`Read`** — a pointer, not a cut
   (`toolResultStorage.ts:205`). Read = `Infinity` (self-bounding), Bash = `30_000`.
2. **Aggregate budget (lazy, cache-safe):** `applyToolResultBudget` shrinks only
   the largest **fresh** results per message and — crucially — tracks `seenIds`:
   **once the model has seen a result uncompressed, its form is frozen forever**,
   never retroactively rewritten, so the prompt-cache prefix stays byte-identical.
   Removed content is stored out-of-band (`recordContentReplacement`), not lost.
3. **Aging elision (microcompaction):** distinct from full `/compact`. Keeps the
   **last K** compactable results (`keepRecent`, default **5**, floor 1) and
   replaces older ones' content with the fixed sentinel
   **`[Old tool result content cleared]`**, keeping the `tool_use ↔ tool_result`
   pairing (`microCompact.ts:446-483`). Only an allowlist of bulky tools is ever
   eligible (`COMPACTABLE_TOOLS`: read/shell/grep/glob/web-search/web-fetch/edit/
   write). The time-based path fires on a **60-min gap** — i.e. only once the
   prompt cache is already cold, so the retroactive rewrite is free. An
   API-native variant (`clear_tool_uses_20250919`) triggers at ~180k input tokens,
   freeing toward a ~40k recent window.

Token budget is computed from the **last API response's reported usage** plus an
estimate of the delta since — not a cumulative re-count (`utils/tokens.ts:226`).

### 4.4 Two cheap correctness details worth copying

- **Empty result → a sentinel**, `"(<tool> completed with no output)"`
  (`toolResultStorage.ts:287`) — a bare-empty tail makes some models end the turn.
- **A cleared result says so** (`[Old tool result content cleared]`) instead of a
  head-slice that *looks* complete but isn't.

## 5. Proposal — port the split to our (smaller) loop

We don't need Claude Code's full three-stage machinery. The load-bearing lessons
are the log/view separation and the recency + freeze policy. Mapped to our loop:

| Claude Code | Adopt for dim0? | How |
|---|---|---|
| Full-fidelity log + derived view | **Adopt** | Store the full `output` in the message record; compute the model-facing string in an assembly pass, not at `push` |
| Compress lazily at assembly, gated on budget | **Adopt** | Move sizing out of `serializeToolResult`-at-insertion into a `buildModelMessages(messages)` step before `llm.complete` |
| Keep last-K results full (recency) | **Adopt** | K≈5 by count (our runs are short); the just-produced result is *always* in-window, fixing the current-run truncation |
| Freeze already-seen results (cache stability) | **Adopt** | Our session runs a 1h prompt-cache TTL — once a result was sent uncompressed, don't rewrite it; only compress results that are both old *and* not-yet-seen, or accept a rewrite only across a long gap |
| Replace-whole with a sentinel, keep pairing | **Adopt** | `[old <tool> result cleared]`, not `slice(0, 8000)` |
| Per-tool eligibility allowlist | **Adopt** | Only compact bulky read-style tools (search/read_note/doc); **skills never**, tiny note results never |
| Empty-result sentinel | **Adopt** | `"(<tool> completed with no output)"` |
| Spill-to-disk + re-readable pointer | **Adapt, later** | We have a `StorageEngine` port (IndexedDB/rusqlite) and could persist + hand back a `read_tool_result(id)` handle — but that's a bigger feature; skip for v1 |
| Token budget from API usage numbers | **Adapt, later** | Our byok/managed clients don't surface usage uniformly; start with a char/rough-token count, refine later |
| Full conversation `/compact` summary | **Skip** | Out of scope here; separate concern from tool-result eliding |

### 5.1 Immediate (PR 1) — surgical unblock

- **Skills are never truncated.** They're bounded, authored, required in full, and
  aren't in any compactable allowlist by CC's own design. Exempt `learn_generate_*`
  from `MAX_TOOL_RESULT_CHARS`.
- **Drop the "narrower query" marker on non-search tools** — it's misleading and
  drives the futile double-call. If we keep any inline marker before PR 2, make it
  the honest sentinel form.

Small, safe, no lifecycle change. Unblocks applet authoring and lets us
**re-measure the real applet error rate** once the model receives the full skill —
much of the "spiral" may simply disappear.

### 5.2 The real fix (PR 2) — log/view split

1. **Retain the full `output`** in the message record; stop truncating at `push`.
2. **Add an assembly pass** (`buildModelMessages`) that derives the sent view:
   keep the **last K** tool results whole; for older results from **compactable
   tools**, replace the whole content with `[old <tool> result cleared]`; **skills
   and small results never touched**.
3. **Freeze already-seen results** so an active (cache-warm) session isn't
   retroactively rewritten — only compress results that have aged past the window
   *and* weren't already sent uncompressed, or gate the rewrite on a long gap the
   way CC gates on the 60-min cache TTL.
4. Carry an **ADR** for the durable decision (full retention; derive-at-assembly;
   recency + freeze; per-tool allowlist).

### What we are explicitly NOT doing

- Removing the cap — bulky data tools still need bounding as they age.
- A full-conversation summariser — separate from tool-result eliding.
- Disk/IndexedDB spill + re-read handle in v1 — valuable, but its own feature.

## 6. Open questions (several now answered by the research)

- **K** — CC uses **5**; our runs are shorter, so 3–5 is reasonable. The invariant
  that matters: the just-produced result is always in-window. *(was open; CC = 5)*
- **Head-truncate vs replace-whole** — **resolved: replace-whole with a sentinel.**
  Head-slicing a JSON blob is strictly worse (looks complete, breaks parsing).
- **Retain originals?** — CC's budget path retains out-of-band; its time-based MC
  path does *not* (accepts loss when the cache is already cold). For v1 we can keep
  full outputs in-memory for the run and simply not persist the compressed form.
- **Cache stability** — **newly important:** our 1h prompt-cache TTL means naive
  keep-last-K would retroactively rewrite aging results and bust the cache mid-run.
  Adopt CC's freeze (`seenIds`) or only compact across a gap.
- **Should the skill be a tool result at all,** or a system-role injection exempt
  by construction? Still worth deciding — a cleaner home than an 18KB tool result,
  and it sidesteps the whole question for skills.

## 7. Acceptance (for the eventual code)

- A skill result reaches the model **in full** (byte-for-byte) on the turn it is
  loaded — test asserts the assembled prompt contains the skill's *last* section.
- A large **fresh** data-tool result reaches the model in full on the immediately
  following step.
- An **old** compactable result is replaced whole with a sentinel once past the
  window, keeping context bounded and the `tool_use ↔ result` pairing intact.
- A result already sent uncompressed is **not** retroactively rewritten within a
  cache-warm run.
- No "narrower query" marker on a tool that has no query; empty results render as
  `"(<tool> completed with no output)"`.
