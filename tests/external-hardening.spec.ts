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
const item: ExternalItem = { projectId: '1', id: '1', type: 'bug', title: 'Bug', description: 'Original', urgency: 'normal',
  priority: '2', status: 'active', assignedTo: 'alice', closed: false, url: 'https://zentao.test/bug/1' }
const config = { provider: 'zentao', baseUrl: 'https://zentao.test', account: 'alice', authMode: 'password',
  credentials: { username: 'alice', password: 'private-password' }, mappings: [{ projectId: '1', workspaceId: 'ws' }] }
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
    const items = await provider.getItems('1', AbortSignal.timeout(1000), { existing: new Map([[JSON.stringify(['bug', '1']), { item, metadataOnly: false }]]) })
    expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ assignedTo: 'bob', description: 'Linked details' })
    expect(calls.filter(p => /\/bugs\/\d/.test(p))).toHaveLength(1)
  })
})
