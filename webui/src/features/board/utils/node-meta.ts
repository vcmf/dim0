/**
 * Node freshness metadata helpers — one place for creating/advancing a node's
 * `SyncMeta` and for deriving its display "Created/Edited" stamp.
 *
 * There are two historical representations of a node's timestamps:
 *  - canonical `data.meta` (`SyncMeta`, ms numbers) — what the agent/mutator write;
 *  - legacy top-level `data.createdAt`/`updatedAt` (ISO strings) — older local
 *    boards + the REST convert layer.
 * `nodeStamp` reads whichever is present (meta first), so the display works for
 * both, and agent-created notes (which only carry `meta`) finally show a stamp.
 */
import type { SyncMeta } from "@/features/board/model"


/** Fresh meta for a newly created entity — createdAt = updatedAt = now. */
export const freshMeta = (now = Date.now()): SyncMeta => ({ v: 1, createdAt: now, updatedAt: now })


/**
 * Meta for an EDIT: preserve the original `createdAt`, advance `updatedAt`, bump
 * the version. Unlike a fresh stamp, this lets the display distinguish an edited
 * note ("Edited …") from a newly created one ("Created …").
 */
export const bumpMeta = (prev: SyncMeta | undefined, now = Date.now()): SyncMeta => ({
  v: (prev?.v ?? 0) + 1,
  createdAt: prev?.createdAt ?? now,
  updatedAt: now,
})


type StampData = {
  createdAt?: string // legacy display strings (NoteNodeData / converted Note)
  updatedAt?: string
  meta?: { createdAt?: number; updatedAt?: number } // canonical (DimNodeData)
}


const toMs = (s?: string): number | undefined => {
  if (!s) return undefined
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : undefined
}


/**
 * The display freshness stamp for a node, from the canonical `meta` (numbers) or
 * the legacy top-level strings. `iso` is the last-touched time (updated, else
 * created) as an ISO string, or null when unknown; `edited` is true only when the
 * note has been updated after creation.
 */
export const nodeStamp = (data: StampData | undefined): { iso: string | null; edited: boolean } => {
  const created = data?.meta?.createdAt ?? toMs(data?.createdAt)
  const updated = data?.meta?.updatedAt ?? toMs(data?.updatedAt)
  const ms = updated ?? created
  const edited = created != null && updated != null && updated > created
  return { iso: ms != null ? new Date(ms).toISOString() : null, edited }
}
