/** Same-origin external-provider routes; credentials remain host-owned after saving. */
export function externalTypeLabel(type: string, translate: (key: string) => string): string {
  const key = `ext.type.${type}`
  const label = translate(key)
  return label === key ? type : label
}
export async function externalRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/dsh-taskboard/external${path}`, body === undefined ? { signal: AbortSignal.timeout(15_000) } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(330_000),
  })
  const result = await response.json() as { ok: boolean; value: T; error?: { message: string } }
  if (!response.ok || !result.ok) throw new Error(result.error?.message ?? 'External sync request failed')
  return result.value
}
