import type { ExternalConfig } from '../shared/external.ts'
import { newTaskId } from '../shared/protocol.ts'
import type { ExternalProviderRegistry } from './external-provider.ts'

/** Platform-neutral validation; each registered provider validates its own scope/options. */
export function normalizeConnection(raw: unknown, registry: ExternalProviderRegistry, previous?: ExternalConfig, allowEmptyMappings = false, allowLegacyMappings = false): ExternalConfig {
  if (!raw || typeof raw !== 'object') throw new Error('invalid external connection')
  const e = raw as Record<string, unknown>
  const provider = typeof e.provider === 'string' ? e.provider : previous?.provider ?? 'zentao'
  const definition = registry.get(provider)
  const descriptor = definition.descriptor
  const mappingMode = provider === 'zentao' ? e.mappingMode : undefined
  if (provider === 'zentao' && e.includeUnmapped !== undefined && typeof e.includeUnmapped !== 'boolean') throw new Error('invalid unmapped sync setting')
  const includeUnmapped = provider === 'zentao' && e.includeUnmapped === true
  const authMode = typeof e.authMode === 'string' ? e.authMode : descriptor.authModes[0]!.id
  const mode = descriptor.authModes.find(m => m.id === authMode)
  if (!mode) throw new Error('unsupported authentication mode')
  const baseUrl = new URL(String(e.baseUrl ?? descriptor.defaultBaseUrl))
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error('invalid server URL')
  const url = baseUrl.href.replace(/\/$/, '')
  const account = typeof e.account === 'string' ? e.account.trim() : ''
  if (!account) throw new Error('sync account is required')
  const sameSource = previous?.provider === provider && previous.baseUrl === url && previous.account === account
  const sameIdentity = sameSource && previous.authMode === authMode
  const incoming = e.credentials && typeof e.credentials === 'object' && !Array.isArray(e.credentials) ? e.credentials as Record<string, unknown> : {}
  const credentials: Record<string, string> = {}
  for (const field of mode.fields) {
    const value = incoming[field.key]
    if (value !== undefined && typeof value !== 'string') throw new Error('invalid credential value')
    const credential = typeof value === 'string' && value.length ? value : sameIdentity ? previous!.credentials[field.key] : ''
    if (!credential) throw new Error('enter credentials for this server/account/authentication mode')
    credentials[field.key] = credential
  }
  if (provider === 'zentao' && mappingMode !== 'project' && mappingMode !== 'execution'
    && !(allowLegacyMappings && mappingMode === undefined)) throw new Error('select a project or execution mapping mode')
  if (!Array.isArray(e.mappings)) throw new Error('at least one project mapping is required')
  const mappings = e.mappings.filter((r: unknown) => provider !== 'zentao' || includeUnmapped || !r || typeof r !== 'object' || (r as Record<string, unknown>).workspaceId !== '').map((r: unknown) => {
    if (!r || typeof r !== 'object') throw new Error('invalid mapping')
    const m = r as Record<string, unknown>
    if (typeof m.projectId !== 'string' || !m.projectId.trim() || typeof m.workspaceId !== 'string' || (!m.workspaceId && !includeUnmapped)) throw new Error('invalid mapping')
    return { projectId: m.projectId.trim(), workspaceId: m.workspaceId }
  })
  if (!allowEmptyMappings && provider !== 'zentao' && !mappings.length) throw new Error('at least one project mapping is required')
  if (new Set(mappings.map(m => m.projectId)).size !== mappings.length) throw new Error('duplicate project mapping')
  const intervalMinutes = Number(e.intervalMinutes ?? 0)
  const importStatus = e.importStatus ?? 'backlog'
  if (importStatus !== 'backlog' && importStatus !== 'todo') throw new Error('import status must be backlog or todo')
  if (!Number.isInteger(intervalMinutes) || (intervalMinutes !== 0 && (intervalMinutes < 5 || intervalMinutes > 1440))) throw new Error('sync interval must be 0 or 5–1440 minutes')
  const since = String(e.since ?? '')
  if (since && (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !Number.isFinite(Date.parse(since)) || new Date(since).toISOString().slice(0, 10) !== since)) throw new Error('invalid start date')
  const itemTypes: string[] = e.itemTypes === undefined ? [descriptor.capabilities.itemTypes[0]!] : Array.isArray(e.itemTypes) ? e.itemTypes : []
  if (!itemTypes.length || itemTypes.some(type => !descriptor.capabilities.itemTypes.includes(type))) throw new Error('unsupported or empty work item types')
  const rawSettings = e.settings && typeof e.settings === 'object' ? e.settings as Record<string, unknown> : {}
  const settings: Record<string, string> = {}
  for (const field of descriptor.settingsFields ?? []) {
    const value = rawSettings[field.key] ?? field.defaultValue
    if (typeof value !== 'string') throw new Error('invalid provider setting')
    settings[field.key] = value.trim()
  }
  const config: ExternalConfig = { id: sameSource ? previous!.id : newTaskId(), provider, baseUrl: url, account, authMode,
    credentials, itemTypes: [...new Set(itemTypes)], settings, mappings, intervalMinutes, since, importStatus,
    ...(mappingMode === 'project' || mappingMode === 'execution' ? { mappingMode, includeUnmapped } : {}) }
  definition.validate?.(config)
  return config
}
