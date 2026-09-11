// Static action-path validation (applet-design.md §9.1). Shared by run-action
// (runtime) and the transformer (author-time) so the path rules — non-empty
// segments, no prototype-escape keys — have ONE source of truth and can't drift.

import { BLOCKED_KEYS } from "./safe-get"


export type PathCheck = { segments: string[] } | { error: string }


// Split a dotted state path into segments, rejecting empty segments and escape
// keys. Returns the segments, or an error message for the caller to raise.
export function splitAndCheckPath(path: string): PathCheck {
  const segments = path.split(".")
  for (const seg of segments) {
    if (seg === "") return { error: `invalid path "${path}" — empty segment` }
    if (BLOCKED_KEYS.has(seg)) return { error: `forbidden path segment '${seg}' in "${path}"` }
  }
  return { segments }
}
