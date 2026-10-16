import { describe, it, expect } from 'vitest'
import { TapdProvider } from '../src/host/tapd.ts'
import { normalizeExternalConfig } from '../src/host/external-sync.ts'
import type { ExternalConfig } from '../src/shared/external.ts'

const id = '1010104801000000001'
function config(changes: Partial<ExternalConfig> = {}): ExternalConfig {
  return { id: 'connection', provider: 'tapd', authMode: 'basic', baseUrl: 'https://api.tapd.cn', account: 'alice',
    credentials: { apiUser: 'api-user', apiPassword: 'private-password' }, settings: {}, mappings: [{ projectId: '1', workspaceId: 'ws' }],
    itemTypes: ['bug', 'story', 'task'], intervalMinutes: 0, since: '', ...changes }
}
const row = (type: string, overrides: Record<string, unknown> = {}) => ({
  [type === 'bug' ? 'Bug' : type === 'story' ? 'Story' : 'Task']: {
    id, workspace_id: '1', title: 'Bug title', name: 'Work title', description: '<p>Steps</p><script>danger()</script>', status: 'open',
    current_owner: 'alice;bob;', owner: 'alice;bob;', priority_label: '高', created: '2026-10-16 12:00:00', ...overrides,
  },
})
const response = (data: unknown, status = 1) => new Response(JSON.stringify({ status, data, info: 'private-password must not leak' }), { headers: { 'Content-Type': 'application/json' } })

describe('TAPD provider', () => {
  it('normalizes all types, multi-assignees, priority labels and links with Basic auth', async () => {
    const calls: Array<{ url: string; headers: Headers }> = []
    const mock = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input)); calls.push({ url: url.href, headers: new Headers(init?.headers) })
      const type = url.pathname === '/bugs' ? 'bug' : url.pathname === '/stories' ? 'story' : 'task'
      expect(url.searchParams.get('order')).toBe('id desc')
      expect(url.searchParams.get('workspace_id')).toBe('1')
      return response([row(type)])
    }) as typeof fetch
    const items = await new TapdProvider(config(), mock, 0).getItems('1', AbortSignal.timeout(1000))
    expect(items.map(i => i.type)).toEqual(['bug', 'story', 'task'])
    expect(items[0]).toMatchObject({ id, assignedTo: 'alice;bob;', assignees: ['alice', 'bob'], urgency: 'urgent', description: 'Steps' })
    expect(items[1]!.url).toContain('/prong/stories/view/')
    expect(calls.every(c => c.headers.get('authorization') === `Basic ${Buffer.from('api-user:private-password').toString('base64')}`)).toBe(true)
    expect(calls.every(c => !c.url.includes('private-password'))).toBe(true)
  })
  it('uses cursor pagination beyond the first full page without losing long IDs or duplicating boundaries', async () => {
    const ids = Array.from({ length: 201 }, (_, index) => (BigInt(id) + BigInt(201 - index)).toString())
    const calls: URL[] = []
    const mock = (async (input: string | URL | Request) => {
      const url = new URL(String(input)); calls.push(url)
      return response((calls.length === 1 ? ids.slice(0, 200) : ids.slice(199)).map(value => row('bug', { id: value })))
    }) as typeof fetch
    const items = await new TapdProvider(config({ itemTypes: ['bug'] }), mock, 0).getItems('1', AbortSignal.timeout(1000))
    expect(items).toHaveLength(201)
    expect(calls[1]!.searchParams.get('cursor')).toBe(ids[199])
    expect(calls[1]!.searchParams.has('page')).toBe(false)
    expect(new Set(items.map(i => i.id)).size).toBe(201)
  })
  it('rejects a server ignoring cursor rather than silently completing', async () => {
    const rows = Array.from({ length: 200 }, (_, index) => row('bug', { id: (BigInt(id) + BigInt(index)).toString() }))
    const mock = (async () => response(rows)) as typeof fetch
    await expect(new TapdProvider(config({ itemTypes: ['bug'] }), mock, 0).getItems('1', AbortSignal.timeout(1000))).rejects.toThrow('cursor did not advance')
  })
  it('supports bearer credentials and explicit status/priority settings', async () => {
    const mock = (async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-token')
      return response([row('bug', { status: 'custom-finished', priority_label: 'Blocker' })])
    }) as typeof fetch
    const items = await new TapdProvider(config({ authMode: 'bearer', credentials: { accessToken: 'private-token' }, itemTypes: ['bug'],
      settings: { terminalStatuses: 'custom-finished', urgentPriorities: 'Blocker' } }), mock, 0).getItems('1', AbortSignal.timeout(1000))
    expect(items[0]).toMatchObject({ closed: true, urgency: 'urgent', priority: 'Blocker' })
  })
  it('rejects HTTP-200 API failures and unsafe numeric IDs without returning server bodies', async () => {
    const rejected = (async () => response([], 0)) as typeof fetch
    await expect(new TapdProvider(config(), rejected, 0).getItems('1', AbortSignal.timeout(1000))).rejects.toThrow('TAPD API rejected')
    const unsafe = (async () => response([row('bug', { id: 1010104801000000001 })])) as typeof fetch
    await expect(new TapdProvider(config(), unsafe, 0).getItems('1', AbortSignal.timeout(1000))).rejects.toThrow('unsafe numeric')
  })
  it('fetches details by exact scope/type/ID and validates project mismatches', async () => {
    const mock = (async (input: string | URL | Request) => {
      expect(new URL(String(input)).searchParams.get('id')).toBe(id)
      return response([row('story')])
    }) as typeof fetch
    expect(await new TapdProvider(config(), mock, 0).getItem('1', 'story', id, AbortSignal.timeout(1000))).toMatchObject({ type: 'story', id })
    const wrong = (async () => response([row('bug', { workspace_id: '2' })])) as typeof fetch
    await expect(new TapdProvider(config(), wrong, 0).getItems('1', AbortSignal.timeout(1000))).rejects.toThrow('project mismatch')
  })
  it('discovers projects by company and explicit nickname', async () => {
    const mock = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/workspaces/user_participant_projects')
      expect(url.searchParams.get('company_id')).toBe('123')
      expect(url.searchParams.get('nick')).toBe('alice')
      return response([{ Workspace: { id: '1', name: 'Project' } }])
    }) as typeof fetch
    expect(await new TapdProvider(config({ settings: { companyId: '123' } }), mock, 0).listProjects(AbortSignal.timeout(1000))).toEqual([{ id: '1', name: 'Project' }])
    await expect(new TapdProvider(config(), mock, 0).listProjects(AbortSignal.timeout(1000))).rejects.toThrow('company ID')
  })
})

describe('provider configuration', () => {
  const input = { provider: 'tapd', baseUrl: 'https://api.tapd.cn', account: 'alice', authMode: 'basic',
    credentials: { apiUser: 'u', apiPassword: 'p' }, mappings: [{ projectId: '1', workspaceId: 'ws' }], itemTypes: ['bug', 'story', 'task'] }
  it('validates selected auth mode and retains only the corresponding declared credentials', () => {
    const first = normalizeExternalConfig(input)
    expect(first.credentials).toEqual({ apiUser: 'u', apiPassword: 'p' })
    const second = normalizeExternalConfig({ ...input, credentials: {} }, first)
    expect(second.id).toBe(first.id)
    expect(second.credentials).toEqual(first.credentials)
    expect(() => normalizeExternalConfig({ ...input, authMode: 'bearer', credentials: {} }, first)).toThrow('enter credentials')
    const bearer = normalizeExternalConfig({ ...input, authMode: 'bearer', credentials: { accessToken: 't', apiPassword: 'drop' } }, first)
    expect(bearer.credentials).toEqual({ accessToken: 't' })
    expect(bearer.id).toBe(first.id)
  })
  it('rejects unknown providers, types, auth and credential reuse across platforms', () => {
    expect(() => normalizeExternalConfig({ ...input, provider: 'typo' })).toThrow('unsupported external provider')
    expect(() => normalizeExternalConfig({ ...input, itemTypes: ['unknown'] })).toThrow('work item types')
    expect(() => normalizeExternalConfig({ ...input, authMode: 'unknown' })).toThrow('authentication')
    expect(() => normalizeExternalConfig({ ...input, credentials: {} }, normalizeExternalConfig({ ...input, account: 'bob' }))).toThrow('enter credentials')
  })
})
