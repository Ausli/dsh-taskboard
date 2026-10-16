import type { ExternalConfig, ExternalItem, ExternalProject } from '../shared/external.ts'
import type { ExternalTaskProvider, ExternalReadContext } from './external-provider.ts'
import { externalGet, trackerText, ExternalRequestThrottle } from './external-http.ts'
export { trackerText } from './external-http.ts'

/** ZenTao REST API v1, product Bug lists. Product IDs form the mapping scope. */
export class ZentaoProvider implements ExternalTaskProvider {
  private token?: string
  private readonly throttle: ExternalRequestThrottle
  constructor(private readonly config: ExternalConfig, private readonly request: typeof fetch = fetch) {
    if (config.authMode !== 'password' || !config.credentials.username || !config.credentials.password) throw new Error('ZenTao requires a username and password')
    this.throttle = new ExternalRequestThrottle(Number(config.settings.requestIntervalMs ?? 200))
  }
  private async authenticate(signal: AbortSignal): Promise<string> {
    if (this.token) return this.token
    await this.throttle.wait(signal)
    const response = await this.request(`${this.config.baseUrl}/api.php/v1/tokens`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ account: this.config.credentials.username, password: this.config.credentials.password }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error',
    })
    if (!response.ok) throw new Error('ZenTao login failed')
    let result: unknown
    try { result = await response.json() } catch { throw new Error('ZenTao login returned invalid JSON') }
    if (!result || typeof result !== 'object' || !('token' in result) || typeof result.token !== 'string' || !result.token.trim()) throw new Error('ZenTao login failed')
    this.token = result.token
    return this.token
  }
  private async get(path: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const token = await this.authenticate(signal)
    let raw: unknown
    try { raw = await externalGet(this.request, `${this.config.baseUrl}/api.php/v1/${path}`, { Token: token }, signal, () => this.throttle.wait(signal)) }
    catch (error) {
      if (this.config.authMode !== 'password' || !(error instanceof Error) || !/HTTP (401|403)\)/.test(error.message)) throw error
      this.token = undefined
      raw = await externalGet(this.request, `${this.config.baseUrl}/api.php/v1/${path}`, { Token: await this.authenticate(signal) }, signal, () => this.throttle.wait(signal))
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || 'error' in raw) throw new Error('invalid ZenTao response')
    return raw as Record<string, unknown>
  }
  async listProjects(signal: AbortSignal): Promise<ExternalProject[]> {
    const projects: ExternalProject[] = []
    const seen = new Set<string>()
    for (let page = 1; page <= 10_000; page++) {
      const result = await this.get(`products?limit=100&page=${page}`, signal)
      if (!Array.isArray(result.products)) throw new Error('invalid ZenTao product list')
      let added = 0
      for (const raw of result.products) {
        if (!raw || typeof raw !== 'object') throw new Error('invalid ZenTao product')
        const p = raw as Record<string, unknown>
        if (typeof p.id === 'number' && !Number.isSafeInteger(p.id)) throw new Error('unsafe product ID')
        const id = String(p.id ?? '')
        if (!/^\d+$/.test(id) || typeof p.name !== 'string') throw new Error('invalid ZenTao product fields')
        if (!seen.has(id)) { seen.add(id); added++; projects.push({ id, name: p.name }) }
      }
      if (!result.products.length || (typeof result.total === 'number' && seen.size >= result.total)) return projects
      if (!added) throw new Error('ZenTao product pagination did not advance')
    }
    throw new Error('ZenTao product pagination limit exceeded')
  }
  async getItem(projectId: string, type: string, id: string, signal: AbortSignal): Promise<ExternalItem | undefined> {
    if (type !== 'bug' || !/^\d+$/.test(id)) throw new Error('unsupported ZenTao work item')
    const result = await this.get(`bugs/${encodeURIComponent(id)}`, signal)
    const b = result.bug && typeof result.bug === 'object' ? result.bug as Record<string, unknown> : result
    if (String(b.id) !== id || String(b.product) !== projectId || typeof b.title !== 'string' || typeof b.status !== 'string') throw new Error('invalid ZenTao Bug details')
    const assigned = typeof b.assignedTo === 'object' && b.assignedTo !== null ? String((b.assignedTo as Record<string, unknown>).account ?? '') : String(b.assignedTo ?? '')
    const priority = String(b.pri ?? '')
    return { projectId, type, id, title: b.title, description: trackerText(b.steps), status: b.status, assignedTo: assigned,
      priority, urgency: priority === '1' ? 'urgent' : priority === '4' ? 'relaxed' : 'normal', closed: ['closed', 'resolved'].includes(b.status),
      url: `${this.config.baseUrl}/index.php?m=bug&f=view&bugID=${encodeURIComponent(id)}` }
  }
  async test(signal: AbortSignal): Promise<void> {
    for (const mapping of this.config.mappings) {
      const result = await this.get(`products/${encodeURIComponent(mapping.projectId)}/bugs?limit=1&page=1`, signal)
      if (!Array.isArray(result.bugs)) throw new Error('unsupported ZenTao Bug API')
    }
  }
  async getItems(projectId: string, signal: AbortSignal, context?: ExternalReadContext): Promise<ExternalItem[]> {
    const items: ExternalItem[] = []
    const seen = new Set<string>()
    for (let page = 1; page <= 10_000; page++) {
      // Full scan also observes previously imported bugs that were closed/reassigned.
      const result = await this.get(`products/${encodeURIComponent(projectId)}/bugs?status=all&limit=100&page=${page}`, signal)
      if (!Array.isArray(result.bugs)) throw new Error('invalid ZenTao Bug list')
      let added = 0
      for (const raw of result.bugs as unknown[]) {
        if (!raw || typeof raw !== 'object') throw new Error('invalid ZenTao Bug')
        const b = raw as Record<string, unknown>
        if (typeof b.id === 'number' && !Number.isSafeInteger(b.id)) throw new Error('ZenTao numeric Bug ID exceeds safe integer range')
        const id = String(b.id ?? '')
        if (!/^\d+$/.test(id) || typeof b.title !== 'string' || !b.title.trim() || typeof b.status !== 'string') throw new Error('invalid ZenTao Bug fields')
        if (seen.has(id)) continue
        seen.add(id); added++
        const opened = typeof b.openedDate === 'string' ? b.openedDate.slice(0, 10) : ''
        if (this.config.since && opened && opened < this.config.since) continue
        const assigned = typeof b.assignedTo === 'object' && b.assignedTo !== null
          ? String((b.assignedTo as Record<string, unknown>).account ?? '') : String(b.assignedTo ?? '')
        const previous = context?.existing.get(JSON.stringify(['bug', id]))
        if (context && !previous && (assigned !== this.config.account || ['closed', 'resolved'].includes(b.status))) continue
        if (b.steps === undefined && previous?.metadataOnly) b.steps = previous.item.description
        if (b.steps === undefined) {
          const detail = await this.get(`bugs/${encodeURIComponent(id)}`, signal)
          const payload = detail.bug && typeof detail.bug === 'object' ? detail.bug as Record<string, unknown> : detail
          if (typeof payload.steps !== 'string') throw new Error('ZenTao Bug description is missing')
          b.steps = payload.steps
        }
        const priority = String(b.pri ?? '')
        items.push({ projectId, type: 'bug', id, title: b.title.trim(), description: trackerText(b.steps),
          urgency: priority === '1' ? 'urgent' : priority === '4' ? 'relaxed' : 'normal', priority,
          assignedTo: assigned, status: b.status, closed: ['closed', 'resolved'].includes(b.status),
          url: `${this.config.baseUrl}/index.php?m=bug&f=view&bugID=${encodeURIComponent(id)}` })
      }
      const total = typeof result.total === 'number' ? result.total : Number(result.total)
      if (result.bugs.length === 0 || (Number.isFinite(total) && seen.size >= total)) return items
      if (added === 0) throw new Error('ZenTao pagination did not advance')
    }
    throw new Error('ZenTao pagination limit exceeded')
  }
}
