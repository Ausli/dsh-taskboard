import type { ExternalConfig, ExternalItem, ExternalProject } from '../shared/external.ts'
import type { ExternalTaskProvider, ExternalReadContext } from './external-provider.ts'
import { externalGet, trackerText, ExternalRequestThrottle } from './external-http.ts'
export { trackerText } from './external-http.ts'

/** ZenTao REST API v1: project or execution mapping, independent of item types. */
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
  private scope(projectId: string) {
    const match = /^(project|execution):(\d+)$/.exec(projectId)
    if (!match || match[1] !== this.config.mappingMode) throw new Error('invalid ZenTao mapping scope')
    return { id: match[2]!, execution: match[1] === 'execution' }
  }
  private async scopes(path: string, key: string, signal: AbortSignal): Promise<ExternalProject[]> {
    const values: ExternalProject[] = []; const seen = new Set<string>()
    for (let page = 1; page <= 10_000; page++) {
      const result = await this.get(`${path}?status=all&limit=100&page=${page}`, signal)
      const rows = result[key]
      if (!Array.isArray(rows)) throw new Error('invalid ZenTao scope list')
      let added = 0
      for (const raw of rows) {
        if (!raw || typeof raw !== 'object') throw new Error('invalid ZenTao scope')
        const p = raw as Record<string, unknown>
        const id = this.id(p.id)
        if (typeof p.name !== 'string') throw new Error('invalid ZenTao scope fields')
        if (!seen.has(id)) { seen.add(id); added++; values.push({ id, name: p.name }) }
      }
      const total = Number(result.total)
      if (!rows.length || (Number.isFinite(total) && seen.size >= total)) return values
      if (!added) throw new Error('ZenTao scope pagination did not advance')
    }
    throw new Error('ZenTao scope pagination limit exceeded')
  }
  async listProjects(signal: AbortSignal): Promise<ExternalProject[]> {
    if (!this.config.mappingMode) throw new Error('select a project or execution mapping mode')
    const projects = await this.scopes('projects', 'projects', signal)
    if (this.config.mappingMode === 'project') return projects.map(p => ({ ...p, id: `project:${p.id}` }))
    const scopes: ExternalProject[] = []
    for (const project of projects) {
      for (const execution of await this.scopes(`projects/${project.id}/executions`, 'executions', signal)) {
        if (!scopes.some(s => s.id === `execution:${execution.id}`)) scopes.push({ id: `execution:${execution.id}`, name: `${project.name} / ${execution.name}` })
      }
    }
    return scopes
  }
  private id(raw: unknown): string {
    if (typeof raw === 'number' && !Number.isSafeInteger(raw)) throw new Error('unsafe ZenTao numeric ID')
    if ((typeof raw !== 'string' && typeof raw !== 'number') || !/^\d+$/.test(String(raw))) throw new Error('invalid ZenTao ID')
    return String(raw)
  }
  private closed(type: string, status: string): boolean {
    return (type === 'bug' ? ['closed', 'resolved'] : type === 'task' ? ['done', 'closed', 'cancel'] : ['closed']).includes(status)
  }
  private account(raw: unknown): string {
    return typeof raw === 'object' && raw !== null ? String((raw as Record<string, unknown>).account ?? '') : String(raw ?? '')
  }
  private normalize(projectId: string, type: string, b: Record<string, unknown>, readScope = projectId): ExternalItem {
    const id = this.id(b.id)
    const [kind, scopeId] = readScope.split(':')
    const scope = b[kind === 'execution' ? 'execution' : 'project']
    if (scope !== undefined && this.id(scope) !== scopeId) throw new Error('unexpected ZenTao item scope')
    if (type === 'task' && projectId.startsWith('project:') && b.project !== undefined && this.id(b.project) !== projectId.slice(8)) throw new Error('unexpected ZenTao task project')
    const title = type === 'task' ? b.name : b.title
    if (typeof title !== 'string' || !title.trim() || typeof b.status !== 'string') throw new Error('invalid ZenTao item fields')
    const priority = String(b.pri ?? '')
    const description = type === 'bug' ? trackerText(b.steps) : type === 'task' ? trackerText(b.desc)
      : [trackerText(b.spec), trackerText(b.verify)].filter(Boolean).join('\n\n')
    return { projectId, type, id, title: title.trim(), description, priority, status: b.status,
      assignedTo: this.account(b.assignedTo), closed: this.closed(type, b.status),
      urgency: priority === '1' ? 'urgent' : priority === '4' ? 'relaxed' : 'normal',
      url: `${this.config.baseUrl}/index.php?m=${type}&f=view&${type}ID=${encodeURIComponent(id)}` }
  }
  private async detail(type: string, id: string, listed: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const result = await this.get(`${type === 'story' ? 'stories' : type + 's'}/${id}`, signal)
    const b = result[type] && typeof result[type] === 'object' ? result[type] as Record<string, unknown> : result
    if (this.id(b.id) !== id) throw new Error('invalid ZenTao item details')
    for (const field of ['product', 'project', 'execution']) {
      if (listed[field] !== undefined && b[field] !== undefined && this.id(listed[field]) !== this.id(b[field])) throw new Error('invalid ZenTao item details scope')
    }
    return b
  }
  async getItem(projectId: string, type: string, id: string, signal: AbortSignal): Promise<ExternalItem | undefined> {
    if (!this.config.itemTypes.includes(type)) throw new Error('unsupported ZenTao work item')
    this.id(id)
    // Membership is established by a scoped list, not inferred from a Story detail's product ID.
    return (await this.scanItems(projectId, [type], signal)).find(item => item.id === id)
  }
  private async readScopes(projectId: string, type: string, signal: AbortSignal): Promise<string[]> {
    const scope = this.scope(projectId)
    if (!scope.execution && type === 'task') {
      return (await this.scopes(`projects/${scope.id}/executions`, 'executions', signal)).map(e => `execution:${e.id}`)
    }
    return [projectId]
  }
  private readPath(readScope: string, type: string): string {
    const [kind, id] = readScope.split(':')
    return `${kind === 'execution' ? 'executions' : 'projects'}/${id}/${type === 'story' ? 'stories' : type + 's'}`
  }
  async test(signal: AbortSignal): Promise<void> {
    if (!this.config.mappingMode) throw new Error('select a project or execution mapping mode')
    if (!this.config.mappings.length) {
      const result = await this.get('projects?limit=1&page=1', signal)
      if (!Array.isArray(result.projects)) throw new Error('unsupported ZenTao project API')
    }
    for (const mapping of this.config.mappings) for (const type of this.config.itemTypes) {
      for (const scope of await this.readScopes(mapping.projectId, type, signal)) {
        const result = await this.get(`${this.readPath(scope, type)}?status=${type === 'story' ? 'allstory' : 'all'}&limit=1&page=1`, signal)
        if (!Array.isArray(result[type === 'story' ? 'stories' : type + 's'])) throw new Error('unsupported ZenTao work item API')
      }
    }
  }
  async getItems(projectId: string, signal: AbortSignal, context?: ExternalReadContext): Promise<ExternalItem[]> {
    return this.scanItems(projectId, this.config.itemTypes, signal, context)
  }
  private async scanItems(projectId: string, types: readonly string[], signal: AbortSignal, context?: ExternalReadContext): Promise<ExternalItem[]> {
    const items: ExternalItem[] = []
    for (const type of types) {
      const seenItems = new Set<string>()
      for (const readScope of await this.readScopes(projectId, type, signal)) {
        const seen = new Set<string>(); let completed = false
        for (let page = 1; page <= 10_000; page++) {
          const result = await this.get(`${this.readPath(readScope, type)}?status=${type === 'story' ? 'allstory' : 'all'}&limit=100&page=${page}`, signal)
          const rows = result[type === 'story' ? 'stories' : type + 's']
          if (!Array.isArray(rows)) throw new Error('invalid ZenTao item list')
          let added = 0
          for (const raw of rows) {
            if (!raw || typeof raw !== 'object') throw new Error('invalid ZenTao item')
            let b = raw as Record<string, unknown>; const id = this.id(b.id)
            if (seen.has(id)) continue
            seen.add(id); added++
            if (seenItems.has(id)) continue
            seenItems.add(id)
            const listed = this.normalize(projectId, type, b, readScope)
            const previous = context?.existing.get(JSON.stringify([type, id]))
            const opened = typeof b.openedDate === 'string' ? b.openedDate.slice(0, 10) : ''
            if (!previous && this.config.since && opened && opened < this.config.since) continue
            if (context && !previous && (listed.assignedTo !== this.config.account || listed.closed)) continue
            const missing = type === 'bug' ? b.steps === undefined : type === 'task' ? b.desc === undefined : b.spec === undefined || b.verify === undefined
            if (missing && previous?.metadataOnly) { items.push({ ...listed, description: previous.item.description }); continue }
            if (missing) {
              b = { ...b, ...await this.detail(type, id, b, signal) }
              if (type === 'bug' ? typeof b.steps !== 'string' : type === 'task' ? typeof b.desc !== 'string' : typeof b.spec !== 'string' || typeof b.verify !== 'string') throw new Error('ZenTao item description is missing')
            }
            items.push(this.normalize(projectId, type, b, readScope))
          }
          const total = Number(result.total)
          if (!rows.length || (Number.isFinite(total) && seen.size >= total)) { completed = true; break }
          if (!added) throw new Error('ZenTao pagination did not advance')
        }
        if (!completed) throw new Error('ZenTao pagination limit exceeded')
      }
    }
    return items
  }
}
