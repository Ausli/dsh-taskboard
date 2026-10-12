/**
 * Template library categories (0.8.8): pure client-side grouping derived from
 * the loaded template list. A category is a free-text label stored on each
 * template (built-ins resolve theirs per active locale); uncategorized
 * templates fall into a display-only default bucket that always sorts last.
 * There is no server-side category registry — editing a template's category
 * writes the label back through the normal template upsert.
 *
 * @module dsh-taskboard/client/template-categories
 */
import type { TaskTemplate } from '../shared/api.ts'
import type { Translate } from './i18n/runtime.ts'
import { localizeBuiltinCategory } from './i18n/templates.ts'

/** The resolved category for one template; undefined = the default bucket. */
export function templateCategoryOf(template: TaskTemplate): string | undefined {
  return localizeBuiltinCategory(template)
}

/** One derived category group in stable display order. */
export interface TemplateCategoryGroup {
  /** The resolved category; undefined marks the default (always last) bucket. */
  category: string | undefined
  templates: TaskTemplate[]
}

/** Group templates by resolved category: first-seen order, default bucket last. */
export function groupTemplatesByCategory(templates: readonly TaskTemplate[]): TemplateCategoryGroup[] {
  const groups: TemplateCategoryGroup[] = []
  const byKey = new Map<string, TemplateCategoryGroup>()
  for (const template of templates) {
    const category = templateCategoryOf(template)
    const key = category ?? ''
    let group = byKey.get(key)
    if (group === undefined) {
      group = { category, templates: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    group.templates.push(template)
  }
  const fallback = groups.filter(group => group.category === undefined)
  return [...groups.filter(group => group.category !== undefined), ...fallback]
}

/** Distinct category labels in group order; the default bucket is excluded. */
export function templateCategoryOptions(templates: readonly TaskTemplate[]): string[] {
  return groupTemplatesByCategory(templates)
    .flatMap(group => group.category !== undefined ? [group.category] : [])
}

/** Display label for a group heading: the category, or the localized default bucket. */
export function categoryLabel(category: string | undefined, t: Translate): string {
  return category ?? t('tpl.category.default')
}
