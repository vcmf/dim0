// A tiny concurrency gate for applet snapshot captures.
//
// The deferred-mount pool caps how many applets run LIVE, but the number of live AND
// in-view applets (which is what triggers a capture) is unbounded — panning to rest over
// a dense region can leave dozens visible at once. Each snapDOM capture is heavy (clone
// the subtree into an SVG foreignObject, read every embedded canvas), so firing them all
// on the same settle would land as a main-thread jank burst exactly when the board should
// feel responsive. This gate lets only a few run at a time and queues the rest, spreading
// the work across idle periods. Module-level: one shared budget across all applets.

/** Max snapDOM captures allowed to run concurrently. WebKit is single-threaded, so a
 *  small number spreads the cost without starving the queue. */
const MAX_CONCURRENT_CAPTURES = 2


let running = 0
const waiters: Array<() => void> = []


/** Acquire a capture slot, waiting if the gate is full. */
function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT_CAPTURES) {
    running += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => waiters.push(resolve))
}


/** Release a slot, handing it to the next waiter if any (keeping `running` constant), or
 *  freeing it. */
function release(): void {
  const next = waiters.shift()
  if (next) next() // hand our slot over — `running` stays the same
  else running -= 1
}


/**
 * Run `task` under the shared capture gate: it starts immediately if fewer than
 * {@link MAX_CONCURRENT_CAPTURES} are in flight, else waits its turn. Always releases the
 * slot, even if `task` throws/rejects. The result (or rejection) is propagated to the
 * caller unchanged.
 */
export async function withCaptureSlot<T>(task: () => Promise<T>): Promise<T> {
  await acquire()
  try {
    return await task()
  } finally {
    release()
  }
}
