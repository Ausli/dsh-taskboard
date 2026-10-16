/** Shared bounded read-only HTTP transport. Never includes server bodies/credentials in errors. */
export async function externalGet(request: typeof fetch, url: string, headers: Record<string, string>, signal: AbortSignal, beforeRequest?: () => Promise<void>): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    await beforeRequest?.()
    const response = await request(url, { headers: { ...headers, Accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error' })
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      const retry = response.headers.get('retry-after')
      const seconds = retry && /^\d+$/.test(retry) ? Math.min(Number(retry), 30) : 2 ** attempt
      await response.body?.cancel()
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(new Error('request aborted')) }
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, seconds * 1000)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
      continue
    }
    if (!response.ok) throw new Error(`External request failed (HTTP ${response.status})`)
    try { return await response.json() }
    catch { throw new Error('External service returned invalid JSON') }
  }
}

/** Reserve slots before waiting so overlapping requests also observe the minimum interval. */
export class ExternalRequestThrottle {
  private nextAt = 0
  constructor(private readonly intervalMs: number) {}
  async wait(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const now = Date.now(); const at = Math.max(now, this.nextAt)
    this.nextAt = at + this.intervalMs
    if (at <= now) return
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new Error('request aborted')) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, at - now)
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
    })
  }
}

export function trackerText(raw: unknown): string {
  return String(raw ?? '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\s*(br\s*\/?|\/p|\/div|\/li)\s*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim()
}
