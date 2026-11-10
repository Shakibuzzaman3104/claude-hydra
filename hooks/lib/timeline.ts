/**
 * @author Shakib
 * @since 10/11/26
 */
import type { HeadRun } from '../../types'
import { timelineBar } from './format'

/** What a Head was doing in one stretch of its bar. */
export type TimelineKind = 'idle' | 'work' | 'check'

/** How many cells one stretch of a Head's bar takes. */
export type TimelineSegment = { kind: TimelineKind; cells: number }

/** The glyph each kind of timeline stretch is drawn with. */
export const TIMELINE_GLYPH: Record<TimelineKind, string> = { idle: '─', work: '━', check: '╍' }

/** A Head's bar as idle, work and check stretches, in order, the cells adding up to `width`. */
export const timelineSegments = (run: HeadRun, span: { start: number; end: number }, width: number, now: number): TimelineSegment[] => {
  if (run.startedAt === undefined) return [{ kind: 'idle', cells: width }]
  const { before, bar, after } = timelineBar(run, span, width, now)
  const start = run.startedAt
  const end = run.endedAt ?? now
  const marks = [...(run.marks ?? [])].sort((a, b) => a.at - b.at)
  const phases: TimelineKind[] = Array.from({ length: bar }, () => 'work')
  if (end > start) {
    const phaseAt = (at: number) => {
      let phase: TimelineKind = 'work'
      for (const mark of marks) if (mark.at <= at) phase = mark.kind === 'check' ? 'check' : 'work'
      return phase
    }
    const cellOf = (at: number) => Math.min(bar - 1, Math.max(0, Math.floor(((at - start) / (end - start)) * bar)))
    for (let i = 0; i < bar; i++) phases[i] = phaseAt(start + ((i + 0.5) / bar) * (end - start))
    for (let i = 0; i < marks.length; i++) {
      const mark = marks[i]!
      if (mark.kind !== 'check') continue
      const cell = cellOf(mark.at)
      const last = i + 1 < marks.length ? cellOf(marks[i + 1]!.at) : bar - 1
      if (bar > 1 && !phases.slice(cell, last + 1).includes('check')) phases[cell] = 'check'
    }
  }
  const barSegments: TimelineSegment[] = []
  for (const phase of phases) {
    const prev = barSegments[barSegments.length - 1]
    if (prev && prev.kind === phase) prev.cells += 1
    else barSegments.push({ kind: phase, cells: 1 })
  }
  const segments: TimelineSegment[] = [{ kind: 'idle', cells: before }, ...barSegments, { kind: 'idle', cells: after }]
  const merged: TimelineSegment[] = []
  for (const segment of segments) {
    if (segment.cells === 0) continue
    const prev = merged[merged.length - 1]
    if (prev && prev.kind === segment.kind) prev.cells += segment.cells
    else merged.push({ kind: segment.kind, cells: segment.cells })
  }
  return merged
}

/** How many times Hydra sent this Head's code to its acceptance check. */
export const checkTriesOf = (run: Pick<HeadRun, 'marks'>): number => (run.marks ?? []).filter(mark => mark.kind === 'check').length
