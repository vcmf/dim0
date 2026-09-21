/** One provider route for a catalog model: the provider + its model string. */
export type ModelRoute = { via: string; model: string }


/**
 * A model from the public catalog (`GET /ai/models`). `id` is the canonical id a
 * MANAGED call sends; each route's `model` is the string a BYOK caller sends to
 * that provider (e.g. openai→"gpt-5.4", openrouter→"openai/gpt-5.4").
 */
export type PublicModel = {
  id: string
  label: string
  family: string
  tier?: string | null
  /** Whether the model accepts image input (sent by the backend catalog). */
  vision?: boolean
  routes: ModelRoute[]
}


/**
 * Whether the model that will actually serve this turn accepts image input.
 *
 * For an explicit catalog id (managed or BYOK) it's that model's `vision` flag.
 * For `"auto"` the SERVER resolves the concrete model, so the client can't know
 * which one — it's safe only while EVERY catalog model is vision-capable, which
 * holds today (the picker catalog is all-vision). If a text-only model is ever
 * added, `"auto"` correctly turns non-vision here.
 */
export const modelSupportsVision = (models: PublicModel[], id: string): boolean => {
  if (id === "auto") return models.length > 0 && models.every((m) => m.vision === true)
  return models.find((m) => m.id === id)?.vision === true
}


/**
 * Translate a chosen canonical id to the model string for a BYOK provider —
 * the route whose `via` matches. Undefined when the model has no route for that
 * provider (so it can't be reached with that key).
 */
export const byokModelForId = (
  models: PublicModel[],
  id: string,
  provider: string,
): string | undefined => models.find((m) => m.id === id)?.routes.find((r) => r.via === provider)?.model
