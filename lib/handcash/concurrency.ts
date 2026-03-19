/** Runs `worker` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })

  await Promise.all(runners)
  return results
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Public block explorers rate-limit aggressively and answer with 429/5xx under
 * load. Retry with exponential backoff so a long scan doesn't die halfway.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 4, baseDelayMs = 400 }: { attempts?: number; baseDelayMs?: number } = {}
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt < attempts - 1) {
        await sleep(baseDelayMs * 2 ** attempt)
      }
    }
  }
  throw lastError
}

/**
 * Caps how many calls to one service are in flight at once, across every
 * caller. Unlike `mapLimit`, the cap holds when unrelated code paths — history
 * lookups, unspent lookups, script fetches during signing — hit the same
 * explorer at the same time.
 */
export function createLimiter(limit: number) {
  let active = 0
  const queue: Array<() => void> = []

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active < limit) {
      active += 1
    } else {
      // The finishing task hands its slot straight to us, so `active` is not
      // released in between and a newcomer cannot jump the queue.
      await new Promise<void>((resolve) => queue.push(resolve))
    }
    try {
      return await task()
    } finally {
      const next = queue.shift()
      if (next) next()
      else active -= 1
    }
  }
}

/**
 * `fetch` that gives up after `ms`. A public API that accepts a connection and
 * then never answers would otherwise stall a scan forever; timing out turns it
 * into an ordinary failure that `withRetry` and the callers already handle.
 */
export function fetchWithTimeout(url: string, init?: RequestInit, ms = 30_000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) })
}
