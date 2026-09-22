// The three `<Widget>` scope attributes whose keys are spread into evaluation
// scope as bare identifiers. One canonical list, shared by the transformer
// (attribute + overlap validation) and the interpreter (the bare-name hint on an
// undefined reference), so the set can't drift between them.

export const SCOPE_NAMES = ["state", "data", "derived"] as const


export type ScopeName = (typeof SCOPE_NAMES)[number]


/** True if `name` is one of the reserved `<Widget>` scope attribute names. */
export function isScopeName(name: string): boolean {
  return (SCOPE_NAMES as readonly string[]).includes(name)
}
