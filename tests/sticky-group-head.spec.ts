// @vitest-environment jsdom
/**
 * Sticky project headers inside each column's card scroller.
 *
 * The board used to lose its project label the moment a column scrolled: the
 * column head sits OUTSIDE the scroller (so it never moved), but the project
 * row rode up with its cards, leaving a long column unlabelled. The header is
 * now pinned with position: sticky.
 *
 * Two things can silently break that pinning, and both are asserted here:
 * 1. the sticky header's ancestor chain must actually contain the scrolling
 *    box (a sticky element whose ancestor has overflow: hidden / transform,
 *    or that is not a descendant of the scroller at all, simply stops
 *    sticking);
 * 2. the header fill must be OPAQUE — cards slide underneath it, so a
 *    transparent background would let their text bleed through the label.
 */
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BoardController } from '../src/client/controller.ts'
import { TaskBoard } from '../src/client/board/TaskBoard.tsx'
import type { TaskRecord } from '../src/shared/protocol.ts'
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

/** One task per workspace so each column renders several project groups. */
function makeTask(id: string, workspaceId: string): TaskRecord {
  return {
    id,
    title: `Task ${id}`,
    description: '',
    prompt: '',
    workspaceId,
    urgency: 'normal',
    status: 'todo',
    blocked: false,
    execution: { mode: 'claim' },
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    createdBy: { kind: 'user' },
    updatedBy: { kind: 'user' },
    comments: [],
    executions: [],
  }
}

async function renderBoard(tasks: TaskRecord[]): Promise<HTMLElement> {
  const controller = new BoardController({
    state: async () => ({ schemaVersion: 1, revision: 1, tasks }),
    workspaces: async () => [
      { id: 'ws-a', path: '/p/a', title: 'Alpha Repo', sessionCount: 0 },
      { id: 'ws-b', path: '/p/b', title: 'Beta Repo', sessionCount: 0 },
    ],
    stream: () => () => {},
  } as never)
  controller.start()
  cleanups.push(() => controller.dispose())
  await waitFor(() => controller.getSnapshot().workspaces.length === 2)

  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  cleanups.push(() => { root.unmount(); host.remove() })
  root.render(React.createElement(TaskBoard, { controller }))
  return host
}

describe('sticky project group headers', () => {
  it('pins .dsh-atb-ws-group-head to the top of its card scroller', async () => {
    const host = await renderBoard([makeTask('a-1', 'ws-a'), makeTask('a-2', 'ws-a'), makeTask('b-1', 'ws-b')])
    await waitFor(() => host.querySelectorAll('.dsh-atb-column').length === 5)

    const heads = Array.from(host.querySelectorAll<HTMLElement>('.dsh-atb-ws-group-head'))
    expect(heads.length).toBeGreaterThan(0)

    for (const head of heads) {
      // Structural precondition: the header must live INSIDE the element that
      // actually scrolls, otherwise position: sticky has no scrollport to
      // stick to and silently degrades to a normal row.
      const scroller = head.closest('.dsh-atb-cards')
      expect(scroller, 'group header must be a descendant of the card scroller').not.toBeNull()

      // No ancestor between the header and its scroller may clip or transform,
      // which would neuter sticky.
      for (let node = head.parentElement; node !== null && node !== scroller; node = node.parentElement) {
        expect(node.classList.contains('dsh-atb-column'), 'column must not sit between header and scroller').toBe(false)
      }
    }
  })

  it('stylesheet carries the sticky rule with an opaque fill', async () => {
    const { injectStyles } = await import('../src/client/styles.ts')
    document.getElementById('dsh-taskboard-styles')?.remove()
    injectStyles()
    const css = document.getElementById('dsh-taskboard-styles')!.textContent ?? ''

    // Isolate the group-header rule so an unrelated sticky elsewhere in the
    // sheet cannot satisfy the assertion.
    const rule = /\.dsh-atb-ws-group-head\s*\{([^}]*)\}/.exec(css)
    expect(rule, '.dsh-atb-ws-group-head rule must exist').not.toBeNull()
    const body = rule![1]!

    expect(body).toContain('position: sticky')
    expect(body).toContain('top: 0')
    // Stacked layer + opaque base: cards sliding under the label must not show
    // through. A bare rgba tint (what the row used to carry) would.
    expect(body).toContain('var(--dsw-alias-bg-base')
    expect(body).not.toMatch(/background:\s*(transparent|none)\s*;/)
  })
})
