import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ZentaoProvider } from '../src/host/zentao.ts'
import { ExternalSyncService, normalizeExternalConfig } from '../src/host/external-sync.ts'
import { TaskStore } from '../src/host/store.ts'

const body = { provider: 'zentao', mappingMode: 'project', baseUrl: 'https://zentao.test', account: 'alice', authMode: 'password', credentials: { username: 'alice-login', password: 'private-password' }, mappings: [{ projectId: 'project:1', workspaceId: 'ws' }] }
describe('ZenTao saved username/password', () => {
  it('logs in once per operation, reuses the token and renews it once after authentication failure', async () => {
    let logins = 0; let reads = 0
    const mock = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      expect(url).not.toContain('private-password')
      if (url.endsWith('/tokens')) {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({ account: 'alice-login', password: 'private-password' })
        return new Response(JSON.stringify({ token: `generated-token-${++logins}` }))
      }
      reads++
      const token = new Headers(init?.headers).get('Token')
      expect(token).toBe(`generated-token-${logins}`)
      if (reads === 1) return new Response('expired', { status: 401 })
      return new Response(JSON.stringify({ total: 0, bugs: [] }))
    }) as typeof fetch
    const provider = new ZentaoProvider(normalizeExternalConfig(body), mock)
    await provider.test(AbortSignal.timeout(1000))
    await provider.getItems('project:1', AbortSignal.timeout(1000))
    expect(logins).toBe(2); expect(reads).toBe(3)
  })
  it('does not expose login response bodies or retry incorrect credentials indefinitely', async () => {
    let calls = 0
    const mock = (async () => { calls++; return new Response(JSON.stringify({ error: 'private-password' })) }) as typeof fetch
    const provider = new ZentaoProvider(normalizeExternalConfig(body), mock)
    await expect(provider.test(AbortSignal.timeout(1000))).rejects.toThrow('ZenTao login failed')
    expect(calls).toBe(1)
  })
  it('stores the password host-side, returns the saved username only, and preserves source identity when rotating passwords', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zentao-password-'))
    const file = join(dir, 'connection.json')
    const options = { file, store: new TaskStore({ file: join(dir, 'tasks.json') }), workspaceExists: () => true }
    const service = new ExternalSyncService(options)
    try {
      await service.configure(body)
      const original = await service.status()
      await service.configure({ ...body, credentials: { username: 'alice-login', password: 'rotated-private-password' } })
      const status = await service.status()
      expect(status.config!.id).toBe(original.config!.id)
      expect(status.credentialValues).toEqual({ username: 'alice-login' })
      expect(status.credentialPresent).toEqual({ username: true, password: true })
      expect(JSON.stringify(status)).not.toContain('private-password')
      expect(JSON.stringify(status)).not.toContain('legacy-private-token')
      await service.configure({ ...body, credentials: { username: 'alice-login', password: '' } })
      const restored = new ExternalSyncService(options)
      expect((await restored.status()).credentialPresent.password).toBe(true)
      restored.dispose()
    } finally { service.dispose(); await rm(dir, { recursive: true, force: true }) }
  })
})
