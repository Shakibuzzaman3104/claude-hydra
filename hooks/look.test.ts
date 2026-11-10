/**
 * @author Shakib
 * @since 10/11/26
 */
import { expect, test } from 'claude-code/testing'

import type { HeadRun } from '../types'
import { glyphOf } from './lib/format'
import { CHECK_TRIES, endingWord, headsSummaryOf, lookOf, needOf, needsLead, rowLine } from './lib/look'

const head = (extra: Partial<HeadRun> = {}): HeadRun => ({ id: 'h1', task: 't', model: 'm', state: 'running', turns: 3, ...extra })

test('a queued Head is a hollow circle with no colour', async () => {
  expect(lookOf(head({ state: 'queued' }), 0)).toEqual({ glyph: '◌', color: undefined })
})

test('a running Head spins in cyan with the frame it is on', async () => {
  const run = head()
  expect(lookOf(run, 0)).toEqual({ glyph: glyphOf(run, 0), color: 'cyan' })
  expect(lookOf(head(), 4).glyph).toBe(glyphOf(head(), 4))
})

test('a running Head shows a gear while its check runs', async () => {
  expect(lookOf(head({ check: { tries: 1, state: 'running' } }), 0)).toEqual({ glyph: '⚙', color: 'cyan' })
})

test('a running Head spins in yellow while it fixes a failed check', async () => {
  const run = head({ check: { tries: 1, state: 'fixing' } })
  expect(lookOf(run, 0)).toEqual({ glyph: glyphOf(run, 0), color: 'yellow' })
})

test('a done Head is a green tick', async () => {
  expect(lookOf(head({ state: 'done' }), 0)).toEqual({ glyph: '✓', color: 'green' })
})

test('a Head whose check failed is a red cross', async () => {
  expect(lookOf(head({ state: 'failed', ending: 'done', check: { tries: 1, state: 'failed' } }), 0)).toEqual({ glyph: '✗', color: 'red' })
})

test('a blocked Head is a yellow diamond', async () => {
  expect(lookOf(head({ state: 'failed', ending: 'blocked' }), 0)).toEqual({ glyph: '◆', color: 'yellow' })
})

test('a capped Head is a yellow clock', async () => {
  expect(lookOf(head({ state: 'failed', ending: 'capped' }), 0)).toEqual({ glyph: '◷', color: 'yellow' })
})

test('a Head out of time is a yellow clock', async () => {
  expect(lookOf(head({ state: 'failed', ending: 'timeout' }), 0)).toEqual({ glyph: '◷', color: 'yellow' })
})

test('a stalled Head is a yellow approximation sign', async () => {
  expect(lookOf(head({ state: 'failed', ending: 'stalled' }), 0)).toEqual({ glyph: '≈', color: 'yellow' })
})

test('a stopped Head is a square with no colour', async () => {
  expect(lookOf(head({ state: 'failed', ending: 'stopped' }), 0)).toEqual({ glyph: '■', color: undefined })
})

test('a Head that errored is a red cross', async () => {
  expect(lookOf(head({ state: 'failed', ending: 'error' }), 0)).toEqual({ glyph: '✗', color: 'red' })
})

test('a failed Head with no ending is a red cross', async () => {
  expect(lookOf(head({ state: 'failed' }), 0)).toEqual({ glyph: '✗', color: 'red' })
  expect(lookOf(head({ state: 'failed', ending: undefined }), 0)).toEqual({ glyph: '✗', color: 'red' })
})

test('each queued or done state reads as its own word', async () => {
  expect(endingWord(head({ state: 'queued' }))).toBe('queued')
  expect(endingWord(head({ state: 'done' }))).toBe('done')
})

test('a running Head names its check or fix round', async () => {
  expect(endingWord(head({ check: { tries: 1, state: 'running' } }))).toBe('checking')
  expect(endingWord(head({ check: { tries: 1, state: 'fixing' } }))).toBe('fixing')
  expect(endingWord(head())).toBe('running')
})

test('a failed Head names its check or its ending', async () => {
  expect(endingWord(head({ state: 'failed', check: { tries: 1, state: 'failed' } }))).toBe('check failed')
  expect(endingWord(head({ state: 'failed', ending: 'blocked' }))).toBe('blocked')
  expect(endingWord(head({ state: 'failed', ending: 'capped', turns: 100, maxTurns: 100 }))).toBe('out of turns')
  expect(endingWord(head({ state: 'failed', ending: 'capped' }))).toBe('out of rounds')
  expect(endingWord(head({ state: 'failed', ending: 'timeout' }))).toBe('out of time')
  expect(endingWord(head({ state: 'failed', ending: 'stalled' }))).toBe('stalled')
  expect(endingWord(head({ state: 'failed', ending: 'stopped' }))).toBe('stopped')
  expect(endingWord(head({ state: 'failed', ending: 'error' }))).toBe('failed')
  expect(endingWord(head({ state: 'failed' }))).toBe('failed')
})

test('a need is the first meaningful line of the summary', async () => {
  expect(needOf(head({ summary: 'Waiting on the API key' }))).toBe('Waiting on the API key')
  expect(needOf(head({ summary: '\n\n  Waiting on the API key  \nsecond line' }))).toBe('Waiting on the API key')
})

test('a need drops a leading list marker', async () => {
  expect(needOf(head({ summary: '- Fix the login' }))).toBe('Fix the login')
  expect(needOf(head({ summary: '* Fix the login' }))).toBe('Fix the login')
  expect(needOf(head({ summary: '• Fix the login' }))).toBe('Fix the login')
})

test('a need drops a BLOCKED label in any case', async () => {
  expect(needOf(head({ summary: 'BLOCKED: needs X' }))).toBe('needs X')
  expect(needOf(head({ summary: 'Blocked: needs X' }))).toBe('needs X')
})

test('a Head without a summary points at its report', async () => {
  expect(needOf(head({ summary: '' }))).toBe('see its report')
  expect(needOf(head({ summary: undefined }))).toBe('see its report')
})

test('a queued row says what it waits on', async () => {
  expect(rowLine(head({ state: 'queued', activity: 'waiting for a slot' }))).toBe('waiting for a slot')
  expect(rowLine(head({ state: 'queued' }))).toBe('queued')
})

test('a running check row counts its tries and names the command', async () => {
  expect(rowLine(head({ check: { tries: 1, state: 'running' }, activity: 'check: npm test' }))).toBe(`check 1/${CHECK_TRIES} · npm test`)
  expect(rowLine(head({ check: { tries: 2, state: 'running' }, activity: undefined }))).toBe(`check 2/${CHECK_TRIES}`)
})

test('a fixing row counts its fix rounds and says what it works on', async () => {
  expect(rowLine(head({ check: { tries: 1, state: 'fixing' }, activity: 'editing a.ts' }))).toBe('fix round 1/2 · editing a.ts')
  expect(rowLine(head({ check: { tries: 2, state: 'fixing' }, activity: undefined }))).toBe('fix round 2/2 · working')
})

test('a plain running row says what it does', async () => {
  expect(rowLine(head({ activity: 'reading a.ts' }))).toBe('reading a.ts')
  expect(rowLine(head({ activity: undefined }))).toBe('running')
})

test('a done row counts files, the check and the spend', async () => {
  const run = head({
    state: 'done',
    expected: ['a', 'b'],
    files: ['a', 'b'],
    check: { tries: 1, state: 'passed' },
    costUsd: 0.0213,
  })
  expect(rowLine(run)).toBe('done · 2/2 files · check ✓ · $0.0213')
})

test('a done row says when the check could not judge the code', async () => {
  expect(rowLine(head({ state: 'done', check: { tries: 1, state: 'unknown' } }))).toBe('done · check ?')
})

test('a done row shows tokens when there is no cost', async () => {
  expect(rowLine(head({ state: 'done', tokens: '12k in / 800 out' }))).toBe('done · 12k in / 800 out')
})

test('a done row with nothing to add is just done', async () => {
  expect(rowLine(head({ state: 'done' }))).toBe('done')
})

test('a failed check row counts its tries', async () => {
  expect(rowLine(head({ state: 'failed', check: { tries: 1, state: 'failed' } }))).toBe('check ✗ failed after 1 try')
  expect(rowLine(head({ state: 'failed', check: { tries: 2, state: 'failed' } }))).toBe('check ✗ failed after 2 tries')
})

test('a blocked row says what it needs', async () => {
  expect(rowLine(head({ state: 'failed', ending: 'blocked', summary: 'BLOCKED: needs X' }))).toBe('blocked · needs X')
})

test('a capped row says which limit and how to continue', async () => {
  expect(rowLine(head({ state: 'failed', ending: 'capped', turns: 100, maxTurns: 100, sessionId: 's', engine: 'codex', id: 'h1' }))).toBe('out of turns · resume: "h1"')
  expect(rowLine(head({ state: 'failed', ending: 'capped', turns: 100, maxTurns: 100, sessionId: 's', engine: 'agy', id: 'h1' }))).toBe('out of turns · needs a new Head')
  expect(rowLine(head({ state: 'failed', ending: 'capped', sessionId: undefined }))).toBe('out of rounds · needs a new Head')
})

test('a timeout row says how to continue', async () => {
  expect(rowLine(head({ state: 'failed', ending: 'timeout', sessionId: 's', engine: 'codex', id: 'h1' }))).toBe('out of time · resume: "h1"')
  expect(rowLine(head({ state: 'failed', ending: 'timeout' }))).toBe('out of time · needs a new Head')
})

test('a stalled row says whether it edited anything', async () => {
  expect(rowLine(head({ state: 'failed', ending: 'stalled', files: ['a.ts'] }))).toBe('stalled · read its diff')
  expect(rowLine(head({ state: 'failed', ending: 'stalled', touched: ['a.ts'] }))).toBe('stalled · read its diff')
  expect(rowLine(head({ state: 'failed', ending: 'stalled' }))).toBe('stalled · no edits')
})

test('any other failure row says what it was doing', async () => {
  expect(rowLine(head({ state: 'failed', ending: 'stopped', activity: 'stopped by the Lead' }))).toBe('stopped by the Lead')
  expect(rowLine(head({ state: 'failed', ending: 'error', activity: undefined }))).toBe('failed')
  expect(rowLine(head({ state: 'failed', ending: undefined, activity: undefined }))).toBe('failed')
})

test('only a failed Head that ran out of room needs the Lead', async () => {
  expect(needsLead(head({ state: 'failed', ending: 'blocked' }))).toBe(true)
  expect(needsLead(head({ state: 'failed', ending: 'capped' }))).toBe(true)
  expect(needsLead(head({ state: 'failed', ending: 'timeout' }))).toBe(true)
  expect(needsLead(head({ state: 'failed', ending: 'stalled' }))).toBe(true)
})

test('a failed check or another ending leaves nothing to continue', async () => {
  expect(needsLead(head({ state: 'failed', ending: 'blocked', check: { tries: 1, state: 'failed' } }))).toBe(false)
  expect(needsLead(head({ state: 'failed', ending: 'error' }))).toBe(false)
  expect(needsLead(head({ state: 'failed', ending: 'stopped' }))).toBe(false)
  expect(needsLead(head({ state: 'running', ending: 'blocked' }))).toBe(false)
})

test('an empty list has no summary', async () => {
  expect(headsSummaryOf([])).toBe('')
})

test('the summary counts what runs, what ended and what needs the Lead', async () => {
  const list = [
    head(),
    head({ id: 'h2' }),
    head({ id: 'h3', state: 'done' }),
    head({ id: 'h4', state: 'failed', ending: 'blocked' }),
    head({ id: 'h5', state: 'failed', ending: 'error' }),
  ]
  expect(headsSummaryOf(list)).toBe('2 running · 1 done · 1 to continue · 1 failed')
})

test('the summary keeps its order and leaves out zero counts', async () => {
  expect(headsSummaryOf([head({ state: 'queued' }), head({ state: 'done' })])).toBe('1 queued · 1 done')
  expect(headsSummaryOf([head({ state: 'failed', ending: 'capped' })])).toBe('1 to continue')
})
