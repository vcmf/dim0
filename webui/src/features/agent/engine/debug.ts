/**
 * Agent observability. The local agent has no server logs, so this is how you
 * see what actually happened: every LLM request/response, tool call/result, and
 * error is logged to the console (when enabled) and kept in an in-memory ring
 * buffer for post-hoc inspection.
 *
 * Toggle in the browser console:
 *   __agentDebug(true)            // enable verbose logging
 *   __agentLog()                  // dump the recent trace
 *   __agentLog.clear()            // reset
 * Enabled by default in dev; via the `VITE_AGENT_DEBUG=true` build env var (e.g. to test a
 * production-like build); or per-session via localStorage. Off in tests.
 */
import type { LlmMessage, LlmToolDef, LlmTurn } from "./types"


let enabled = false
try {
  const env = import.meta.env
  const isTest = Boolean(env?.VITEST) || env?.MODE === "test"
  // Any non-empty, non-falsey value enables it — so `=true`, `=1`, `=yes` all work rather
  // than only the exact string "true".
  const v = env?.VITE_AGENT_DEBUG
  const envOn = typeof v === "string" && v !== "" && v !== "false" && v !== "0"
  // On by default in dev; off in tests; else opt in via the build env var or localStorage.
  enabled = !isTest && (Boolean(env?.DEV) || envOn || localStorage.getItem("dim0.debug.agent") === "1")
} catch {
  // storage unavailable — stays off
}


export const setAgentDebug = (on: boolean): void => {
  enabled = on
  try {
    if (on) localStorage.setItem("dim0.debug.agent", "1")
    else localStorage.removeItem("dim0.debug.agent")
  } catch {
    // ignore
  }
}


export const isAgentDebug = (): boolean => enabled


type LogEntry = { t: number; kind: string; data: unknown }
const buffer: LogEntry[] = []
const MAX_ENTRIES = 500


const record = (kind: string, data: unknown): void => {
  buffer.push({ t: Date.now(), kind, data })
  if (buffer.length > MAX_ENTRIES) buffer.shift()
}


/** The recorded trace (newest last). Cleared via `getAgentLog.clear()`. */
export const getAgentLog = (): LogEntry[] => buffer.slice()
export const clearAgentLog = (): void => {
  buffer.length = 0
}


/** Serialize an error richly — OpenAI APIError carries status/code/detail. */
const serializeError = (err: unknown): Record<string, unknown> => {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>
    return {
      name: e.name,
      message: e.message,
      status: e.status,
      code: e.code,
      // OpenAI SDK nests the provider payload here
      error: e.error,
    }
  }
  return { message: String(err) }
}


const short = (s: string, n = 2000): string => (s.length > n ? s.slice(0, n) + `… (+${s.length - n})` : s)


export const agentLog = {
  llmRequest(model: string, messages: LlmMessage[], tools: LlmToolDef[]): void {
    record("llm_request", { model, messages, toolNames: tools.map((t) => t.name) })
    if (!enabled) return
    console.groupCollapsed(`%c[agent] → LLM ${model} · ${messages.length} msgs · ${tools.length} tools`, "color:#8b5cf6")
    for (const m of messages) {
      const body = "content" in m && typeof m.content === "string" ? short(m.content) : m
      console.log(`%c${m.role}`, "font-weight:bold", body)
    }
    console.log("tools:", tools.map((t) => t.name).join(", ") || "(none)")
    console.groupEnd()
  },

  llmResponse(turn: LlmTurn): void {
    record("llm_response", turn)
    if (!enabled) return
    if (turn.kind === "tool_calls") {
      console.log("%c[agent] ← tool_calls", "color:#8b5cf6", turn.calls.map((c) => `${c.name}(${short(c.arguments, 300)})`))
    } else {
      console.log("%c[agent] ← text", "color:#8b5cf6", short(turn.text, 500))
    }
  },

  reasoning(text: string): void {
    if (!text) return
    // Chain-of-thought is the largest payload here; cap what we keep in the always-on ring
    // buffer so a session that never enables debug doesn't accumulate multi-KB CoT blobs.
    record("reasoning", short(text))
    if (enabled) console.log("%c[agent] 🧠 reasoning", "color:#a855f7", short(text, 2000))
  },

  tool(name: string, args: unknown, result: unknown): void {
    record("tool", { name, args, result })
    if (enabled) console.log(`%c[agent] ⚙ ${name}`, "color:#0ea5e9", { args, result })
  },

  error(where: string, err: unknown): void {
    record("error", { where, error: serializeError(err) })
    if (enabled) console.error(`[agent] ✗ ${where}`, err)
  },

  turnDone(chatUid: string | null, persistedCount: number): void {
    record("turn_done", { chatUid, persistedCount })
    if (enabled) console.log(`%c[agent] ✓ turn done · persisted ${persistedCount} msgs · chat ${chatUid ?? "(none)"}`, "color:#22c55e")
  },

  capture(ms: number, bytes: number): void {
    record("capture", { ms, bytes })
    if (enabled) console.log(`%c[agent] 📸 board capture · ${ms}ms · ${(bytes / 1024).toFixed(0)}KB`, "color:#14b8a6")
  },
}


// Expose console helpers (guarded for non-browser/test envs).
try {
  const w = globalThis as unknown as Record<string, unknown>
  const dump = Object.assign(() => getAgentLog(), { clear: clearAgentLog })
  w.__agentLog = dump
  w.__agentDebug = setAgentDebug
} catch {
  // ignore
}
