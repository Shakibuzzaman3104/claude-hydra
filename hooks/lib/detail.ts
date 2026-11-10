/**
 * @author Shakib
 * @since 10/11/26
 */
import type { HeadRun } from '../../types'
import type { Engine } from './engines'
import { capOf, progressOf, stopLine } from './format'

/** A single file row in a Head's checklist. */
export type ChecklistRow = { mark: '✓' | '·' | '+'; file: string; stat: string }

/** File checklist for a Head, marking expected and extra touched files. */
export const checklistOf = (run: Pick<HeadRun, 'expected' | 'touched' | 'files' | 'stats'>): ChecklistRow[] => {
  const written = [...new Set([...(run.files ?? []), ...(run.touched ?? [])])]
  const writtenSet = new Set(written)
  const statOf = (file: string) => run.stats?.[file] ?? ''
  if ((run.expected ?? []).length > 0) {
    const expected = run.expected ?? []
    const expectedSet = new Set(expected)
    const expectedRows: ChecklistRow[] = expected.map(file => ({
      mark: writtenSet.has(file) ? '✓' : '·',
      file,
      stat: statOf(file),
    }))
    const extraRows: ChecklistRow[] = written
      .filter(file => !expectedSet.has(file))
      .map(file => ({
        mark: '+',
        file,
        stat: statOf(file),
      }))
    return [...expectedRows, ...extraRows]
  }
  return written.map(file => ({
    mark: '✓',
    file,
    stat: statOf(file),
  }))
}

/** Formats a checklist row into a single readable line. */
export const checklistText = (row: ChecklistRow): string =>
  row.stat ? `${row.mark} ${row.file} ${row.stat}` : `${row.mark} ${row.file}`

/** The next step command or guidance when a failed Head can be continued. */
export const nextStepOf = (run: HeadRun): string | undefined => {
  if (run.state !== 'failed') return undefined
  return stopLine({
    id: run.id,
    ending: run.ending,
    cap: capOf(run),
    maxTurns: run.maxTurns,
    sessionId: run.sessionId,
    engine: run.engine as Engine | undefined,
    files: run.files ?? [],
  })
}

/** Short title for a Head task, derived from its first sentence or line. */
export const taskTitle = (task: string): string => {
  const line = task.split('\n').map(entry => entry.trim()).find(entry => entry.length > 0)
  if (!line) return ''
  const stripped = line.replace(/^(?:goal|task):\s*/i, '').trim()
  const dotIndex = stripped.indexOf('. ')
  if (dotIndex >= 0) return stripped.slice(0, dotIndex)
  return stripped.replace(/\.$/, '')
}

/** The sum of files completed and total expected across all runs with measured progress. */
export const sessionProgress = (runs: readonly HeadRun[]): { done: number; total: number } | undefined => {
  let done = 0
  let total = 0
  let hasAny = false
  for (const run of runs) {
    const prog = progressOf(run)
    if (prog) {
      done += prog.done
      total += prog.total
      hasAny = true
    }
  }
  return hasAny ? { done, total } : undefined
}

/** Formats session-wide file progress as `done/total files`. */
export const sessionProgressText = (runs: readonly HeadRun[]): string => {
  const prog = sessionProgress(runs)
  return prog ? `${prog.done}/${prog.total} files` : ''
}

/** A single labeled or plain line from a Head's summary report. */
export type ReportLine = { label: string; text: string }

/** Parses a Head report summary into structured report lines. */
export const reportLines = (summary: string, max = 40): ReportLine[] => {
  const lines = summary.split('\n').filter(line => line.trim().length > 0).slice(0, max)
  const labels = ['Not done', 'Done', 'Changed', 'Unverified', 'Notes', 'Next step'] as const
  const labelRegex = new RegExp(`^[\\s\\-*#]*(?:\\*\\*)?(${labels.join('|')})(?:\\*\\*)?:(.*)$`)
  return lines.map(line => {
    const match = labelRegex.exec(line)
    if (match) {
      const label = match[1]!
      const text = match[2]!.trim().replace(/^\*\*|\*\*$/g, '').trim()
      return { label, text }
    }
    return { label: '', text: line.replace(/\s+$/, '') }
  })
}
