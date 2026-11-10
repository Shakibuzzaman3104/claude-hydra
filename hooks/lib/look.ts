/**
 * @author Shakib
 * @since 10/11/26
 */
import type { HeadRun } from '../../types'
import { CHECK_FIX_ROUNDS } from './check'
import { canResume, capOf, glyphOf, progressOf } from './format'

/** How many times a Head's check can run: the first try plus every fix round. */
export const CHECK_TRIES = CHECK_FIX_ROUNDS + 1

/** A Head's glyph and colour in the views. */
export type Look = { glyph: string; color: 'cyan' | 'green' | 'yellow' | 'red' | undefined }

/** Whether a Head stopped on a limit and can be continued, so the Lead must act on it. */
export const needsLead = (run: HeadRun): boolean =>
  run.state === 'failed' &&
  run.check?.state !== 'failed' &&
  (run.ending === 'blocked' || run.ending === 'capped' || run.ending === 'timeout' || run.ending === 'stalled')

/** How a Head looks in the views: its glyph and colour, from its state and how it ended. */
export const lookOf = (run: HeadRun, frame: number): Look => {
  if (run.state === 'queued') return { glyph: '◌', color: undefined }
  if (run.state === 'running') {
    if (run.check?.state === 'running') return { glyph: '⚙', color: 'cyan' }
    if (run.check?.state === 'fixing') return { glyph: glyphOf(run, frame), color: 'yellow' }
    return { glyph: glyphOf(run, frame), color: 'cyan' }
  }
  if (run.state === 'done') return { glyph: '✓', color: 'green' }
  if (run.check?.state === 'failed') return { glyph: '✗', color: 'red' }
  switch (run.ending) {
    case 'blocked': return { glyph: '◆', color: 'yellow' }
    case 'capped':
    case 'timeout': return { glyph: '◷', color: 'yellow' }
    case 'stalled': return { glyph: '≈', color: 'yellow' }
    case 'stopped': return { glyph: '■', color: undefined }
    default: return { glyph: '✗', color: 'red' }
  }
}

/** How a Head's state reads in one word, naming the check or the ending when it matters. */
export const endingWord = (run: HeadRun): string => {
  if (run.state === 'queued') return 'queued'
  if (run.state === 'running') {
    if (run.check?.state === 'running') return 'checking'
    if (run.check?.state === 'fixing') return 'fixing'
    return 'running'
  }
  if (run.state === 'done') return 'done'
  if (run.check?.state === 'failed') return 'check failed'
  switch (run.ending) {
    case 'blocked': return 'blocked'
    case 'capped': return capOf(run) === 'round' ? 'out of rounds' : 'out of turns'
    case 'timeout': return 'out of time'
    case 'stalled': return 'stalled'
    case 'stopped': return 'stopped'
    default: return 'failed'
  }
}

/** What a blocked Head needs, as the first meaningful line of its summary. */
export const needOf = (run: HeadRun): string => {
  const line = (run.summary ?? '').split('\n').find(entry => entry.trim() !== '')
  if (!line) return 'see its report'
  const text = line
    .trim()
    .replace(/^[-*•] /, '')
    .replace(/^blocked:/i, '')
    .trim()
  return text || 'see its report'
}

/** The text after the elapsed time on a Head's row: what it is doing or how it ended. */
export const rowLine = (run: HeadRun): string => {
  const check = run.check
  if (run.state === 'queued') return run.activity ?? 'queued'
  if (run.state === 'running') {
    if (check?.state === 'running') {
      const command = (run.activity ?? '').replace(/^check: /, '')
      return command ? `check ${check.tries}/${CHECK_TRIES} · ${command}` : `check ${check.tries}/${CHECK_TRIES}`
    }
    if (check?.state === 'fixing') return `fix round ${check.tries}/${CHECK_FIX_ROUNDS} · ${run.activity ?? 'working'}`
    return run.activity ?? 'running'
  }
  if (run.state === 'done') {
    const progress = progressOf(run)
    return [
      'done',
      progress ? `${progress.done}/${progress.total} files` : '',
      check?.state === 'passed' ? 'check ✓' : check?.state === 'unknown' ? 'check ?' : '',
      run.costUsd !== undefined ? `$${run.costUsd.toFixed(4)}` : run.tokens ?? '',
    ].filter(Boolean).join(' · ')
  }
  if (check?.state === 'failed') return `check ✗ failed after ${check.tries} ${check.tries === 1 ? 'try' : 'tries'}`
  const again = canResume(run) ? `resume: "${run.id}"` : 'needs a new Head'
  if (run.ending === 'blocked') return `blocked · ${needOf(run)}`
  if (run.ending === 'capped') return `out of ${capOf(run) === 'round' ? 'rounds' : 'turns'} · ${again}`
  if (run.ending === 'timeout') return `out of time · ${again}`
  if (run.ending === 'stalled') return (run.files?.length ?? 0) > 0 || (run.touched?.length ?? 0) > 0 ? 'stalled · read its diff' : 'stalled · no edits'
  return run.activity ?? 'failed'
}

/** The Heads' counts in one line: what runs, what finished, what to continue and what failed. */
export const headsSummaryOf = (list: readonly HeadRun[]): string => {
  const running = list.filter(run => run.state === 'running').length
  const queued = list.filter(run => run.state === 'queued').length
  const done = list.filter(run => run.state === 'done').length
  const toContinue = list.filter(run => needsLead(run)).length
  const failed = list.filter(run => run.state === 'failed' && !needsLead(run)).length
  return [
    running > 0 ? `${running} running` : '',
    queued > 0 ? `${queued} queued` : '',
    done > 0 ? `${done} done` : '',
    toContinue > 0 ? `${toContinue} to continue` : '',
    failed > 0 ? `${failed} failed` : '',
  ].filter(Boolean).join(' · ')
}
