import { useEffect, useState } from 'react'
import { useT } from '../i18n/runtime.ts'
import type { ExternalProject, ExternalSyncStatus, ProviderDescriptor } from '../../shared/external.ts'
import type { WorkspaceView } from '../../shared/api.ts'
import { externalRequest, externalTypeLabel } from '../external-api.ts'

type Status = ExternalSyncStatus
export function ExternalSyncPanel() {
  const t = useT()
  const [status, setStatus] = useState<Status>()
  const [baseUrl, setBaseUrl] = useState('')
  const [account, setAccount] = useState('')
  const [reuseLogin, setReuseLogin] = useState(true)
  const [providerId, setProviderId] = useState('')
  const [authMode, setAuthMode] = useState('')
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [itemTypes, setItemTypes] = useState<string[]>([])
  const [projects, setProjects] = useState<ExternalProject[]>([])
  const [since, setSince] = useState('')
  const [interval, setIntervalMinutes] = useState('0')
  const [importStatus, setImportStatus] = useState<'backlog' | 'todo'>('backlog')
  const [mappings, setMappings] = useState<Array<{ projectId: string; workspaceId: string }>>([{ projectId: '', workspaceId: '' }])
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [action, setAction] = useState('')
  const descriptor = status?.providers?.find(p => p.id === providerId)
  const authentication = descriptor?.authModes.find(m => m.id === authMode)
  const effectiveAccount = providerId === 'zentao' && reuseLogin ? (credentials.username ?? '').trim() : account
  const canKeepCredentials = status?.config?.provider === providerId && status.config.authMode === authMode
    && status.config.account === effectiveAccount && status.config.baseUrl === baseUrl.replace(/\/$/, '')
  const draft = () => ({ provider: providerId, baseUrl, account: effectiveAccount, authMode, credentials, settings, itemTypes, since, intervalMinutes: Number(interval), importStatus, mappings })
  const selectProvider = (p: ProviderDescriptor) => {
    setProviderId(p.id); setBaseUrl(p.defaultBaseUrl); setAuthMode(p.authModes[0]!.id)
    setReuseLogin(true)
    setCredentials({}); setSettings(Object.fromEntries((p.settingsFields ?? []).map(f => [f.key, f.defaultValue])))
    setItemTypes([p.capabilities.itemTypes[0]!]); setProjects([]); setMappings([{ projectId: '', workspaceId: '' }])
  }
  useEffect(() => {
    let active = true
    void Promise.all([externalRequest<Status>(''), fetch('/dsh-taskboard/workspaces').then(r => r.json())]).then(([s, ws]) => {
      if (!active) return
      setStatus(s); setWorkspaces(ws.value ?? [])
      const c = s.config
      if (c) {
        setProviderId(c.provider); setAuthMode(c.authMode); setItemTypes(c.itemTypes); setSettings(c.settings)
        setCredentials(s.credentialValues ?? {})
        setImportStatus(c.importStatus ?? 'backlog')
        setReuseLogin(c.provider !== 'zentao' || c.account === (s.credentialValues?.username ?? '').trim())
        setBaseUrl(c.baseUrl); setAccount(c.account); setSince(c.since); setIntervalMinutes(String(c.intervalMinutes)); setMappings(c.mappings)
      } else if (s.providers?.[0]) selectProvider(s.providers[0])
    }).catch(e => { if (active) setMessage(String(e.message)) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    let active = true
    const timer = setInterval(() => {
      void externalRequest<Status>('').then(s => { if (active) setStatus(s) }).catch(() => {})
    }, 3000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  const act = async (path: string, body: unknown = {}) => {
    setBusy(true); setAction(path); setMessage('')
    try {
      const result = await externalRequest<unknown>(path, body)
      if (path === '/projects') setProjects(result as ExternalProject[])
      if (path === '/account' && result && typeof result === 'object' && 'account' in result) setAccount(String(result.account))
      const next = await externalRequest<Status>('')
      if (path === '/config') setCredentials(next.credentialValues ?? {})
      setStatus(next); setMessage(path === '/projects' ? t('ext.projectsFound', { count: (result as ExternalProject[]).length }) : t('ext.success'))
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false); setAction('') }
  }
  return <section className="dsh-atb-diag-sec dsh-atb-external">
    <h4>{t('ext.heading')}</h4><p>{t('ext.hint')}</p>
    <fieldset disabled={busy || status?.running} style={{ border: 0, padding: 0 }}>
      <label>{t('ext.provider')}<select value={providerId} onChange={e => { const p = status?.providers.find(p => p.id === e.target.value); if (p) selectProvider(p) }}>
        {(status?.providers ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>
      <label>{t('ext.url')}<input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} /></label>
      {providerId !== 'zentao' && <>
        <label>{t('ext.account')}<input value={account} onChange={e => setAccount(e.target.value)} /></label>
        {!descriptor?.capabilities.accountDiscovery && <p>{t('ext.manualAccount')}</p>}
      </>}
      <label>{t('ext.authMode')}<select value={authMode} onChange={e => { setAuthMode(e.target.value); setCredentials({}) }}>
        {descriptor?.authModes.map(m => <option key={m.id} value={m.id}>{t(m.label)}</option>)}
      </select></label>
      {authentication?.fields.map(field => <label key={field.key}>{t(field.label)}<input type={field.secret === false ? 'text' : 'password'} autoComplete={field.secret === false ? 'username' : 'new-password'} value={credentials[field.key] ?? ''}
        placeholder={canKeepCredentials && status?.credentialPresent[field.key] ? t('ext.tokenSaved') : ''}
        onChange={e => setCredentials({ ...credentials, [field.key]: e.target.value })} /></label>)}
      {providerId === 'zentao' && <>
        <label style={{ flexDirection: 'row', alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto' }} checked={reuseLogin}
          onChange={e => { setReuseLogin(e.target.checked); if (!e.target.checked && !account) setAccount(credentials.username ?? '') }} />{t('ext.reuseLogin')}</label>
        {!reuseLogin && <label>{t('ext.assigneeAccount')}<input value={account} onChange={e => setAccount(e.target.value)} /></label>}
      </>}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }} aria-label={t('ext.itemTypes')}>
        {descriptor?.capabilities.itemTypes.map(type => <label key={type} style={{ flexDirection: 'row', alignItems: 'center' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={itemTypes.includes(type)} onChange={e => setItemTypes(e.target.checked ? [...itemTypes, type] : itemTypes.filter(v => v !== type))} />{externalTypeLabel(type, t)}
        </label>)}
      </div>
      {descriptor?.settingsFields?.map(field => <label key={field.key}>{t(field.label)}<input value={settings[field.key] ?? field.defaultValue} onChange={e => setSettings({ ...settings, [field.key]: e.target.value })} /></label>)}
      <label>{t('ext.since')}<input type="date" value={since} onChange={e => setSince(e.target.value)} /></label>
      <label>{t('ext.interval')}<input type="number" min="0" max="1440" value={interval} onChange={e => setIntervalMinutes(e.target.value)} /></label>
      <label>{t('ext.importStatus')}<select value={importStatus} onChange={e => setImportStatus(e.target.value as 'backlog' | 'todo')}>
        <option value="backlog">{t('ext.importBacklog')}</option><option value="todo">{t('ext.importTodo')}</option>
      </select></label>
      <p>{t('ext.importStatusHint')}</p>
      {mappings.map((m, index) => <div key={index} className="dsh-atb-external-mapping">
        {providerId === 'zentao' && <label className="dsh-atb-external-scope">{t('ext.scopeType')}<select value={m.projectId.startsWith('execution:') ? 'execution' : 'product'}
          onChange={e => setMappings(mappings.map((v, i) => i === index ? { ...v, projectId: (e.target.value === 'execution' ? 'execution:' : '') + v.projectId.replace(/^execution:/, '') } : v))}>
          <option value="product">{t('ext.productScope')}</option><option value="execution">{t('ext.executionScope')}</option>
        </select></label>}
        <label>{t(providerId === 'zentao' && m.projectId.startsWith('execution:') ? 'ext.executionId' : descriptor?.scopeLabel ?? 'ext.projectId')}<input list={`dsh-atb-external-projects-${index}`} value={providerId === 'zentao' ? m.projectId.replace(/^execution:/, '') : m.projectId}
          onChange={e => setMappings(mappings.map((v, i) => i === index ? { ...v, projectId: (providerId === 'zentao' && v.projectId.startsWith('execution:') ? 'execution:' : '') + e.target.value } : v))} /></label>
        <datalist id={`dsh-atb-external-projects-${index}`}>{projects.filter(p => providerId !== 'zentao' || p.id.startsWith('execution:') === m.projectId.startsWith('execution:')).map(p => <option key={p.id} value={providerId === 'zentao' ? p.id.replace(/^execution:/, '') : p.id}>{p.name}</option>)}</datalist>
        <label>{t('ext.workspace')}<select value={m.workspaceId} onChange={e => setMappings(mappings.map((v, i) => i === index ? { ...v, workspaceId: e.target.value } : v))}>
          <option value="">—</option>{workspaces.map(ws => <option key={ws.id} value={ws.id}>{ws.title}</option>)}
        </select></label>
        <button type="button" className="dsh-atb-external-remove" aria-label={t('ext.removeMapping', { n: index + 1 })} title={t('ext.removeMapping', { n: index + 1 })}
          disabled={mappings.length === 1} onClick={() => setMappings(mappings.filter((_, i) => i !== index))}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" /></svg>
        </button>
      </div>)}
      {providerId === 'zentao' && <p>{t('ext.scopeHint')}</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => setMappings([...mappings, { projectId: '', workspaceId: '' }])}>{t('ext.addMapping')}</button>
        {descriptor?.capabilities.projectDiscovery && <button type="button" onClick={() => void act('/projects', { ...draft(), mappings: [] })}>{t('ext.discoverProjects')}</button>}
        {descriptor?.capabilities.accountDiscovery && <button type="button" disabled={!status?.config} onClick={() => void act('/account')}>{t('ext.discoverAccount')}</button>}
        <button type="button" onClick={() => void act('/config', draft())}>{t('ext.save')}</button>
        <button type="button" disabled={!status?.config} onClick={() => void act('/test')}>{t('ext.test')}</button>
        <button type="button" disabled={!status?.config} onClick={() => void act('/sync')}>{t('ext.sync')}</button>
        <button type="button" disabled={!status?.ignoredCount} onClick={() => void act('/ignored/clear')}>{t('ext.clearIgnored')}</button>
      </div>
    </fieldset>
    {(action === '/sync' || status?.running) && <button type="button" onClick={() => { void externalRequest('/cancel', {}).catch(() => {}) }}>{t('ext.cancel')}</button>}
    {busy && <p role="status">{t('ext.busy')}</p>}
    {message && <p role="status">{message}</p>}
    {status?.lastError && <p role="alert">{status.lastError}</p>}
    {status?.lastAttemptAt !== undefined && <p>{t('ext.lastAttempt')}: {new Date(status.lastAttemptAt).toLocaleString()}</p>}
    {status?.lastResult && <p>{t('ext.result', status.lastResult)} · {new Date(status.lastResult.at).toLocaleString()}</p>}
  </section>
}
