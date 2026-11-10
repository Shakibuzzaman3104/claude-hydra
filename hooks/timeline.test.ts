/**
 * @author Shakib
 * @since 10/11/26
 */
import { expect, test } from 'claude-code/testing'

import type { HeadRun } from '../types'
import type { TimelineSegment } from './lib/timeline'
import { checkTriesOf, timelineSegments } from './lib/timeline'

const head = (extra: Partial<HeadRun> = {}): HeadRun => ({ id: 'h1', task: 't', model: 'm', state: 'done', turns: 3, ...extra })

const total = (segments: TimelineSegment[]) => segments.reduce((sum, segment) => sum + segment.cells, 0)

const span = { start: 0, end: 1000 }

test('a Head that has not started is idle across the whole width', async () => {
  expect(timelineSegments(head(), span, 10, 1000)).toEqual([{ kind: 'idle', cells: 10 }])
})

test('a Head with no marks works across its whole run', async () => {
  expect(timelineSegments(head({ startedAt: 0, endedAt: 1000 }), span, 10, 1000)).toEqual([{ kind: 'work', cells: 10 }])
})

test('a check mark turns the rest of the bar into check time', async () => {
  expect(timelineSegments(head({ startedAt: 0, endedAt: 1000, marks: [{ at: 600, kind: 'check' }] }), span, 10, 1000)).toEqual([
    { kind: 'work', cells: 6 },
    { kind: 'check', cells: 4 },
  ])
})

test('a fix mark returns the Head to work until the next check', async () => {
  expect(timelineSegments(head({ startedAt: 0, endedAt: 1000, marks: [{ at: 400, kind: 'check' }, { at: 600, kind: 'fix' }, { at: 900, kind: 'check' }] }), span, 10, 1000)).toEqual([
    { kind: 'work', cells: 4 },
    { kind: 'check', cells: 2 },
    { kind: 'work', cells: 3 },
    { kind: 'check', cells: 1 },
  ])
})

test('a check too short to hold a cell middle still keeps one cell', async () => {
  expect(timelineSegments(head({ startedAt: 0, endedAt: 1000, marks: [{ at: 410, kind: 'check' }, { at: 440, kind: 'fix' }] }), span, 10, 1000)).toEqual([
    { kind: 'work', cells: 4 },
    { kind: 'check', cells: 1 },
    { kind: 'work', cells: 5 },
  ])
})

test('a Head covering part of the span sits between idle cells', async () => {
  expect(timelineSegments(head({ startedAt: 500, endedAt: 1000, marks: [{ at: 750, kind: 'check' }] }), span, 10, 1000)).toEqual([
    { kind: 'idle', cells: 5 },
    { kind: 'work', cells: 2 },
    { kind: 'check', cells: 3 },
  ])
})

test('marks given out of order read the same as sorted ones', async () => {
  const sorted = [{ at: 400, kind: 'check' as const }, { at: 600, kind: 'fix' as const }, { at: 900, kind: 'check' as const }]
  const shuffled = [{ at: 900, kind: 'check' as const }, { at: 400, kind: 'check' as const }, { at: 600, kind: 'fix' as const }]
  expect(timelineSegments(head({ startedAt: 0, endedAt: 1000, marks: shuffled }), span, 10, 1000)).toEqual(
    timelineSegments(head({ startedAt: 0, endedAt: 1000, marks: sorted }), span, 10, 1000),
  )
})

test('every timeline adds up to the width', async () => {
  const cases = [
    timelineSegments(head(), span, 10, 1000),
    timelineSegments(head({ startedAt: 0, endedAt: 1000 }), span, 10, 1000),
    timelineSegments(head({ startedAt: 500, endedAt: 1000, marks: [{ at: 750, kind: 'check' }] }), span, 10, 1000),
  ]
  expect(cases.map(total)).toEqual([10, 10, 10])
})

test('check tries count only check marks', async () => {
  expect(checkTriesOf(head({ marks: [{ at: 400, kind: 'check' }, { at: 600, kind: 'fix' }, { at: 900, kind: 'check' }] }))).toBe(2)
  expect(checkTriesOf(head())).toBe(0)
})
