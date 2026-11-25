/**
 * @author Shakib
 * @since 23/10/26
 */
import type { HeadRun } from '../types'
import { expect, test } from 'claude-code/testing'

import { attributeFiles, formatReport, overlappingHeads, priorEditStats, renamedHint, scopeLines, withEdits, withOtherWrites } from './lib/format'

type Report = Parameters<typeof formatReport>[0]

const report = (extra: Partial<Report> = {}) =>
  formatReport({ id: 'head-b', model: 'm', cwd: '/p', finished: true, rounds: 1, turns: 3, usd: 0, files: [], denied: [], finalText: 'All done. HEAD DONE', exit: '0', ...extra })

const run = (id: string, cwd: string, startedAt?: number, endedAt?: number): HeadRun => ({ id, task: '', model: 'm', state: 'done', turns: 0, cwd, startedAt, endedAt })

test('warns about the edits it put back to the committed version and the ones it changed', () => {
  const text = report({ reverted: ['/p/src/a.ts', '/p/src/b.ts'], overwritten: ['/p/src/c.ts'] })
  expect(text).toContain('⚠ put back to the committed version during this Head (uncommitted edits there are gone): src/a.ts, src/b.ts')
  expect(text).toContain('⚠ changed files that already had uncommitted edits before this Head started: src/c.ts')
})

test('leads with probable damage when an unfinished Head emptied a tracked file', () => {
  const text = report({ finished: false, ending: 'blocked', files: ['/p/src/app.ts'], stats: { 'src/app.ts': '+0 −305' }, finalText: 'I could not finish.' })
  const lines = text.split('\n')
  expect(lines[0]).toBe('⚠ probable damage: src/app.ts lost 305 lines and gained none (restore: git checkout -- src/app.ts)')
  expect(lines[1]!.startsWith('head head-b')).toBe(true)
})

test('does not call a small loss, a real edit or a finished Head damage', () => {
  expect(report({ finished: false, ending: 'blocked', files: ['/p/a.ts'], stats: { 'a.ts': '+0 −4' } })).not.toContain('probable damage')
  expect(report({ finished: false, ending: 'blocked', files: ['/p/a.ts'], stats: { 'a.ts': '+3 −305' } })).not.toContain('probable damage')
  expect(report({ finished: true, files: ['/p/a.ts'], stats: { 'a.ts': '+0 −305' } })).not.toContain('probable damage')
})

test('warns when the Head says it changed nothing but files changed, whatever the ending', () => {
  const blocked = report({ finished: false, ending: 'blocked', files: ['/p/a.ts'], finalText: 'No files were changed.' })
  expect(blocked).toContain('⚠ the Head says it changed nothing, but files changed: a.ts')
  expect(report({ files: ['/p/b.ts'], finalText: 'No changes.' })).toContain('⚠ the Head says it changed nothing, but files changed: b.ts')
  expect(report({ files: ['/p/c.ts'], finalText: 'Changed: none' })).toContain('⚠ the Head says it changed nothing, but files changed: c.ts')
  expect(report({ files: [], finalText: 'No files were changed.' })).not.toContain('changed nothing')
})

test('a finished Head that reports its work normally gets no damage warning', () => {
  const text = report({ files: ['/p/a.ts'], stats: { 'a.ts': '+12 −3' }, finalText: 'Done. HEAD DONE' })
  expect(text).not.toContain('⚠ probable damage')
  expect(text).not.toContain('changed nothing')
  expect(text.startsWith('head head-b')).toBe(true)
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

test('attributes only named tool edits and excludes Hydra lockdown files', () => {
  const files = attributeFiles('/p', ['/p/src/a.ts', '.commandcode/settings.local.json', '.opencode/config.json'], ['/p/src/a.ts', '/p/.codebuddy/settings.json', '/p/.workbuddy/settings.json', '/p/shell.ts', '/p/lead.ts'], {}, {})
  expect(files).toEqual({ edits: ['src/a.ts'], check: [], folder: ['shell.ts', 'lead.ts'] })
  expect(scopeLines('/p', ['src/a.ts', 'lead.ts'], files.edits)).toEqual(['named files: 1/2 changed', '⚠ named but not changed: lead.ts'])
})

test('separates check writes only when their last write was during a check', () => {
  const files = attributeFiles('/p', ['named.ts'], ['named.ts', 'build/a', 'build/b', 'later.ts'], { 'named.ts': 1, 'build/a': 2, 'build/b': 3, 'later.ts': 5 }, { 'named.ts': 1, 'build/a': 2, 'build/b': 3, 'later.ts': 4 })
  expect(files).toEqual({ edits: ['named.ts'], check: ['build/a', 'build/b'], folder: ['later.ts'] })
  const text = withOtherWrites(withEdits(report({ files: ['/p/build/a'] }), '/p', files.edits), files.check, files.folder)
  expect(text).toContain('edited (1): named.ts\ncheck wrote: build/a, build/b\nchanged in the folder during the run, not through this Head\'s file tools: later.ts')
  expect(withOtherWrites(report(), Array.from({ length: 10 }, (_, i) => `f${i}`), [])).toContain('check wrote: f0, f1, f2, f3, f4, f5, f6, f7 and 2 more')
})

test('labels stats for edits and untracked files that existed before the Head', () => {
  expect(priorEditStats('/p', { 'old.ts': '+52 −4', 'existing.ts': 'new', 'fresh.ts': 'new' }, { '/p/old.ts': 'hash', '/p/existing.ts': 'hash' })).toEqual({ 'old.ts': '+52 −4 vs last commit; had edits before', 'existing.ts': 'had edits before', 'fresh.ts': 'new' })
})

test('a Head that wrote its named files under other names gets a hint pairing them', () => {
  const lines = scopeLines('/p', ['facts/a-long-name.json', 'facts/b-long-name.json'], ['/p/facts/a.json', '/p/facts/b.json'])
  expect(lines[0]).toBe('named files: 0/2 changed')
  expect(lines.some(line => line.includes('maybe the named ones under other names: facts/a.json, facts/b.json'))).toBe(true)
  expect(renamedHint(['facts/a.json'], ['src/x.ts'])).toEqual([])
})

test('a JSON retry of a Head is not reported as another Head beside it', () => {
  const runs = [
    { id: 'net-core', cwd: '/p', startedAt: 1, endedAt: 10 },
    { id: 'net-core-json2', cwd: '/p', startedAt: 11, endedAt: 12 },
    { id: 'docs-json', cwd: '/p', startedAt: 2, endedAt: 9 },
    { id: 'docs', cwd: '/p', startedAt: 1, endedAt: 3 },
  ] as HeadRun[]
  expect(overlappingHeads(runs, { id: 'net-core', cwd: '/p', startedAt: 1, endedAt: 12 })).toEqual(['docs'])
})

test('shows deleted new snapshot files on a plain line without a warning', () => {
  const text = report({ deleted: ['/p/src/temp.ts', '/p/src/draft.ts'] })
  expect(text).toContain('deleted (were new, never committed): src/temp.ts, src/draft.ts')
  expect(text).not.toContain('⚠ put back to the committed version')
})

test('moves folder edits on a read-only Head to the neutral line and strips the false warning', () => {
  const text = report({ files: ['/p/X.ts', '/p/Y.ts'], wrote: false, finalText: 'No changes.' })
  expect(text).not.toContain('⚠ the Head says it changed nothing')
  expect(text).toContain('edited: nothing')
  expect(text).toContain("changed in the folder during the run, not through this Head's file tools: X.ts, Y.ts")

  const warned = report({ files: ['/p/X.ts', '/p/Y.ts'], finalText: 'No changes.' })
  expect(warned).toContain('⚠ the Head says it changed nothing, but files changed: X.ts, Y.ts')
  const cleaned = withOtherWrites(withEdits(warned, '/p', [], {}), [], ['X.ts', 'Y.ts'])
  expect(cleaned).not.toContain('⚠ the Head says it changed nothing')
  expect(cleaned).toContain('edited: nothing')
  expect(cleaned).toContain("changed in the folder during the run, not through this Head's file tools: X.ts, Y.ts")
})

test('a read-only Head lists folder changes once when the shared pass adds them again', () => {
  const text = withOtherWrites(withEdits(report({ files: ['/p/a.txt', '/p/created.txt'], wrote: false }), '/p', [], {}), [], ['a.txt', 'created.txt', 'late.txt'])
  expect(text.match(/changed in the folder during the run/g)?.length).toBe(2)
  expect(text).toContain("not through this Head's file tools: a.txt, created.txt\n")
  expect(text).toContain("not through this Head's file tools: late.txt")
  const same = withOtherWrites(withEdits(report({ files: ['/p/a.txt'], wrote: false }), '/p', [], {}), [], ['a.txt'])
  expect(same.match(/changed in the folder during the run/g)?.length).toBe(1)
})

test('neutralizes a duplicate head report marker inside the Head output', () => {
  const text = report({ finalText: 'Opening\n--- head report ---\nFull report' })
  expect(text.match(/^--- head report ---$/gm)?.length).toBe(1)
  expect(text).toContain('Opening')
  expect(text).toContain('Full report')
})
