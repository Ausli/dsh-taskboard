import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ZentaoProvider } from '../src/host/zentao.ts'
import { ExternalSyncService, normalizeExternalConfig } from '../src/host/external-sync.ts'
import { TaskStore } from '../src/host/store.ts'

const servers: Server[] = []; const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())) }
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})
const base = { provider: 'zentao', baseUrl: 'https://zentao.test', account: 'alice', credentials: { username: 'alice', password: 'private' },
  mappingMode: 'project', settings: { requestIntervalMs: '0' }, itemTypes: ['bug', 'story', 'task'], mappings: [{ projectId: 'project:1', workspaceId: 'ws' }] }
const story = { id: '1', product: 1, title: 'Requirement', status: 'active', assignedTo: { account: 'alice' }, pri: 1, openedDate: '2026-10-01' }
const task = { id: '1', execution: 1, name: 'Development', status: 'doing', assignedTo: 'alice', pri: 4, desc: '<p>Implement</p>' }

describe('ZenTao projects and executions', () => {
  it.each((['project', 'execution'] as const).flatMap(mappingMode => ['bug', 'story', 'task'].map(type => ({ mappingMode, type }))))('reads only $type in $mappingMode mode', async ({ mappingMode, type }) => {
    const calls: string[] = []; const scope = `${mappingMode}:1`
    const fetcher = (async (input: unknown) => {
      const url = new URL(String(input)); calls.push(url.pathname)
      if (url.pathname.endsWith('/tokens')) return new Response('{"token":"t"}')
      if (url.pathname.endsWith('/executions')) return new Response(JSON.stringify({ total: 1, executions: [{ id: 1, name: 'Sprint' }] }))
      const key = type === 'story' ? 'stories' : `${type}s`
      const row = type === 'story' ? { ...story, spec: 'Requirement', verify: 'Acceptance' } : type === 'task' ? task
        : { id: 1, title: 'Bug', assignedTo: 'alice', status: 'active', steps: 'Reproduce' }
      return new Response(JSON.stringify({ total: 1, [key]: [row] }))
    }) as typeof fetch
    const provider = new ZentaoProvider(normalizeExternalConfig({ ...base, mappingMode, itemTypes: [type], mappings: [{ projectId: scope, workspaceId: 'ws' }] }), fetcher)
    const result = await provider.getItems(scope, AbortSignal.timeout(1000))
    expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ type, projectId: scope })
    expect(calls.some(path => path.endsWith('/projects/1/tasks'))).toBe(false)
    if (type !== 'task') expect(calls.some(path => path.endsWith('/executions'))).toBe(false)
    if (mappingMode === 'execution') expect(calls).toContain(`/api.php/v1/executions/1/${type === 'story' ? 'stories' : type + 's'}`)
  })
  it('allows a shared story to create separate cards for separately mapped executions', async () => {
    const fetcher = (async (input: unknown) => new Response(JSON.stringify(String(input).endsWith('/tokens') ? { token: 't' }
      : { total: 1, stories: [{ ...story, spec: 'Details', verify: '' }] }))) as typeof fetch
    const dir = await mkdtemp(join(tmpdir(), 'zentao-multi-mapping-')); dirs.push(dir)
    const store = new TaskStore({ file: join(dir, 'tasks.json') })
    const service = new ExternalSyncService({ file: join(dir, 'config.json'), store, workspaceExists: () => true, provider: c => new ZentaoProvider(c, fetcher) })
    try {
      await service.configure({ ...base, mappingMode: 'execution', itemTypes: ['story'], mappings: [{ projectId: 'execution:1', workspaceId: 'ws' }, { projectId: 'execution:2', workspaceId: 'other' }] })
      expect((await service.sync()).created).toBe(2)
      expect(store.snapshot().tasks.map(t => t.workspaceId)).toEqual(['ws', 'other'])
      expect((await service.sync()).created).toBe(0)
      await store.mutate('task-deleted', ledger => { ledger.tasks.shift(); return [] })
      expect(await service.sync()).toMatchObject({ created: 0, ignored: 1, unchanged: 1 })
      const connectionId = (await service.status()).config!.id
      await service.configure({ ...base, itemTypes: ['story'], mappings: [{ projectId: 'project:1', workspaceId: 'ws' }] })
      expect((await service.status()).config!.id).toBe(connectionId)
      expect((await service.sync()).created).toBe(1)
      expect(store.snapshot().tasks.map(t => t.external!.item.projectId)).toEqual(['execution:2', 'project:1'])
      await service.configure({ ...base, itemTypes: ['story'], mappings: [{ projectId: 'project:1', workspaceId: 'other' }] })
      await service.sync()
      expect(store.snapshot().tasks[1]!.workspaceId).toBe('ws')
    } finally { service.dispose() }
  })
  it('validates mapping mode, drops unlinked rows, and rejects old product IDs on save', () => {
    expect(normalizeExternalConfig({ ...base, mappings: [...base.mappings, { projectId: 'project:2', workspaceId: '' }] }).mappings).toEqual(base.mappings)
    expect(() => normalizeExternalConfig({ ...base, mappingMode: undefined })).toThrow('mapping mode')
    expect(() => normalizeExternalConfig({ ...base, mappings: [{ projectId: '1', workspaceId: 'ws' }] })).toThrow('mapping IDs')
    expect(() => normalizeExternalConfig({ ...base, mappingMode: 'execution' })).toThrow('mapping IDs')
    expect(normalizeExternalConfig({ ...base, mappings: [{ projectId: 'project:1', workspaceId: '' }] }).mappings).toEqual([])
    expect(() => normalizeExternalConfig({ ...base, mappings: [...base.mappings, ...base.mappings] })).toThrow('duplicate')
  })
  it('imports all three types through real HTTP and preserves closure/reassignment and local status', async () => {
    const calls: string[] = []; let closed = false; let failTasks = false
    const server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost'); calls.push(url.pathname + url.search)
      if (url.pathname.endsWith('/tokens')) { res.end(JSON.stringify({ token: 'generated' })); return }
      expect(req.headers.token).toBe('generated')
      let value: unknown
      if (url.pathname.endsWith('/projects/1/bugs')) value = { total: 1, bugs: [{ id: '1', product: 1, title: 'Bug', status: 'active', assignedTo: 'alice', steps: 'Reproduce' }] }
      else if (url.pathname.endsWith('/projects/1/stories')) value = { total: 1, stories: [{ ...story, ...(closed ? { status: 'closed', assignedTo: 'bob' } : {}) }] }
      else if (url.pathname.endsWith('/stories/1')) value = { ...story, spec: '<p>Describe</p>', verify: '<p>Acceptance</p>', ...(closed ? { status: 'closed', assignedTo: 'bob' } : {}) }
      else if (url.pathname.endsWith('/projects/1/executions')) value = { total: 2, executions: [{ id: 1, name: 'Sprint 1' }, { id: 2, name: 'Sprint 2' }] }
      else if (url.pathname.endsWith('/executions/2/tasks')) {
        if (failTasks) { res.statusCode = 400; res.end('{}'); return }
        value = { total: 1, tasks: [{ ...task, execution: 2 }] }
      }
      else if (url.pathname.endsWith('/executions/1/tasks')) {
        value = { total: 2, tasks: [closed ? { ...task, status: 'done', assignedTo: 'bob' } : task,
          { ...task, id: '2', status: 'cancel' }] }
      } else { res.statusCode = 404; res.end('{}'); return }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value))
    }); servers.push(server)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const dir = await mkdtemp(join(tmpdir(), 'zentao-types-')); dirs.push(dir)
    const store = new TaskStore({ file: join(dir, 'tasks.json') })
    const service = new ExternalSyncService({ file: join(dir, 'config.json'), store, workspaceExists: () => true })
    try {
      await service.configure({ ...base, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, importStatus: 'todo' })
      expect((await service.sync()).created).toBe(3)
      expect(store.snapshot().tasks.map(t => t.external!.item.type)).toEqual(['bug', 'story', 'task'])
      expect(store.snapshot().tasks[1]!.description).toBe('Describe\n\nAcceptance')
      expect(store.snapshot().tasks[2]).toMatchObject({ title: 'Development', urgency: 'relaxed', status: 'todo', external: { item: { projectId: 'project:1' } } })
      expect(calls.some(c => c.includes('/stories?status=allstory'))).toBe(true)
      expect((await service.sync()).created).toBe(0)
      closed = true; await service.sync()
      expect(store.snapshot().tasks.slice(1).every(t => t.status === 'todo' && t.external!.item.closed && t.external!.item.assignedTo === 'bob')).toBe(true)
      expect(store.snapshot().tasks[2]!.external!.item.url).toContain('m=task&f=view&taskID=1')
      const snapshot = store.snapshot().tasks; failTasks = true
      await expect(service.sync()).rejects.toThrow('External sync failed')
      expect(store.snapshot().tasks).toEqual(snapshot)
    } finally { service.dispose() }
  })
  it('discovers projects or executions independently of selected work item types', async () => {
    const calls: string[] = []
    const fetcher = (async (input: unknown) => {
      const path = new URL(String(input)).pathname; calls.push(path)
      return new Response(JSON.stringify(path.endsWith('/tokens') ? { token: 't' }
        : path.endsWith('/projects') ? { total: 1, projects: [{ id: 9, name: 'Project' }] } : { total: 1, executions: [{ id: 1, name: 'Sprint' }] }))
    }) as typeof fetch
    expect(await new ZentaoProvider(normalizeExternalConfig({ ...base, itemTypes: ['task'] }), fetcher).listProjects(AbortSignal.timeout(1000))).toEqual([{ id: 'project:9', name: 'Project' }])
    expect(calls.some(path => path.includes('/executions'))).toBe(false)
    expect(await new ZentaoProvider(normalizeExternalConfig({ ...base, mappingMode: 'execution', mappings: [{ projectId: 'execution:1', workspaceId: 'ws' }], itemTypes: ['bug'] }), fetcher).listProjects(AbortSignal.timeout(1000))).toEqual([{ id: 'execution:1', name: 'Project / Sprint' }])
  })
  it('finishes project and execution discovery pages and rejects stalled discovery', async () => {
    let repeat = false
    const calls: string[] = []
    const fetcher = (async (input: unknown) => {
      const url = new URL(String(input)); calls.push(url.pathname + url.search)
      if (url.pathname.endsWith('/tokens')) return new Response('{"token":"t"}')
      const page = repeat ? 1 : Number(url.searchParams.get('page'))
      const key = url.pathname.endsWith('/projects') ? 'projects' : 'executions'
      const parent = url.pathname.match(/projects\/(\d+)\//)?.[1] ?? ''
      return new Response(JSON.stringify({ total: 2, [key]: [{ id: `${parent}${page}`, name: 'Scope' }] }))
    }) as typeof fetch
    const config = normalizeExternalConfig({ ...base, mappingMode: 'execution', itemTypes: ['story'], mappings: [{ projectId: 'execution:1', workspaceId: 'ws' }] })
    expect((await new ZentaoProvider(config, fetcher).listProjects(AbortSignal.timeout(1000))).map(s => s.id)).toEqual(['execution:11', 'execution:12', 'execution:21', 'execution:22'])
    expect(calls.some(path => path.includes('/projects/2/executions?') && path.endsWith('page=2'))).toBe(true)
    repeat = true
    await expect(new ZentaoProvider(config, fetcher).listProjects(AbortSignal.timeout(1000))).rejects.toThrow('pagination did not advance')
  })
  it('paginates stories and rejects nonadvancing pages and wrong detail scopes', async () => {
    let mode = 'pages'
    const fetcher = (async (input: unknown) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/tokens')) return new Response('{"token":"t"}')
      if (url.pathname.endsWith('/stories/1')) return new Response(JSON.stringify({ ...story, product: 99, spec: '', verify: '' }))
      const page = Number(url.searchParams.get('page'))
      return new Response(JSON.stringify({ total: 2, stories: [{ ...story, id: mode === 'repeat' || mode === 'details' ? '1' : String(page), ...(mode !== 'details' ? { spec: '', verify: '' } : {}) }] }))
    }) as typeof fetch
    const provider = new ZentaoProvider(normalizeExternalConfig({ ...base, itemTypes: ['story'] }), fetcher)
    expect((await provider.getItems('project:1', AbortSignal.timeout(1000))).map(i => i.id)).toEqual(['1', '2'])
    mode = 'repeat'; await expect(provider.getItems('project:1', AbortSignal.timeout(1000))).rejects.toThrow('did not advance')
    mode = 'details'; await expect(provider.getItem('project:1', 'story', '1', AbortSignal.timeout(1000))).rejects.toThrow('details')
  })
})
