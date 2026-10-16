import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExternalProviderRegistry } from '../src/host/external-provider.ts'
import { ExternalSyncService } from '../src/host/external-sync.ts'
import { createBuiltinProviders } from '../src/host/external-providers.ts'
import { TaskStore } from '../src/host/store.ts'
import type { ProviderDescriptor } from '../src/shared/external.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const descriptor: ProviderDescriptor = { id: 'sample', name: 'Sample Tracker', scopeLabel: 'Repository', defaultBaseUrl: 'https://sample.test',
  authModes: [{ id: 'key', label: 'API Key', fields: [{ key: 'apiKey', label: 'API Key' }] }],
  capabilities: { itemTypes: ['ticket'], pagination: 'page', incremental: false, projectDiscovery: true, accountDiscovery: true } }

describe('provider registry and migration', () => {
  it('accepts an unrelated provider without changing sync engine/config/UI contracts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'external-registry-')); directories.push(dir)
    const registry = new ExternalProviderRegistry().register({ descriptor, create: config => ({
      test: async () => { expect(config.credentials.apiKey).toBe('private-key') },
      listProjects: async () => [{ id: 'repo/name', name: 'Repository' }],
      getAccount: async () => ({ account: 'alice' }),
      getItems: async projectId => [{ projectId, type: 'ticket', id: 'external:123', title: 'Ticket', description: 'Details', urgency: 'normal',
        assignedTo: 'other', assignees: ['alice', 'other'], closed: false, status: 'open', priority: 'normal', url: 'https://sample.test/tickets/123' }],
    }) })
    const store = new TaskStore({ file: join(dir, 'tasks.json') })
    const service = new ExternalSyncService({ file: join(dir, 'connection.json'), store, workspaceExists: id => id === 'ws', registry })
    const body = { provider: 'sample', baseUrl: 'https://sample.test', account: 'alice', authMode: 'key', credentials: { apiKey: 'private-key' },
      mappings: [{ projectId: 'repo/name', workspaceId: 'ws' }], itemTypes: ['ticket'] }
    expect(await service.discoverProjects({ ...body, mappings: [] })).toEqual([{ id: 'repo/name', name: 'Repository' }])
    expect((await service.status()).config).toBeUndefined()
    await service.configure(body)
    expect(await service.discoverAccount()).toEqual({ account: 'alice' })
    await service.test()
    expect((await service.sync()).created).toBe(1)
    expect((await service.sync()).unchanged).toBe(1)
    expect(store.snapshot().tasks[0]).toMatchObject({ status: 'backlog', external: { provider: 'sample', providerName: 'Sample Tracker', item: { type: 'ticket', id: 'external:123' } } })
    expect(JSON.stringify(await service.status())).not.toContain('private-key')
    expect((await service.status()).credentialPresent).toEqual({ apiKey: true })
    service.dispose()
  })
  it('rejects duplicate registration and exposes independent descriptors', () => {
    const registry = createBuiltinProviders()
    expect(() => registry.register({ descriptor: { ...descriptor, id: 'tapd' }, create: () => ({ test: async () => {}, getItems: async () => [] }) })).toThrow('duplicate')
    const list = registry.list(); list[0]!.capabilities.itemTypes.push('accidental')
    expect(registry.list()[0]!.capabilities.itemTypes).toEqual(['bug'])
  })
  it('rejects old ZenTao token configurations and requires username/password setup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'external-legacy-')); directories.push(dir)
    const file = join(dir, 'connection.json')
    const legacy = { id: 'original-identity', provider: 'zentao', baseUrl: 'https://zentao.test', account: 'alice', token: 'legacy-secret',
      mappings: [{ projectId: '1', workspaceId: 'ws' }], intervalMinutes: 0, since: '' }
    await writeFile(file, JSON.stringify({ config: legacy, links: {}, ignored: [] }))
    const store = new TaskStore({ file: join(dir, 'tasks.json') })
    const service = new ExternalSyncService({ file, store, workspaceExists: () => true })
    const status = await service.status()
    expect(status.config).toBeUndefined()
    expect(status.lastError).toContain('reconfigure')
    expect(status.credentialPresent).toEqual({})
    expect(JSON.stringify(status)).not.toContain('legacy-secret')
    await expect(service.configure({ ...legacy, authMode: 'token', credentials: { token: 'legacy-secret' } })).rejects.toThrow('unsupported authentication')
    await expect(service.configure(legacy)).rejects.toThrow('enter credentials')
    await service.configure({ ...legacy, credentials: { username: 'alice', password: 'new-private-password' } })
    const saved = JSON.parse(await readFile(file, 'utf8'))
    expect(saved.config).not.toHaveProperty('token')
    expect(saved.config.credentials).toEqual({ username: 'alice', password: 'new-private-password' })
    expect(saved.config.authMode).toBe('password')
    expect(saved.config.id).not.toBe(legacy.id)
    await expect(service.discoverAccount()).rejects.toThrow('explicit assignee')
    service.dispose()
  })
})
