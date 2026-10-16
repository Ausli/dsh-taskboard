import type { ExternalConfig, ExternalItem, ExternalProject } from '../shared/external.ts'
import type { ExternalTaskProvider } from './external-provider.ts'
import { externalGet, trackerText } from './external-http.ts'

const TYPES: Record<string, { endpoint: string; wrapper: string; title: string; owner: string }> = {
  bug: { endpoint: 'bugs', wrapper: 'Bug', title: 'title', owner: 'current_owner' },
  story: { endpoint: 'stories', wrapper: 'Story', title: 'name', owner: 'owner' },
  task: { endpoint: 'tasks', wrapper: 'Task', title: 'name', owner: 'owner' },
}
function opaqueId(raw: unknown): string {
  if (typeof raw === 'number' && !Number.isSafeInteger(raw)) throw new Error('unsafe numeric TAPD ID')
  const id = String(raw ?? '')
  if (!/^\d+$/.test(id)) throw new Error('invalid TAPD ID')
  return id
}

/** TAPD Open API; API credentials and the assignee nickname are separate identities. */
export class TapdProvider implements ExternalTaskProvider {
  private nextRequestAt = 0
  constructor(private readonly config: ExternalConfig, private readonly request: typeof fetch = fetch,
    private readonly minIntervalMs = 1100) {}
  private async get(path: string, params: Record<string, string>, signal: AbortSignal): Promise<unknown[]> {
    const delay = Math.max(0, this.nextRequestAt - Date.now())
    if (delay) await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new Error('request aborted')) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, delay)
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
    })
    signal.throwIfAborted(); this.nextRequestAt = Date.now() + this.minIntervalMs
    const c = this.config.credentials
    const authorization = this.config.authMode === 'basic'
      ? `Basic ${Buffer.from(`${c.apiUser}:${c.apiPassword}`, 'utf8').toString('base64')}` : `Bearer ${c.accessToken}`
    const raw = await externalGet(this.request, `${this.config.baseUrl}/${path}?${new URLSearchParams(params)}`, { Authorization: authorization }, signal)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid TAPD response')
    const response = raw as Record<string, unknown>
    if (response.status !== 1 || !Array.isArray(response.data)) throw new Error('TAPD API rejected request or returned invalid data')
    return response.data
  }
  async test(signal: AbortSignal): Promise<void> {
    for (const mapping of this.config.mappings) for (const type of this.config.itemTypes) {
      await this.get(TYPES[type]!.endpoint, { workspace_id: mapping.projectId, limit: '1', fields: 'id' }, signal)
    }
  }
  async listProjects(signal: AbortSignal): Promise<ExternalProject[]> {
    if (!this.config.settings.companyId) throw new Error('company ID is required for TAPD project discovery')
    const data = await this.get('workspaces/user_participant_projects', { nick: this.config.account, company_id: this.config.settings.companyId }, signal)
    return data.map(row => {
      const workspace = row && typeof row === 'object' ? (row as Record<string, unknown>).Workspace : undefined
      if (!workspace || typeof workspace !== 'object') throw new Error('invalid TAPD workspace')
      const w = workspace as Record<string, unknown>
      if (typeof w.name !== 'string') throw new Error('invalid TAPD workspace name')
      return { id: opaqueId(w.id), name: w.name }
    })
  }
  private normalize(row: unknown, projectId: string, type: string): ExternalItem {
    const spec = TYPES[type]!
    const raw = row && typeof row === 'object' ? (row as Record<string, unknown>)[spec.wrapper] : undefined
    if (!raw || typeof raw !== 'object') throw new Error('invalid TAPD work item wrapper')
    const item = raw as Record<string, unknown>
    const id = opaqueId(item.id)
    if (item.workspace_id !== undefined && opaqueId(item.workspace_id) !== projectId) throw new Error('TAPD project mismatch')
    if (typeof item[spec.title] !== 'string' || !String(item[spec.title]).trim() || typeof item.status !== 'string') throw new Error('invalid TAPD work item fields')
    const assignedTo = String(item[spec.owner] ?? '')
    const assignees = assignedTo.split(';').map(s => s.trim()).filter(Boolean)
    const priority = String(item.priority_label || item.priority || '')
    const labels = (key: string, fallback: string) => (this.config.settings[key] ?? fallback).split(',').map(v => v.trim().toLowerCase()).filter(Boolean)
    const terminal = labels('terminalStatuses', 'closed,resolved,done,rejected')
    const high = labels('urgentPriorities', 'urgent,high,紧急,高')
    const low = labels('relaxedPriorities', 'low,nice to have,低')
    // Legacy task/story numeric priority increases with urgency (opposite to many trackers).
    const normalizedPriority = priority.toLowerCase()
    const urgency = high.includes(normalizedPriority) || (!item.priority_label && type !== 'bug' && priority === '4') ? 'urgent'
      : low.includes(normalizedPriority) || (!item.priority_label && type !== 'bug' && ['1', '2'].includes(priority)) ? 'relaxed' : 'normal'
    return { projectId, type, id, title: String(item[spec.title]).trim(), description: trackerText(item.description),
      status: item.status, assignedTo, assignees, priority, urgency,
      closed: terminal.includes(item.status.toLowerCase()),
      url: `https://www.tapd.cn/${encodeURIComponent(projectId)}/prong/${spec.endpoint}/view/${encodeURIComponent(id)}` }
  }
  async getItem(projectId: string, type: string, id: string, signal: AbortSignal): Promise<ExternalItem | undefined> {
    const spec = TYPES[type]
    if (!spec || !this.config.itemTypes.includes(type)) throw new Error('unsupported TAPD item type')
    const rows = await this.get(spec.endpoint, { workspace_id: projectId, id: opaqueId(id), limit: '1' }, signal)
    if (!rows.length) return undefined
    const item = this.normalize(rows[0], projectId, type)
    if (item.id !== id) throw new Error('TAPD item mismatch')
    return item
  }
  async getItems(projectId: string, signal: AbortSignal): Promise<ExternalItem[]> {
    const all: ExternalItem[] = []
    for (const type of this.config.itemTypes) {
      const spec = TYPES[type]
      if (!spec) throw new Error('unsupported TAPD item type')
      const seen = new Set<string>()
      let cursor = ''
      for (let page = 0; page < 10_000; page++) {
        const params: Record<string, string> = { workspace_id: projectId, limit: '200', order: 'id desc',
          fields: `id,workspace_id,${spec.title},description,status,${spec.owner},priority,priority_label,created` }
        if (cursor) params.cursor = cursor
        const rows = await this.get(spec.endpoint, params, signal)
        if (!rows.length) break
        let added = 0
        let last = ''
        for (const row of rows) {
          const item = this.normalize(row, projectId, type)
          last = item.id
          if (seen.has(item.id)) continue
          seen.add(item.id); added++
          const raw = (row as Record<string, Record<string, unknown>>)[spec.wrapper]!
          const created = typeof raw.created === 'string' ? raw.created.slice(0, 10) : ''
          if (!this.config.since || !created || created >= this.config.since) all.push(item)
        }
        if (!added || last === cursor) throw new Error('TAPD cursor did not advance')
        cursor = last
        if (rows.length < 200) break
        if (page === 9999) throw new Error('TAPD scan limit exceeded')
      }
    }
    return all
  }
}
