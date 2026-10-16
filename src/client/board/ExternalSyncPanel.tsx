import { useEffect, useState } from 'react'
import { useT } from '../i18n/runtime.ts'
import type { ExternalProject, ExternalSyncStatus, ProviderDescriptor } from '../../shared/external.ts'
import type { WorkspaceView } from '../../shared/api.ts'
import { externalRequest, externalTypeLabel } from '../external-api.ts'

type Status = ExternalSyncStatus
function ScopePicker({ value, projects, loaded, onChange, t }: { value: string; projects: ExternalProject[]; loaded: boolean; onChange: (value: string) => void; t: (key: string) => string }) {
  const [manual, setManual] = useState(false)
  return <>
    <select title={projects.find(p => p.id === value)?.name} value={manual ? '__manual__' : value} onChange={e => {
      if (e.target.value === '__manual__') setManual(true)
      else { setManual(false); onChange(e.target.value) }
    }}>
      <option value="">{projects.length ? t('ext.chooseScope') : t(loaded ? 'ext.noScopes' : 'ext.syncListFirst')}</option>
      {value && !projects.some(p => p.id === value) && <option value={value}>ID: {value}</option>}
      {projects.map(p => <option key={p.id} value={p.id}>ID: {p.id} · {p.name}</option>)}
      <option value="__manual__">{t('ext.enterScopeId')}</option>
    </select>
    {(manual || !projects.length) && <input aria-label={t('ext.enterScopeId')} value={value} onChange={e => onChange(e.target.value)} />}
  </>
}
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
  const [projectsLoaded, setProjectsLoaded] = useState(false)
  const [since, setSince] = useState('')
  const [interval, setIntervalMinutes] = useState('0')
  const [mappingMode, setMappingMode] = useState<'project' | 'execution'>('project')
  const [includeUnmapped, setIncludeUnmapped] = useState(false)
  const [importStatus, setImportStatus] = useState<'backlog' | 'todo'>('backlog')
  const [mappings, setMappings] = useState<Array<{ projectId: string; workspaceId: string }>>([{ projectId: '', workspaceId: '' }])
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [action, setAction] = useState('')
  const [savedDraft, setSavedDraft] = useState<string>()
  const descriptor = status?.providers?.find(p => p.id === providerId)
  const authentication = descriptor?.authModes.find(m => m.id === authMode)
  const effectiveAccount = providerId === 'zentao' && reuseLogin ? (credentials.username ?? '').trim() : account
  const canKeepCredentials = status?.config?.provider === providerId && status.config.authMode === authMode
    && status.config.account === effectiveAccount && status.config.baseUrl === baseUrl.replace(/\/$/, '')
  const draft = () => ({ provider: providerId, baseUrl, account: effectiveAccount, authMode, credentials, settings, itemTypes, since, intervalMinutes: Number(interval), importStatus, ...(providerId === 'zentao' ? { mappingMode, includeUnmapped, mappings: mappings.filter(m => includeUnmapped || m.workspaceId) } : { mappings }) })
  const fingerprint = (values = draft()) => JSON.stringify({ ...values,
    itemTypes: [...values.itemTypes].sort(),
    mappings: values.mappings.filter(m => m.projectId && m.workspaceId).slice().sort((a, b) => a.projectId.localeCompare(b.projectId)),
  })
  const currentDraft = fingerprint()
  const dirty = savedDraft !== undefined && currentDraft !== savedDraft
  useEffect(() => {
    if (status && savedDraft === undefined) setSavedDraft(currentDraft)
  }, [status, savedDraft, currentDraft])
  const selectProvider = (p: ProviderDescriptor) => {
    setProviderId(p.id); setBaseUrl(p.defaultBaseUrl); setAuthMode(p.authModes[0]!.id)
    setReuseLogin(true); setMappingMode('project'); setIncludeUnmapped(false)
    setCredentials({}); setSettings(Object.fromEntries((p.settingsFields ?? []).map(f => [f.key, f.defaultValue])))
    setItemTypes([p.capabilities.itemTypes[0]!]); setProjects([]); setProjectsLoaded(false); setMappings(p.id === 'zentao' ? [] : [{ projectId: '', workspaceId: '' }])
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
        setMappingMode(c.mappingMode ?? 'project')
        setIncludeUnmapped(c.includeUnmapped ?? false)
        setImportStatus(c.importStatus ?? 'backlog')
        setReuseLogin(c.provider !== 'zentao' || c.account === (s.credentialValues?.username ?? '').trim())
        setBaseUrl(c.baseUrl); setAccount(c.account); setSince(c.since); setIntervalMinutes(String(c.intervalMinutes)); setMappings(c.provider === 'zentao' && !c.mappingMode ? [] : c.mappings)
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
      if (path === '/projects') {
        const scopes = result as ExternalProject[]
        setProjects(scopes); setProjectsLoaded(true)
        if (providerId === 'zentao') setMappings(current => [
          ...scopes.map(p => ({ projectId: p.id, workspaceId: current.find(m => m.projectId === p.id)?.workspaceId ?? '' })),
          ...current.filter(m => m.workspaceId && !scopes.some(p => p.id === m.projectId)),
        ])
      }
      if (path === '/account' && result && typeof result === 'object' && 'account' in result) setAccount(String(result.account))
      const next = await externalRequest<Status>('')
      if (path === '/config') {
        const savedCredentials = next.credentialValues ?? {}
        setCredentials(savedCredentials)
        setSavedDraft(fingerprint({ ...draft(), credentials: savedCredentials }))
      }
      setStatus(next); setMessage(path === '/projects' ? t(providerId === 'zentao' ? (includeUnmapped ? 'ext.unmappedMappingsFound' : 'ext.mappingsFound') : 'ext.projectsFound', { count: (result as ExternalProject[]).length }) : t('ext.success'))
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
      <div className="dsh-atb-external-options" role="group" aria-label={t(providerId === 'zentao' ? 'ext.syncScope' : 'ext.itemTypes')}>
        {providerId === 'zentao' && <span>{t('ext.syncScope')}</span>}
        {descriptor?.capabilities.itemTypes.map(type => <label key={type} style={{ flexDirection: 'row', alignItems: 'center' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={itemTypes.includes(type)} disabled={providerId === 'zentao' && itemTypes.length === 1 && itemTypes.includes(type)} onChange={e => setItemTypes(e.target.checked ? [...itemTypes, type] : itemTypes.filter(v => v !== type))} />{externalTypeLabel(type, t)}
        </label>)}
      </div>
      {descriptor?.settingsFields?.map(field => <label key={field.key}>{t(field.label)}<input value={settings[field.key] ?? field.defaultValue} onChange={e => setSettings({ ...settings, [field.key]: e.target.value })} /></label>)}
      <label>{t('ext.since')}<input type="date" value={since} onChange={e => setSince(e.target.value)} /></label>
      <label>{t('ext.interval')}<input type="number" min="0" max="1440" value={interval} onChange={e => setIntervalMinutes(e.target.value)} /></label>
      <label>{t('ext.importStatus')}<select value={importStatus} onChange={e => setImportStatus(e.target.value as 'backlog' | 'todo')}>
        <option value="backlog">{t('ext.importBacklog')}</option><option value="todo">{t('ext.importTodo')}</option>
      </select></label>
      {providerId === 'zentao' && <div className="dsh-atb-external-options" role="radiogroup" aria-label={t('ext.mappingMode')}>
        <span>{t('ext.mappingMode')}</span>
          {(['project', 'execution'] as const).map(mode => <label key={mode} style={{ flexDirection: 'row', alignItems: 'center' }}>
            <input type="radio" name="dsh-atb-mapping-mode" value={mode} checked={mappingMode === mode} style={{ width: 'auto' }}
              onChange={() => { setMappingMode(mode); setProjects([]); setProjectsLoaded(false); setMappings([]) }} />{t(mode === 'project' ? 'ext.linkProject' : 'ext.linkExecution')}
          </label>)}
      </div>}
      {providerId === 'zentao' && <>
        <label style={{ flexDirection: 'row', alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto' }} checked={includeUnmapped}
          onChange={e => setIncludeUnmapped(e.target.checked)} />{t(mappingMode === 'project' ? 'ext.syncUnmappedProjects' : 'ext.syncUnmappedExecutions')}</label>
      </>}
      {providerId === 'zentao' && status?.requiresMappingReview && <p role="alert">{t('ext.remapRequired')}</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '9px 0' }}>
        <button type="button" onClick={() => void act('/test', { ...draft(), mappings: providerId === 'zentao' ? mappings.filter(m => m.workspaceId) : mappings.filter(m => m.projectId || m.workspaceId) })}>{t('ext.test')}</button>
        {descriptor?.capabilities.projectDiscovery && <button type="button" onClick={() => void act('/projects', { ...draft(), mappings: [] })}>{t(providerId === 'zentao' ? 'ext.discoverMappings' : 'ext.discoverProjects')}</button>}
      </div>
      {providerId === 'zentao' && !mappings.length && <p>{t(projectsLoaded ? 'ext.noScopes' : 'ext.loadMappings')}</p>}
      {mappings.map((m, index) => <div key={providerId === 'zentao' ? m.projectId : index} className="dsh-atb-external-mapping">
        {providerId === 'zentao' ? <div className="dsh-atb-external-scope-info">
          <b>{projects.find(p => p.id === m.projectId)?.name ?? `ID: ${m.projectId.split(':')[1]}`}</b>
          <span>{t(mappingMode === 'project' ? 'ext.projectId' : 'ext.executionId')}: {m.projectId.split(':')[1]}</span>
          {projectsLoaded && !projects.some(p => p.id === m.projectId) && <span role="alert">{t('ext.scopeUnavailable')}</span>}
        </div> : <>
        <label>{t(descriptor?.scopeLabel ?? 'ext.projectId')}
          <ScopePicker t={t} loaded={projectsLoaded} value={m.projectId} projects={projects}
            onChange={value => setMappings(mappings.map((v, i) => i === index ? { ...v, projectId: value } : v))} />
        </label></>}
        <label>{t('ext.workspace')}<select value={m.workspaceId} onChange={e => setMappings(mappings.map((v, i) => i === index ? { ...v, workspaceId: e.target.value } : v))}>
          <option value="">{providerId === 'zentao' ? t('ext.unlinked') : '—'}</option>{workspaces.map(ws => <option key={ws.id} value={ws.id}>{ws.title}</option>)}
        </select></label>
        {providerId !== 'zentao' && <button type="button" className="dsh-atb-external-remove" aria-label={t('ext.removeMapping', { n: index + 1 })} title={t('ext.removeMapping', { n: index + 1 })}
          disabled={mappings.length === 1} onClick={() => setMappings(mappings.filter((_, i) => i !== index))}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" /></svg>
        </button>}
      </div>)}
      {dirty && <p role="status">{t('ext.unsavedChanges')}</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {providerId !== 'zentao' && <button type="button" onClick={() => setMappings([...mappings, { projectId: '', workspaceId: '' }])}>{t('ext.addMapping')}</button>}
        {descriptor?.capabilities.accountDiscovery && <button type="button" disabled={!status?.config} onClick={() => void act('/account')}>{t('ext.discoverAccount')}</button>}
        <button type="button" disabled={providerId === 'zentao' && projectsLoaded && mappings.some(m => m.workspaceId && !projects.some(p => p.id === m.projectId))} onClick={() => void act('/config', draft())}>{t('ext.save')}</button>
        <button type="button" disabled={!status?.config || status.requiresMappingReview || dirty} title={dirty ? t('ext.unsavedChanges') : undefined} onClick={() => void act('/sync')}>{t('ext.sync')}</button>
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
