/**
 * @author Shakib
 * @since 23/10/26
 */
import type { HeadRun } from '../types'
import { expect, test } from 'claude-code/testing'

import { formatReport, overlappingHeads } from './lib/format'

type Report = Parameters<typeof formatReport>[0]

const report = (extra: Partial<Report> = {}) =>
  formatReport({ id: 'head-b', model: 'm', cwd: '/p', finished: true, rounds: 1, turns: 3, usd: 0, files: [], denied: [], finalText: 'All done. HEAD DONE', exit: '0', ...extra })

const run = (id: string, cwd: string, startedAt?: number, endedAt?: number): HeadRun => ({ id, task: '', model: 'm', state: 'done', turns: 0, cwd, startedAt, endedAt })

test('warns about the edits it put back to the committed version and the ones it changed', () => {
  const text = report({ reverted: ['/p/src/a.ts', '/p/src/b.ts'], overwritten: ['/p/src/c.ts'] })
  expect(text).toContain('⚠ put back to the committed version during this Head (uncommitted edits there are gone): src/a.ts, src/b.ts')
  expect(text).toContain('⚠ changed files that already had uncommitted edits before this Head started: src/c.ts')
})

test('names every file put back to the committed version on the line the Lead reads first', () => {
  const text = report({ reverted: ['/p/dates.dart'] })
  expect(text).toContain('⚠ put back to the committed version during this Head (uncommitted edits there are gone): dates.dart')
})

test('says softly that a file rewritten during the Head matches the committed version again', () => {
  const text = report({ restored: ['/p/lib/dates.dart'] })
  expect(text).toContain('⚠ rewritten during this Head and now identical to the committed version (if anyone edited them while it ran, those edits are gone): lib/dates.dart')
  expect(text).not.toContain('uncommitted edits there are gone')
})

test('says nothing about edits that were already there when nothing went wrong', () => {
  const text = report({ reverted: [], restored: [], overwritten: [], alsoRan: [] })
  expect(text).not.toContain('⚠ put back to the committed version')
  expect(text).not.toContain('already had uncommitted edits')
  expect(text).not.toContain('rewritten during this Head')
  expect(text).not.toContain('also ran in this folder')
})

test('warns that another Head ran in the folder during this one', () => {
  const text = report({ alsoRan: ['head-a', 'head-c'] })
  expect(text).toContain('⚠ head-a, head-c also ran in this folder during this Head; the edited list may include their files')
})

test('puts the warnings under the edited list and above the denials', () => {
  const text = report({ files: ['/p/a.ts'], reverted: ['/p/b.ts'], alsoRan: ['head-a'], denied: [{ tool: 'Bash', target: 'rm -rf /', text: 'denied' }] })
  expect(text.indexOf('⚠ put back to the committed version')).toBeGreaterThan(text.indexOf('edited (1):'))
  expect(text.indexOf('⚠ head-a')).toBeGreaterThan(text.indexOf('⚠ put back to the committed version'))
  expect(text.indexOf('denied (1):')).toBeGreaterThan(text.indexOf('⚠ head-a'))
})

test('names every Head that ran in the same folder, inside it or holding it, while this one ran', () => {
  const own = run('head-b', '/p/app', 1000, 2000)
  const runs = [
    own,
    run('same', '/p/app', 1500, 2500),
    run('inside', '/p/app/sub', 500, 1500),
    run('above', '/p', 0, 4000),
    run('sibling', '/p/other', 1000, 2000),
    run('before', '/p/app', 0, 999),
    run('after', '/p/app', 2001, 3000),
    run('queued', '/p/app'),
  ]
  expect(overlappingHeads(runs, own)).toEqual(['same', 'inside', 'above'])
})

test('counts a Head still running when this one ended, and one that started while it ran', () => {
  const own = run('head-b', '/p/app', 1000, 2000)
  const runs = [own, run('open', '/p/app', 1200), run('late', '/p/app/sub', 1900, 9000)]
  expect(overlappingHeads(runs, own)).toEqual(['open', 'late'])
})
