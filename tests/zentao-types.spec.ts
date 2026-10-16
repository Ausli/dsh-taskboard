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
  settings: { requestIntervalMs: '0' }, itemTypes: ['bug', 'story', 'task'], mappings: [{ projectId: '1', workspaceId: 'ws' }, { projectId: 'execution:1', workspaceId: 'ws' }] }
const story = { id: '1', product: 1, title: 'Requirement', status: 'active', assignedTo: { account: 'alice' }, pri: 1, openedDate: '2026-10-01' }
const task = { id: '1', execution: 1, name: 'Development', status: 'doing', assignedTo: 'alice', pri: 4, desc: '<p>Implement</p>' }

describe('ZenTao products and executions', () => {
  it('keeps old product identities and validates task/product mappings', () => {
    expect(normalizeExternalConfig({ ...base, itemTypes: ['bug'], mappings: [base.mappings[0]] }).mappings[0]!.projectId).toBe('1')
    expect(() => normalizeExternalConfig({ ...base, mappings: [base.mappings[0]] })).toThrow('execution mapping')
    expect(() => normalizeExternalConfig({ ...base, mappings: [base.mappings[1]] })).toThrow('product mapping')
    expect(() => normalizeExternalConfig({ ...base, mappings: [...base.mappings, base.mappings[1]] })).toThrow('duplicate')
  })
  it('imports all three types through real HTTP and preserves closure/reassignment and local status', async () => {
    const calls: string[] = []; let closed = false; let failTasks = false
    const server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost'); calls.push(url.pathname + url.search)
      if (url.pathname.endsWith('/tokens')) { res.end(JSON.stringify({ token: 'generated' })); return }
      expect(req.headers.token).toBe('generated')
      let value: unknown
      if (url.pathname.endsWith('/products/1/bugs')) value = { total: 1, bugs: [{ id: '1', product: 1, title: 'Bug', status: 'active', assignedTo: 'alice', steps: 'Reproduce' }] }
      else if (url.pathname.endsWith('/products/1/stories')) value = { total: 1, stories: [{ ...story, ...(closed ? { status: 'closed', assignedTo: 'bob' } : {}) }] }
      else if (url.pathname.endsWith('/stories/1')) value = { ...story, spec: '<p>Describe</p>', verify: '<p>Acceptance</p>', ...(closed ? { status: 'closed', assignedTo: 'bob' } : {}) }
      else if (url.pathname.endsWith('/executions/1/tasks')) {
        if (failTasks) { res.statusCode = 400; res.end('{}'); return }
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
      expect(store.snapshot().tasks[2]).toMatchObject({ title: 'Development', urgency: 'relaxed', status: 'todo', external: { item: { projectId: 'execution:1' } } })
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
  it('discovers products and execution IDs without mixing equal numeric IDs', async () => {
    const fetcher = (async (input: unknown) => {
      const path = new URL(String(input)).pathname
      return new Response(JSON.stringify(path.endsWith('/tokens') ? { token: 't' } : path.endsWith('/products') ? { total: 1, products: [{ id: 1, name: 'Product' }] }
        : path.endsWith('/projects') ? { total: 1, projects: [{ id: 9, name: 'Project' }] } : { total: 1, executions: [{ id: 1, name: 'Sprint' }] }))
    }) as typeof fetch
    expect(await new ZentaoProvider(normalizeExternalConfig(base), fetcher).listProjects(AbortSignal.timeout(1000))).toEqual([
      { id: '1', name: 'Product' }, { id: 'execution:1', name: 'Project / Sprint' },
    ])
  })
  it('paginates stories and rejects nonadvancing pages and wrong detail scopes', async () => {
    let mode = 'pages'
    const fetcher = (async (input: unknown) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/tokens')) return new Response('{"token":"t"}')
      if (url.pathname.endsWith('/stories/1')) return new Response(JSON.stringify({ ...story, product: 99, spec: '', verify: '' }))
      const page = Number(url.searchParams.get('page'))
      return new Response(JSON.stringify({ total: 2, stories: [{ ...story, id: mode === 'repeat' ? '1' : String(page), spec: '', verify: '' }] }))
    }) as typeof fetch
    const provider = new ZentaoProvider(normalizeExternalConfig({ ...base, itemTypes: ['story'] }), fetcher)
    expect((await provider.getItems('1', AbortSignal.timeout(1000))).map(i => i.id)).toEqual(['1', '2'])
    mode = 'repeat'; await expect(provider.getItems('1', AbortSignal.timeout(1000))).rejects.toThrow('did not advance')
    await expect(provider.getItem('1', 'story', '1', AbortSignal.timeout(1000))).rejects.toThrow('details')
  })
})
