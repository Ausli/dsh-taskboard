import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { registerTaskboardRoutes } from '../src/host/routes.ts'
import { ExternalSyncService } from '../src/host/external-sync.ts'
import { ZentaoProvider } from '../src/host/zentao.ts'
import { TaskStore } from '../src/host/store.ts'
import { ExternalProviderRegistry } from '../src/host/external-provider.ts'
import { createBuiltinProviders } from '../src/host/external-providers.ts'
import { TapdProvider } from '../src/host/tapd.ts'

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()))
}

describe('external sync HTTP integration', () => {
  it('runs TAPD through registered providers and routes, keeps type identities and redacts both auth modes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-tapd-http-'))
    let fail = false
    let changed = false
    const authHeaders: string[] = []
    const tracker = createServer((req, res) => {
      authHeaders.push(req.headers.authorization ?? '')
      const url = new URL(req.url!, 'http://localhost')
      res.setHeader('Content-Type', 'application/json')
      if (fail) { res.end(JSON.stringify({ status: 0, info: 'private-password private-access-token', data: [] })); return }
      if (url.pathname === '/workspaces/user_participant_projects') { res.end(JSON.stringify({ status: 1, data: [{ Workspace: { id: '1', name: 'Team project' } }] })); return }
      const wrapper = url.pathname === '/bugs' ? 'Bug' : url.pathname === '/stories' ? 'Story' : 'Task'
      const fields = { id: '1010104801000000001', workspace_id: '1', title: changed ? 'Changed' : 'Bug', name: changed ? 'Changed' : 'Work',
        description: '<p>Details</p>', status: changed ? 'closed' : 'open', current_owner: 'alice;bob;', owner: 'alice;bob;', priority_label: 'High' }
      const unrelated = { ...fields, id: '1010104801000000002', owner: 'malice;', current_owner: 'malice;' }
      res.end(JSON.stringify({ status: 1, data: [{ [wrapper]: fields }, { [wrapper]: unrelated }] }))
    })
    const trackerUrl = await listen(tracker)
    const registry = new ExternalProviderRegistry()
    const builtins = createBuiltinProviders()
    for (const descriptor of builtins.list()) {
      const definition = builtins.get(descriptor.id)
      registry.register(descriptor.id === 'tapd' ? { ...definition, create: config => new TapdProvider(config, fetch, 0) } : definition)
    }
    const store = new TaskStore({ file: join(dir, 'tasks.json') })
    const file = join(dir, 'connection.json')
    const service = new ExternalSyncService({ file, store, registry, workspaceExists: id => id === 'ws' })
    const routes: Array<{ path: string; handler: (req: never, res: never) => void }> = []
    const dispose = registerTaskboardRoutes({ webServer: { register: (r: typeof routes[number]) => { routes.push(r); return () => {} } } } as never,
      { store, workspaces: { list: () => [{ id: 'ws', path: dir, title: 'Test' }], get: () => ({ id: 'ws', path: dir, title: 'Test' }), resolveByPath: async () => ({ id: 'ws' }) }, now: Date.now, externalSync: service })
    const server = createServer((req, res) => {
      const route = routes.filter(r => req.url?.startsWith(r.path)).sort((a, b) => b.path.length - a.path.length)[0]
      if (route) route.handler(req as never, res as never)
      else { res.writeHead(404); res.end() }
    })
    const base = await listen(server)
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${base}/dsh-taskboard/external${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return { status: response.status, body: await response.json() }
    }
    const input = { provider: 'tapd', baseUrl: trackerUrl, account: 'alice', authMode: 'basic', credentials: { apiUser: 'api-user', apiPassword: 'private-password' },
      itemTypes: ['bug', 'story', 'task'], mappings: [{ projectId: '1', workspaceId: 'ws' }], settings: { companyId: '1' } }
    try {
      expect((await post('/projects', { ...input, mappings: [] })).body.value).toEqual([{ id: '1', name: 'Team project' }])
      expect((await post('/config', input)).status).toBe(200)
      expect((await post('/test', {})).status).toBe(200)
      expect((await post('/sync', {})).body.value.created).toBe(3)
      expect(store.snapshot().tasks.map(t => t.external!.item.type)).toEqual(['bug', 'story', 'task'])
      expect(store.snapshot().tasks.every(t => t.status === 'backlog')).toBe(true)
      const originalId = (await service.status()).config!.id
      expect((await post('/config', { ...input, authMode: 'bearer', credentials: {} })).status).toBe(400)
      expect((await post('/config', { ...input, authMode: 'bearer', credentials: { accessToken: 'private-access-token' } })).status).toBe(200)
      expect((await service.status()).config!.id).toBe(originalId)
      expect((await post('/sync', {})).body.value.unchanged).toBe(3)
      changed = true
      await store.mutate('task-updated', ledger => { ledger.tasks[0]!.status = 'in_review'; return [ledger.tasks[0]!] })
      expect((await post('/sync', {})).body.value.conflicts).toBe(1)
      expect(store.snapshot().tasks[0]).toMatchObject({ title: 'Bug', status: 'in_review', external: { providerName: 'TAPD', item: { status: 'closed' } } })
      const snapshot = store.snapshot()
      fail = true
      const failure = await post('/sync', {})
      expect(failure.status).toBe(400)
      expect(JSON.stringify(failure)).not.toMatch(/private-password|private-access-token/)
      expect(store.snapshot().tasks).toEqual(snapshot.tasks)
      const statusText = await fetch(`${base}/dsh-taskboard/external`).then(r => r.text())
      expect(statusText).not.toMatch(/private-password|private-access-token/)
      expect(authHeaders).toContain(`Basic ${Buffer.from('api-user:private-password').toString('base64')}`)
      expect(authHeaders).toContain('Bearer private-access-token')
      const restored = new ExternalSyncService({ file, store, registry, workspaceExists: () => true })
      expect(await restored.status()).toMatchObject({ config: { provider: 'tapd', authMode: 'bearer', id: originalId }, credentialPresent: { accessToken: true } })
      restored.dispose()
    } finally { service.dispose(); dispose(); await close(server); await close(tracker); await rm(dir, { recursive: true, force: true }) }
  })
  it('connects real routes, provider and store; preserves state and credentials across restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-external-http-'))
    let title = 'Mock bug'
    let status = 'active'
    let fail = false
    const tracker = createServer((req, res) => {
      if (req.url === '/api.php/v1/tokens') {
        const chunks: Buffer[] = []
        req.on('data', chunk => chunks.push(Buffer.from(chunk)))
        req.on('end', () => {
          expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ account: 'alice-login', password: 'private-login-password' })
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ token: 'test-token' }))
        })
        return
      }
      expect(req.headers.token).toBe('test-token')
      if (fail) { res.writeHead(403); res.end('{"error":"test-token must not leak"}'); return }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ page: 1, total: 1, bugs: [{ id: '100', title, status, assignedTo: { account: 'alice' }, steps: '<p>Reproduce</p>', pri: '1' }] }))
    })
    const trackerUrl = await listen(tracker)
    const file = join(dir, 'connection.json')
    const store = new TaskStore({ file: join(dir, 'tasks.json') })
    const workspaces = { list: () => [{ id: 'ws', path: dir, title: 'Test' }], get: (id: string) => id === 'ws' ? { id: 'ws', path: dir, title: 'Test' } : undefined, resolveByPath: async () => ({ id: 'ws' }) }
    const makeService = () => new ExternalSyncService({ file, store, workspaceExists: id => id === 'ws', provider: config => new ZentaoProvider(config) })
    let service = makeService()
    const routes: Array<{ path: string; handler: (req: never, res: never) => void }> = []
    const dispose = registerTaskboardRoutes({ webServer: { register: (r: typeof routes[number]) => { routes.push(r); return () => {} } } } as never,
      { store, workspaces, now: Date.now, externalSync: service })
    const server = createServer((req, res) => {
      const route = routes.filter(r => req.url?.startsWith(r.path)).sort((a, b) => b.path.length - a.path.length)[0]
      if (route) route.handler(req as never, res as never)
      else { res.writeHead(404); res.end() }
    })
    const base = await listen(server)
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${base}/dsh-taskboard${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json() }
    }
    try {
      expect((await post('/external/config', { baseUrl: trackerUrl, account: 'alice', authMode: 'password', credentials: { username: 'alice-login', password: 'private-login-password' }, mappings: [{ projectId: '1', workspaceId: 'ws' }] })).status).toBe(200)
      expect((await post('/external/test', {})).status).toBe(200)
      expect((await post('/external/sync', {})).body.value.created).toBe(1)
      const task = store.snapshot().tasks[0]!
      expect(task).toMatchObject({ status: 'backlog', description: 'Reproduce', urgency: 'urgent' })
      expect((await post('/external/sync', {})).body.value.unchanged).toBe(1)
      await store.mutate('task-updated', ledger => { ledger.tasks[0]!.status = 'in_review'; return [ledger.tasks[0]!] })
      title = 'Changed'; status = 'closed'
      expect((await post('/external/sync', {})).body.value.conflicts).toBe(1)
      const changed = store.snapshot().tasks[0]!
      expect(changed.status).toBe('in_review')
      expect((await post('/external/resolve', { taskId: task.id, field: 'title', acceptExternal: true, ifVersion: changed.version })).status).toBe(200)
      expect(store.snapshot().tasks[0]!.title).toBe('Changed')
      fail = true
      const failed = await post('/external/sync', {})
      expect(failed.status).toBe(400); expect(JSON.stringify(failed)).not.toContain('test-token')
      const state = await fetch(`${base}/dsh-taskboard/external`).then(r => r.text())
      expect(state).not.toContain('test-token')
      service.dispose(); service = makeService()
      expect(await service.status()).toMatchObject({ credentialPresent: { password: true }, credentialValues: { username: 'alice-login' }, config: { baseUrl: trackerUrl } })
      fail = false
      expect((await service.sync()).created).toBe(0)
    } finally { service.dispose(); dispose(); await close(server); await close(tracker); await rm(dir, { recursive: true, force: true }) }
  })
})
