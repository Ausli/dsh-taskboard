/**
 * The template-manager modal (0.4.0): rename / categorize / delete / use the
 * stored task templates. Templates live host-side (side file next to the
 * ledger) and prefill the create form from the + 新建任务 ▼ dropdown. Rows
 * group by category (0.8.8); built-in rows show a read-only category while
 * custom rows edit theirs inline with an unfiltered suggestion dropdown.
 *
 * @module dsh-taskboard/client/board/TemplateManager
 */
import { useRef, useState } from 'react'
import type { BoardController } from '../controller.ts'
import type { TaskTemplate } from '../../shared/api.ts'
import type { Urgency } from '../../shared/protocol.ts'
import { useAlert } from './AlertModal.tsx'
import { URGENCY_KEYS } from './labels.ts'
import { useT } from '../i18n/runtime.ts'
import { localizeBuiltinCategory, localizeBuiltinName, localizeBuiltinTask } from '../i18n/templates.ts'
import { categoryLabel, groupTemplatesByCategory, templateCategoryOf, templateCategoryOptions } from '../template-categories.ts'

/** Space (px) the dropdown needs below the input before flipping upward. */
const CATEGORY_POP_MIN_SPACE = 150

/**
 * Free-text category input with a suggestion dropdown that always lists every
 * existing category — typing never filters the list; picking an option fills
 * the input verbatim (the native datalist's as-you-type filtering is exactly
 * what this replaces). The dropdown flips above the input when the modal body
 * leaves no room below (last row).
 */
function CategorySuggest({ value, options, placeholder, ariaLabel, onPick, onEnter, onChange }: {
  value: string
  options: readonly string[]
  placeholder: string
  ariaLabel: string
  onPick: (option: string) => void
  onEnter: () => void
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [up, setUp] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  /** Open the list, flipping it above the input when the modal body has no room below. */
  const openList = (): void => {
    const wrap = wrapRef.current
    if (wrap !== null) {
      const bodyRect = wrap.closest('.dsh-atb-modal-body')?.getBoundingClientRect()
      const wrapRect = wrap.getBoundingClientRect()
      const below = (bodyRect?.bottom ?? window.innerHeight) - wrapRect.bottom
      const above = wrapRect.top - (bodyRect?.top ?? 0)
      setUp(below < CATEGORY_POP_MIN_SPACE && above > below)
    }
    setOpen(true)
  }

  return (
    <div ref={wrapRef} className="dsh-atb-tplm-catwrap">
      <input
        className="dsh-atb-tplm-category"
        value={value}
        maxLength={30}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onFocus={openList}
        onBlur={() => setOpen(false)}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') onEnter()
          if (e.key === 'Escape') setOpen(false)
        }}
      />
      {open && options.length > 0 && (
        <div className={up ? 'dsh-atb-tplm-catpop dsh-atb-tplm-catpop-up' : 'dsh-atb-tplm-catpop'}>
          {options.map(option => (
            <button
              key={option}
              type="button"
              className="dsh-atb-tplm-catopt"
              // Pick before a mousedown-driven blur can close the list.
              onMouseDown={e => { e.preventDefault(); onPick(option) }}
              onClick={() => setOpen(false)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The template manager modal.
 * @param controller - the controller.
 */
export function TemplateManager({ controller }: { controller: BoardController }) {
  const t = useT()
  const state = controller.getSnapshot()
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [categoryEdits, setCategoryEdits] = useState<Record<string, string>>({})
  const [confirmId, setConfirmId] = useState<string | undefined>(undefined)
  const { alert: showAlert, el: alertEl } = useAlert()

  const close = (): void => controller.closeTemplateManager()

  /** The name a row currently shows: an in-flight rename edit, else the localized name. */
  const nameOf = (tpl: TaskTemplate): string => edits[tpl.id] ?? localizeBuiltinName(tpl)

  /** Localized urgency label for the meta line ('' when the template pins none). */
  const urgencyLabel = (urgency: string | undefined): string => {
    if (urgency === undefined) return ''
    const key = URGENCY_KEYS[urgency as Urgency]
    return key !== undefined ? ` · ${t(key)}` : ` · ${urgency}`
  }

  /** The category a row currently shows: an in-flight edit, else the resolved category. */
  const categoryOf = (tpl: TaskTemplate): string | undefined => {
    const edit = categoryEdits[tpl.id]
    if (edit === undefined) return templateCategoryOf(tpl)
    const trimmed = edit.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }

  /** Whether a row holds unsaved name/category changes. */
  const dirty = (tpl: TaskTemplate): boolean => {
    if (nameOf(tpl) !== localizeBuiltinName(tpl)) return true
    const edit = categoryEdits[tpl.id]
    return edit !== undefined && edit.trim() !== (templateCategoryOf(tpl) ?? '')
  }

  /** Save one template's rename and/or category. */
  const save = (tpl: TaskTemplate, name: string): void => {
    if (!dirty(tpl) || name.trim().length === 0) return
    const category = categoryOf(tpl)
    void controller.upsertTemplate({ id: tpl.id, name, ...(category !== undefined ? { category } : {}), task: tpl.task }).then(ok => {
      if (ok) {
        setEdits(prev => { const next = { ...prev }; delete next[tpl.id]; return next })
        setCategoryEdits(prev => { const next = { ...prev }; delete next[tpl.id]; return next })
        showAlert(t('tpl.updated'))
      }
    })
  }

  return (
    <div className="dsh-atb-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) close() }}>
      <div className="dsh-atb-modal dsh-atb-tplm" role="dialog" aria-modal="true" aria-label={t('tpl.aria')}>
        <div className="dsh-atb-modal-head">
          <span className="dsh-atb-modal-headicon">⌗</span>
          <div className="dsh-atb-modal-headtext">
            <h3>{t('tpl.title')}</h3>
            <p>{t('tpl.subtitle')}</p>
          </div>
          <button type="button" className="dsh-atb-modal-close" aria-label={t('shared.close')} onClick={close}>✕</button>
        </div>
        <div className="dsh-atb-modal-body">
          {state.templates.length === 0
            ? <div className="dsh-atb-empty2">{t('tpl.empty')}</div>
            : (
                <div className="dsh-atb-tplm-list">
                    {groupTemplatesByCategory(state.templates).map(group => (
                      <div key={group.category ?? '\u0000'} className="dsh-atb-tplm-catgroup">
                        <div className="dsh-atb-tplm-cathead">▍{categoryLabel(group.category, t)} ({group.templates.length})</div>
                        {group.templates.map(tpl => (
                          <div key={tpl.id} className="dsh-atb-tplm-row">
                            <input
                              className="dsh-atb-tplm-name"
                              value={nameOf(tpl)}
                              maxLength={60}
                              spellCheck={false}
                              aria-label={t('tpl.name.aria', { name: localizeBuiltinName(tpl) })}
                              onChange={e => setEdits(prev => ({ ...prev, [tpl.id]: e.target.value }))}
                              onKeyDown={e => {
                                if (e.key === 'Enter') save(tpl, nameOf(tpl))
                              }}
                            />
                            {tpl.builtin === true
                              ? <span className="dsh-atb-tplm-catstatic" title={t('tpl.builtin')}>{categoryLabel(templateCategoryOf(tpl), t)}</span>
                              : (
                                  <CategorySuggest
                                    value={categoryEdits[tpl.id] ?? (templateCategoryOf(tpl) ?? '')}
                                    options={templateCategoryOptions(state.templates)}
                                    placeholder={t('tpl.category.placeholder')}
                                    ariaLabel={t('tpl.category.aria', { name: localizeBuiltinName(tpl) })}
                                    onPick={option => setCategoryEdits(prev => ({ ...prev, [tpl.id]: option }))}
                                    onChange={value => setCategoryEdits(prev => ({ ...prev, [tpl.id]: value }))}
                                    onEnter={() => save(tpl, nameOf(tpl))}
                                  />
                                )}
                            <span
                              className="dsh-atb-tplm-meta"
                              title={`${tpl.builtin === true ? t('tpl.builtin') : t('tpl.custom')}${tpl.task.checklist !== undefined && tpl.task.checklist.length > 0 ? t('tpl.meta.checklist', { n: tpl.task.checklist.length }) : ''}${urgencyLabel(tpl.task.urgency)}${tpl.task.permission !== undefined ? ` · ${t('shared.permission')}: ${tpl.task.permission}` : ''}`}
                            >
                              {tpl.builtin === true ? t('tpl.builtin') : t('tpl.custom')}
                              {tpl.task.checklist !== undefined && tpl.task.checklist.length > 0 ? t('tpl.meta.checklist', { n: tpl.task.checklist.length }) : ''}
                              {urgencyLabel(tpl.task.urgency)}
                              {tpl.task.permission !== undefined && tpl.task.permission !== 'workspace-write' ? ` · ${tpl.task.permission === 'read-only' ? t('tpl.meta.permReadOnly') : t('tpl.meta.permFull')}` : ''}
                            </span>
                            <span className="dsh-atb-tplm-btns">
                              <button
                                type="button"
                                className="dsh-atb-btn"
                                disabled={!dirty(tpl) || nameOf(tpl).trim().length === 0}
                                title={t('tpl.rename.title')}
                                onClick={() => save(tpl, nameOf(tpl))}
                              >
                                {t('tpl.rename.button')}
                              </button>
                              <button
                                type="button"
                                className="dsh-atb-btn"
                                title={t('tpl.use.title')}
                                onClick={() => {
                                  close()
                                  controller.newFromTemplate(localizeBuiltinTask(tpl))
                                }}
                              >
                                {t('tpl.use.button')}
                              </button>
                              {confirmId === tpl.id
                                ? (
                                    <>
                                      <button type="button" className="dsh-atb-btn" data-danger="true" onClick={() => { void controller.deleteTemplate(tpl.id); setConfirmId(undefined) }}>{t('shared.confirmDelete')}</button>
                                      <button type="button" className="dsh-atb-btn" onClick={() => setConfirmId(undefined)}>{t('shared.cancel')}</button>
                                    </>
                                  )
                                : (
                                    <button type="button" className="dsh-atb-btn" data-danger="true" title={t('tpl.delete.title')} onClick={() => setConfirmId(tpl.id)}>
                                      🗑
                                    </button>
                                  )}
                            </span>
                          </div>
                        ))}
                      </div>
                    ))}
                </div>
              )}
        </div>
        <div className="dsh-atb-modal-foot">
          <span className="dsh-atb-modal-hint">{t('tpl.foot.hint')}</span>
          <span className="dsh-atb-modal-footbtns">
            <button type="button" className="dsh-atb-btn" onClick={close}>{t('shared.close')}</button>
          </span>
        </div>
      </div>
      {alertEl}
    </div>
  )
}
