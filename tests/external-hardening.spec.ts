import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskStore } from '../src/host/store.ts'
import { ExternalSyncService, normalizeExternalConfig } from '../src/host/external-sync.ts'
import { externalKey, type ExternalItem } from '../src/shared/external.ts'
import { validateLedgerImport } from '../src/shared/protocol.ts'
import { ZentaoProvider } from '../src/host/zentao.ts'
import { ExternalRequestThrottle } from '../src/host/external-http.ts'

const directories: string[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))) })
const item: ExternalItem = { projectId: 'project:1', id: '1', type: 'bug', title: 'Bug', description: 'Original', urgency: 'normal',
  priority: '2', status: 'active', assignedTo: 'alice', closed: false, url: 'https://zentao.test/bug/1' }
const config = { provider: 'zentao', mappingMode: 'project', baseUrl: 'https://zentao.test', account: 'alice', authMode: 'password',
  credentials: { username: 'alice', password: 'private-password' }, mappings: [{ projectId: 'project:1', workspaceId: 'ws' }] }
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'external-hardening-')); directories.push(dir)
  const file = join(dir, 'config.json'); const ledgerFile = join(dir, 'tasks.json')
  const store = new TaskStore({ file: ledgerFile })
  let incoming = [structuredClone(item)]; let fail = false
  const options = { file, store, workspaceExists: () => true, now: () => 1000,
    provider: () => ({ test: async () => {}, getItems: async () => { if (fail) throw new Error('private-password'); return incoming } }) }
  const service = new ExternalSyncService(options); await service.configure(config)
  return { file, ledgerFile, store, service, options, set: (items: ExternalItem[]) => { incoming = items }, fail: () => { fail = true } }
}

describe('durable single-ledger synchronization', () => {
  it.each(['project', 'execution'] as const)('fills empty destinations after associating %s without replacing assigned destinations', async mappingMode => {
    const f = await fixture(); f.service.dispose()
    const scope = `${mappingMode}:1`
    const service = new ExternalSyncService({ ...f.options, provider: () => ({ test: async () => {},
      listProjects: async () => [{ id: scope, name: 'Scope' }],
      getItems: async () => Array.from({ length: 6 }, (_, index) => ({ ...item, projectId: scope, id: String(index + 1) })),
    }) })
    try {
      await service.configure({ ...config, mappingMode, includeUnmapped: true, mappings: [] })
      expect(await service.sync()).toMatchObject({ created: 6 })
      const ids = f.store.snapshot().tasks.map(t => t.id)
      await f.store.mutate('task-updated', ledger => {
        ledger.tasks[1]!.workspaceId = 'manual'
        ledger.tasks[2]!.status = 'done'
        ledger.tasks[3]!.status = 'canceled'
        ledger.tasks[4]!.status = 'archived'
        ledger.tasks[5]!.trashedAt = 1000
        return ledger.tasks
      })
      await service.configure({ ...config, mappingMode, includeUnmapped: false, mappings: [{ projectId: scope, workspaceId: 'ws' }] })
      expect(await service.sync()).toMatchObject({ created: 0, updated: 3, unchanged: 2, ignored: 1 })
      expect(f.store.snapshot().tasks.map(t => t.id)).toEqual(ids)
      expect(f.store.snapshot().tasks.map(t => t.workspaceId)).toEqual(['ws', 'manual', 'ws', 'ws', '', ''])
      expect(await service.sync()).toMatchObject({ created: 0, updated: 0, unchanged: 5, ignored: 1 })
      const reloaded = new TaskStore({ file: f.ledgerFile }); await reloaded.load()
      expect(reloaded.snapshot().tasks.map(t => t.workspaceId)).toEqual(['ws', 'manual', 'ws', 'ws', '', ''])
    } finally { service.dispose() }
  })
  it.each(['project', 'execution'] as const)('discovers unmapped %s scopes every round and creates projectless cards', async mappingMode => {
    const f = await fixture(); f.service.dispose()
    let scopes = [`${mappingMode}:1`, `${mappingMode}:2`]; let title = 'Bug'; let discoveryFails = false
    const options = { ...f.options, workspaceExists: (id: string) => { expect(id).not.toBe(''); return id === 'ws' },
      provider: () => ({ test: async () => {},
        listProjects: async () => { if (discoveryFails) throw new Error('discovery failed'); return scopes.map(id => ({ id, name: 'Scope' })) },
        getItems: async (projectId: string) => [{ ...item, projectId, title }],
      }) }
    const service = new ExternalSyncService(options)
    try {
      await service.configure({ ...config, mappingMode, includeUnmapped: true, mappings: [{ projectId: scopes[0], workspaceId: 'ws' }, { projectId: scopes[1], workspaceId: '' }] })
      expect(await service.sync()).toMatchObject({ created: 2 })
      expect(f.store.snapshot().tasks.map(t => t.workspaceId)).toEqual(['ws', ''])
      expect((await service.sync()).created).toBe(0)
      const reloaded = new TaskStore({ file: f.ledgerFile }); await reloaded.load()
      expect(reloaded.snapshot().tasks.map(t => t.workspaceId)).toEqual(['ws', ''])
      expect(validateLedgerImport(reloaded.snapshot(), new Set(), 1000).create).toHaveLength(2)
      scopes = [...scopes, `${mappingMode}:3`]
      expect((await service.sync()).created).toBe(1)
      expect(f.store.snapshot().tasks[2]!.workspaceId).toBe('')
      title = 'Changed'; expect((await service.sync()).updated).toBe(3)
      const unlinked = f.store.snapshot().tasks[1]!
      discoveryFails = true
      await expect(service.sync()).rejects.toThrow('External sync failed')
      expect(f.store.snapshot().tasks[1]).toEqual(unlinked)
      await service.configure({ ...config, mappingMode, includeUnmapped: false, mappings: [{ projectId: scopes[0], workspaceId: 'ws' }, { projectId: scopes[1], workspaceId: '' }] })
      title = 'Changed again'; expect((await service.sync()).updated).toBe(1)
      expect(f.store.snapshot().tasks[1]).toEqual(unlinked)
      expect(JSON.parse(await readFile(f.file, 'utf8')).config.includeUnmapped).toBe(false)
      await service.configure({ ...config, mappingMode, includeUnmapped: true, mappings: [] })
      expect((await service.status()).config).toMatchObject({ includeUnmapped: true, mappings: [] })
    } finally { service.dispose() }
  })
  it('retains old product credentials and tasks but pauses polling until explicitly reassociated', async () => {
    const f = await fixture(); await f.service.sync(); f.service.dispose()
    const saved = JSON.parse(await readFile(f.file, 'utf8'))
    delete saved.config.mappingMode; saved.config.mappings[0].projectId = '1'; saved.config.intervalMinutes = 5
    await writeFile(f.file, JSON.stringify(saved))
    await f.store.mutate('task-updated', ledger => {
      ledger.tasks[0]!.external!.item.projectId = '1'
      ledger.externalSync![saved.config.id]!.links = { [externalKey(saved.config.id, ledger.tasks[0]!.external!.item)]: ledger.tasks[0]!.id }
      return [ledger.tasks[0]!]
    })
    const oldTasks = f.store.snapshot().tasks; let reads = 0
    const service = new ExternalSyncService({ ...f.options, now: () => Date.now(), provider: () => ({ test: async () => {}, getItems: async () => { reads++; return [item] } }) })
    try {
      expect(await service.status()).toMatchObject({ requiresMappingReview: true, credentialPresent: { password: true }, credentialValues: { username: 'alice' } })
      await expect(service.sync()).rejects.toThrow('reassociate')
      vi.useFakeTimers(); service.start(); await vi.advanceTimersByTimeAsync(600_000); vi.useRealTimers()
      expect(reads).toBe(0); expect(f.store.snapshot().tasks).toEqual(oldTasks)
      expect(JSON.parse(await readFile(f.file, 'utf8'))).toEqual(saved)
      await service.configure({ ...saved.config, mappingMode: 'project', mappings: [{ projectId: 'project:1', workspaceId: 'ws' }], credentials: {} })
      expect((await service.status()).config!.id).toBe(saved.config.id)
      expect((await service.status()).requiresMappingReview).toBe(false)
      expect((await service.sync()).created).toBe(1)
      expect(f.store.snapshot().tasks[0]).toEqual(oldTasks[0])
    } finally { service.dispose(); vi.useRealTimers() }
  })
  it('tests unsaved form credentials without overwriting the saved connection', async () => {
    const f = await fixture(); const tested: string[] = []
    const service = new ExternalSyncService({ ...f.options, provider: c => ({ test: async () => { tested.push(c.credentials.username!) }, getItems: async () => [] }) })
    const saved = await readFile(f.file, 'utf8')
    await service.test({ ...config, account: 'bob', credentials: { username: 'bob', password: 'unsaved-password' }, mappings: [] })
    await service.test()
    expect(tested).toEqual(['bob', 'alice'])
    expect((await service.status()).config!.account).toBe('alice')
    expect(await readFile(f.file, 'utf8')).toBe(saved)
    expect(f.store.snapshot().tasks).toHaveLength(0)
    service.dispose(); f.service.dispose()
  })
  it('commits tasks and deletion links together without a second configuration-file write', async () => {
    const f = await fixture()
    const saved = await readFile(f.file, 'utf8')
    await rm(f.file); await mkdir(f.file) // Simulate an unavailable credentials-file destination.
    expect((await f.service.sync()).created).toBe(1)
    const snapshot = f.store.snapshot(); const id = (await f.service.status()).config!.id
    const key = externalKey(id, item)
    expect(snapshot.externalSync![id]!.links[key]).toBe(snapshot.tasks[0]!.id)
    const disk = JSON.parse(await readFile(f.ledgerFile, 'utf8'))
    expect(disk.tasks[0].id).toBe(disk.externalSync[id].links[key])
    await rm(f.file, { recursive: true }); await writeFile(f.file, saved)
    await f.store.mutate('task-deleted', ledger => { ledger.tasks = []; return [] })
    const restoredStore = new TaskStore({ file: f.ledgerFile })
    const restored = new ExternalSyncService({ ...f.options, store: restoredStore })
    expect((await restored.sync()).ignored).toBe(1)
    expect(restoredStore.snapshot().tasks).toHaveLength(0)
    const imported = validateLedgerImport(restoredStore.snapshot(), new Set(), 1000)
    expect(imported.externalSync![id]!.ignored).toContain(key)
    expect(JSON.stringify(restoredStore.snapshot())).not.toContain('private-password')
    restored.dispose(); f.service.dispose()
  })
  it('rolls back both task and links when the transaction fails after preparing its draft', async () => {
    const f = await fixture(); const mutate = f.store.mutate.bind(f.store)
    vi.spyOn(f.store, 'mutate').mockImplementationOnce((kind, edit) => mutate(kind, ledger => { edit(ledger); throw new Error('simulated write failure') }))
    await expect(f.service.sync()).rejects.toThrow('External sync failed')
    const id = (await f.service.status()).config!.id
    expect(f.store.snapshot().tasks).toHaveLength(0)
    expect(f.store.snapshot().externalSync![id]!.links).toEqual({})
    expect(f.store.snapshot().externalSync![id]!.lastResult).toBeUndefined()
    expect((await f.service.sync()).created).toBe(1)
    f.service.dispose()
  })
  it('persists the last attempt/error across restart and clears the error after success', async () => {
    const f = await fixture(); f.fail()
    await expect(f.service.sync()).rejects.toThrow('External sync failed')
    const restored = new ExternalSyncService({ ...f.options, store: new TaskStore({ file: f.ledgerFile }),
      provider: () => ({ test: async () => {}, getItems: async () => [item] }) })
    expect(await restored.status()).toMatchObject({ lastAttemptAt: 1000, lastError: expect.stringContaining('External sync failed') })
    expect(JSON.stringify(await restored.status())).not.toContain('private-password')
    await restored.sync()
    expect((await restored.status()).lastError).toBeUndefined()
    expect(JSON.stringify(JSON.parse(await readFile(f.ledgerFile, 'utf8')).externalSync)).not.toContain('lastError')
    restored.dispose(); f.service.dispose()
  })
  it('reports status-persistence failure without hiding the original failure or inventing a successful commit', async () => {
    const f = await fixture(); f.fail()
    vi.spyOn(f.store, 'mutate').mockRejectedValue(new Error('disk unavailable'))
    await expect(f.service.sync()).rejects.toThrow('Sync status could not be saved')
    expect(f.store.snapshot().tasks).toHaveLength(0)
    expect((await f.service.status()).lastError).toContain('External sync failed')
    f.service.dispose()
  })
  it('keeps unchanged cards stable and emits a metadata event, not a task-update event', async () => {
    const f = await fixture(); await f.service.sync()
    const tasks = f.store.snapshot().tasks
    const events: Array<{ kind: string; tasks: readonly unknown[] }> = []
    const dispose = f.store.subscribe(event => events.push(event))
    await f.service.sync()
    expect(f.store.snapshot().tasks).toEqual(tasks)
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ kind: 'external-sync-updated', tasks: [] })
    dispose(); f.service.dispose()
  })
})

describe('terminal cards and conflict resolution', () => {
  it.each(['done', 'canceled', 'archived'] as const)('avoids content churn for %s cards', async status => {
    const f = await fixture(); await f.service.sync()
    await f.store.mutate('task-updated', ledger => { ledger.tasks[0]!.status = status; return [ledger.tasks[0]!] })
    const original = f.store.snapshot().tasks[0]!
    f.set([{ ...item, title: 'Remote title', description: 'Remote description', urgency: 'urgent' }])
    await f.service.sync()
    expect(f.store.snapshot().tasks[0]).toEqual(original)
    f.set([{ ...item, title: 'Remote title', status: 'closed', assignedTo: 'bob', closed: true }])
    await f.service.sync()
    const task = f.store.snapshot().tasks[0]!
    if (status === 'archived') expect(task).toEqual(original)
    else {
      expect(task).toMatchObject({ title: 'Bug', description: 'Original', status, external: { conflicts: [], item: { status: 'closed', assignedTo: 'bob' } } })
      const version = task.version; await f.service.sync(); expect(f.store.snapshot().tasks[0]!.version).toBe(version)
    }
    f.service.dispose()
  })
  it('refuses non-conflicting field resolution without changing the card version', async () => {
    const f = await fixture(); await f.service.sync(); const task = f.store.snapshot().tasks[0]!
    await expect(f.service.resolve(task.id, 'title', true, task.version)).rejects.toThrow('not an unresolved conflict')
    expect(f.store.snapshot().tasks[0]).toEqual(task)
    f.service.dispose()
  })
})

describe('request pressure', () => {
  it('reserves concurrent request slots and cancels pending waits', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000)
    const throttle = new ExternalRequestThrottle(200); const times: number[] = []
    const signal = new AbortController()
    const first = throttle.wait(signal.signal).then(() => times.push(Date.now()))
    const second = throttle.wait(signal.signal).then(() => times.push(Date.now()))
    await vi.advanceTimersByTimeAsync(199); expect(times).toEqual([1000])
    await vi.advanceTimersByTimeAsync(1); await Promise.all([first, second]); expect(times).toEqual([1000, 1200])
    const waiting = throttle.wait(signal.signal); const rejection = expect(waiting).rejects.toThrow('aborted'); signal.abort(); await rejection
  })
  it('skips unrelated new bugs before N+1 reads but retains linked reassigned bugs', async () => {
    const calls: string[] = []
    const mock = (async (input: unknown) => {
      const path = String(input); calls.push(path)
      if (path.endsWith('/tokens')) return new Response(JSON.stringify({ token: 'generated' }))
      if (/\/bugs\?/.test(path)) return new Response(JSON.stringify({ total: 3, bugs: [
        { id: '1', title: 'Linked', status: 'active', assignedTo: 'bob' },
        { id: '2', title: 'Unrelated', status: 'active', assignedTo: 'bob' },
        { id: '3', title: 'Closed', status: 'closed', assignedTo: 'alice' },
      ] }))
      return new Response(JSON.stringify({ id: '1', product: '1', steps: 'Linked details' }))
    }) as typeof fetch
    const provider = new ZentaoProvider(normalizeExternalConfig({ ...config, settings: { requestIntervalMs: '0' } }), mock)
    const items = await provider.getItems('project:1', AbortSignal.timeout(1000), { existing: new Map([[JSON.stringify(['bug', '1']), { item, metadataOnly: false }]]) })
    expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ assignedTo: 'bob', description: 'Linked details' })
    expect(calls.filter(p => /\/bugs\/\d/.test(p))).toHaveLength(1)
  })
})
