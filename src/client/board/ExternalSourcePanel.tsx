import { useState } from 'react'
import type { TaskRecord } from '../../shared/protocol.ts'
import { normalizeExternalSource } from '../../shared/external.ts'
import { useT } from '../i18n/runtime.ts'
import { externalRequest, externalTypeLabel } from '../external-api.ts'

export function ExternalSourcePanel({ task }: { task: TaskRecord }) {
  const t = useT()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const source = normalizeExternalSource(task.external)
  if (!source) return null
  const resolve = async (field: string, acceptExternal: boolean) => {
    setBusy(true); setError('')
    try { await externalRequest('/resolve', { taskId: task.id, field, acceptExternal, ifVersion: task.version }) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <section className="dsh-atb-diag-sec">
    <h4>{t('ext.source')}</h4>
    <a href={source.item.url} target="_blank" rel="noopener noreferrer">{source.providerName ?? source.provider} · {externalTypeLabel(source.item.type, t)} #{source.item.id}</a>
    <p>{t('ext.status')}: {source.item.status} · {source.item.assignedTo}</p>
    <p>{t('ext.synced')}: {new Date(source.syncedAt).toLocaleString()}</p>
    {source.conflicts.map(field => <div key={field}>
      <p>{t('ext.conflict', { field: t(`ext.field.${field}`) })}</p>
      <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>{source.item[field]}</pre>
      <button type="button" disabled={busy || task.status === 'in_progress'} onClick={() => void resolve(field, true)}>{t('ext.accept')}</button>
      <button type="button" disabled={busy || task.status === 'in_progress'} onClick={() => void resolve(field, false)}>{t('ext.keep')}</button>
    </div>)}
    {error && <p role="alert">{error}</p>}
  </section>
}
