/**
 * canvas `node.type` values where a double-click must NOT trigger the
 * lib's inline text editor (`beginEdit`). Two flavors:
 *
 *   - Dim0's custom node defs (see `node-types/`) — these own their
 *     editing surface elsewhere (an expand dialog, a side panel, or
 *     folder navigation), so the inline text editor would compete.
 *   - canvas-harness built-ins that have no own text-content concept
 *     (icon, image, frame) — the inline editor opens an invisible
 *     text caret on top of the glyph / slide chrome and any typed
 *     text becomes junk `node.content` data. Suppress the editor so
 *     dbl-click is a no-op (just selects). Frame is the slide
 *     container used by presentation mode — its visible chrome is
 *     the slide border, not a text body.
 *
 * Keep the Dim0-custom subset in sync with the defs registered in
 * `node-types/index.ts → boardNodeTypes`; `custom-node-types.test.ts`
 * guards the parity. The matching style-memory exclusion lives in
 * `use-style-memory.ts → EXCLUDED_TYPES`.
 */
export const CUSTOM_NODE_TYPES: ReadonlySet<string> = new Set([
  "folder",
  "document",
  "sheet",
  "code-sandbox",
  "widget",
  "mini-app",
  "ink",
  // No text-content concept; double-click should be a no-op rather
  // than open an invisible inline text editor.
  "icon",
  "image",
  "frame",
])
