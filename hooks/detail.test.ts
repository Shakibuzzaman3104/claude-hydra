/**
 * @author Shakib
 * @since 10/11/26
 */
import { expect, test } from 'claude-code/testing'

import type { HeadRun } from '../types'
import { checklistOf, checklistText, nextStepOf, reportLines, sessionProgress, sessionProgressText, taskTitle } from './lib/detail'

const head = (extra: Partial<HeadRun> = {}): HeadRun => ({ id: 'h1', task: 't', model: 'm', state: 'running', turns: 3, ...extra })

test('checklistOf builds rows with expected, touched, files and diff stats', async () => {
  const run = head({
    expected: ['a.kt', 'b.kt'],
    files: ['a.kt', 'z.kt'],
    stats: { 'a.kt': '+3 −1', 'z.kt': 'new' },
  })
  expect(checklistOf(run)).toEqual([
    { mark: '✓', file: 'a.kt', stat: '+3 −1' },
    { mark: '·', file: 'b.kt', stat: '' },
    { mark: '+', file: 'z.kt', stat: 'new' },
  ])
})

test('checklistOf marks all files as checked when expected is missing or empty', async () => {
  const run = head({ touched: ['x.kt'] })
  expect(checklistOf(run)).toEqual([{ mark: '✓', file: 'x.kt', stat: '' }])
})

test('checklistOf lists a file present in both files and touched once', async () => {
  const run = head({
    files: ['a.kt'],
    touched: ['a.kt', 'b.kt'],
  })
  expect(checklistOf(run)).toEqual([
    { mark: '✓', file: 'a.kt', stat: '' },
    { mark: '✓', file: 'b.kt', stat: '' },
  ])
})

test('checklistText formats rows with and without stats', async () => {
  expect(checklistText({ mark: '✓', file: 'a.kt', stat: '+3 −1' })).toBe('✓ a.kt +3 −1')
  expect(checklistText({ mark: '·', file: 'b.kt', stat: '' })).toBe('· b.kt')
})

test('nextStepOf returns guidance only for resumable failed heads', async () => {
  expect(nextStepOf(head({ state: 'running' }))).toBeUndefined()
  expect(nextStepOf(head({ state: 'done' }))).toBeUndefined()
  const capped = head({
    state: 'failed',
    ending: 'capped',
    turns: 100,
    maxTurns: 100,
    sessionId: 's',
    engine: 'codex',
  })
  expect(nextStepOf(capped)).toContain('resume: "h1"')
  const errored = head({
    state: 'failed',
    ending: 'error',
    turns: 100,
    maxTurns: 100,
    sessionId: 's',
    engine: 'codex',
  })
  expect(nextStepOf(errored)).toBeUndefined()
})

test('taskTitle extracts the first sentence or non-empty line without prefix', async () => {
  expect(taskTitle('Goal: add a login screen. Files: a.kt')).toBe('add a login screen')
  expect(taskTitle('\n\n  Task: fix the crash.')).toBe('fix the crash')
  expect(taskTitle('rename foo')).toBe('rename foo')
  expect(taskTitle('')).toBe('')
})

test('sessionProgress sums done and total over runs with expected files', async () => {
  expect(sessionProgress([head({ files: ['a.kt'] })])).toBeUndefined()
  const r1 = head({ expected: ['a.kt', 'b.kt'], files: ['a.kt', 'b.kt'] })
  const r2 = head({ expected: ['c.kt', 'd.kt', 'e.kt'], touched: ['c.kt'] })
  expect(sessionProgress([r1, r2])).toEqual({ done: 3, total: 5 })
})

test('sessionProgressText formats progress string or returns empty string', async () => {
  const r1 = head({ expected: ['a.kt', 'b.kt'], files: ['a.kt', 'b.kt'] })
  const r2 = head({ expected: ['c.kt', 'd.kt', 'e.kt'], touched: ['c.kt'] })
  expect(sessionProgressText([r1, r2])).toBe('3/5 files')
  expect(sessionProgressText([head({ files: ['a.kt'] })])).toBe('')
})

test('reportLines parses labeled sections, markdown formatting, and trims plain lines', async () => {
  const input = 'Done: built it\n\n- **Changed:** a.kt\nNot done: tests\nplain line  '
  expect(reportLines(input)).toEqual([
    { label: 'Done', text: 'built it' },
    { label: 'Changed', text: 'a.kt' },
    { label: 'Not done', text: 'tests' },
    { label: '', text: 'plain line' },
  ])
})

test('reportLines respects the max lines limit', async () => {
  const input = 'Done: 1\nDone: 2\nDone: 3\nDone: 4'
  expect(reportLines(input, 2)).toEqual([
    { label: 'Done', text: '1' },
    { label: 'Done', text: '2' },
  ])
})
