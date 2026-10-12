// @vitest-environment jsdom
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BoardController } from '../src/client/controller.ts'
import { TaskBoard } from '../src/client/board/TaskBoard.tsx'
import type { TaskRecord, BoardSettings } from '../src/shared/protocol.ts'
import { waitFor } from './wait-for.ts'
import { disposeI18n } from '../src/client/i18n/runtime.ts'

const cleanups: Array<() => void> = []
beforeEach(() => {
  localStorage.clear()
  document.documentElement.lang = 'zh-CN'
  disposeI18n()
})
afterEach(() => {
  cleanups.splice(0).reverse().forEach(d => d())
  localStorage.clear()
})

function makeTask(id: string, index: number, status: TaskRecord['status'] = 'done'): TaskRecord {
  return {
    id,
    title: `Task ${id}`,
    description: '',
    prompt: '',
    workspaceId: 'ws-a',
    urgency: 'normal',
    status,
    blocked: false,
    execution: { mode: 'claim' },
    version: 1,
    createdAt: 1000 + index,
    updatedAt: 1000 + index,
    createdBy: { kind: 'user' },
    updatedBy: { kind: 'user' },
    comments: [],
    executions: [],
  }
}

async function renderBoard(tasks: TaskRecord[], settings: BoardSettings = {}) {
  const controller = new BoardController({
    state: async () => ({ schemaVersion: 1, revision: 1, tasks, settings }),
    workspaces: async () => [{ id: 'ws-a', path: '/p/a', title: 'A', sessionCount: 0 }],
    stream: () => () => {},
  } as never)
  controller.start()
  cleanups.push(() => controller.dispose())
  await waitFor(() => controller.getSnapshot().workspaces.length === 1)

  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  cleanups.push(() => { root.unmount(); host.remove() })

  root.render(React.createElement(TaskBoard, { controller }))
  return { controller, host }
}

describe('TaskBoard completed tasks display limit and foldbar', () => {
  it('truncates done column to default 50 when there are 60 done tasks', async () => {
    const tasks: TaskRecord[] = Array.from({ length: 60 }, (_, i) => makeTask(`done-${i}`, i))
    const { host } = await renderBoard(tasks)

    // Locate the done column
    await waitFor(() => host.querySelectorAll('.dsh-atb-column').length === 5)
    const columns = Array.from(host.querySelectorAll('.dsh-atb-column'))
    const doneCol = columns[4]! // backlog, todo, in_progress, in_review, done

    // Total count in column header should reflect real count (60)
    const countEl = doneCol.querySelector('.dsh-atb-colcount')
    expect(countEl?.textContent).toBe('60')

    // Only 50 cards rendered
    const cards = doneCol.querySelectorAll('.dsh-atb-card')
    expect(cards.length).toBe(50)

    // Foldbar appears with fold tip and expand button
    const foldBar = doneCol.querySelector('.dsh-atb-done-foldbar')
    expect(foldBar).toBeTruthy()
    expect(foldBar?.textContent).toContain('已折叠较早的 10 条已完成任务')
    const expandBtn = foldBar?.querySelector<HTMLButtonElement>('.dsh-atb-done-foldbtn')
    expect(expandBtn?.textContent).toBe('展开全部')
  })

  it('respects completedDisplayLimit from board settings', async () => {
    const tasks: TaskRecord[] = Array.from({ length: 30 }, (_, i) => makeTask(`done-${i}`, i))
    const { host } = await renderBoard(tasks, { completedDisplayLimit: 20 })

    await waitFor(() => host.querySelectorAll('.dsh-atb-column').length === 5)
    const doneCol = host.querySelectorAll('.dsh-atb-column')[4]!

    expect(doneCol.querySelector('.dsh-atb-colcount')?.textContent).toBe('30')
    const cards = doneCol.querySelectorAll('.dsh-atb-card')
    expect(cards.length).toBe(20)

    const foldBar = doneCol.querySelector('.dsh-atb-done-foldbar')
    expect(foldBar?.textContent).toContain('已折叠较早的 10 条已完成任务')
  })

  it('expands all tasks on click and can be collapsed again', async () => {
    const tasks: TaskRecord[] = Array.from({ length: 55 }, (_, i) => makeTask(`done-${i}`, i))
    const { host } = await renderBoard(tasks)

    await waitFor(() => host.querySelectorAll('.dsh-atb-column').length === 5)
    const doneCol = host.querySelectorAll('.dsh-atb-column')[4]!
    expect(doneCol.querySelectorAll('.dsh-atb-card').length).toBe(50)

    const expandBtn = doneCol.querySelector<HTMLButtonElement>('.dsh-atb-done-foldbtn')!
    expect(expandBtn.textContent).toBe('展开全部')

    // Click expand all
    expandBtn.click()
    await waitFor(() => doneCol.querySelectorAll('.dsh-atb-card').length === 55)

    const collapseBtn = doneCol.querySelector<HTMLButtonElement>('.dsh-atb-done-foldbtn')!
    expect(collapseBtn.textContent).toBe('收起')

    // Click collapse
    collapseBtn.click()
    await waitFor(() => doneCol.querySelectorAll('.dsh-atb-card').length === 50)
  })

  it('exempts truncation when search keyword is active', async () => {
    const tasks: TaskRecord[] = Array.from({ length: 60 }, (_, i) => makeTask(`done-${i}`, i))
    const { host, controller } = await renderBoard(tasks)

    await waitFor(() => host.querySelectorAll('.dsh-atb-column').length === 5)
    const doneCol = host.querySelectorAll('.dsh-atb-column')[4]!
    expect(doneCol.querySelectorAll('.dsh-atb-card').length).toBe(50)

    // Type search matching all tasks
    controller.setSearch('done')
    await waitFor(() => doneCol.querySelectorAll('.dsh-atb-card').length === 60)

    // Foldbar should not be shown during search
    expect(doneCol.querySelector('.dsh-atb-done-foldbar')).toBeNull()

    // Clear search restores fold
    controller.setSearch('')
    await waitFor(() => doneCol.querySelectorAll('.dsh-atb-card').length === 50)
    expect(doneCol.querySelector('.dsh-atb-done-foldbar')).toBeTruthy()
  })
})
