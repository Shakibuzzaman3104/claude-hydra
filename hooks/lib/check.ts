/**
 * @author Shakib
 * @since 18/10/26
 */
import type { EngineInterface } from 'claude-code'

import { DEFAULT_EFFORT, HEAD_EFFORTS } from './effort'
import { relativeTo } from './format'
import { platformOf } from './platform'

/** How many times a Head is sent back after a failed check before Hydra hands the failure to the Lead. */
export const CHECK_FIX_ROUNDS = 2

/** `$.process.run` waits ten minutes at most, so a check can never run longer. */
export const CHECK_MAX_MINUTES = 10
export const CHECK_DEFAULT_MINUTES = 10

const TAIL_LINES = 60
const TAIL_CHARS = 4_000

export type CheckOutcome =
  | { kind: 'passed'; seconds: number }
  | { kind: 'failed'; exitCode: number; tail: string; seconds: number }
  /** The check did not get to judge the code: it could not start, timed out or its command was not found. Never retried. */
  | { kind: 'unknown'; reason: string; tail: string }

/** The last lines of what the check printed, colours stripped and capped: it goes to the Head's model, so keep it short. */
export const checkTail = (stdout: string, stderr: string) => {
  const text = [stdout, stderr].filter(part => part.trim()).join('\n')
  const plain = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n')
  return plain.trimEnd().split('\n').slice(-TAIL_LINES).join('\n').slice(-TAIL_CHARS)
}

/** Exit 0 passes; 126 and 127 mean the shell could not run the command (not executable, not found), which judges nothing. */
export const outcomeOf = (ran: { exitCode: number; stdout: string; stderr: string }, seconds: number): CheckOutcome => {
  const tail = checkTail(ran.stdout, ran.stderr)
  if (ran.exitCode === 0) return { kind: 'passed', seconds }
  if (ran.exitCode === 126 || ran.exitCode === 127) return { kind: 'unknown', reason: `the shell could not run it (exit ${ran.exitCode})`, tail }
  return { kind: 'failed', exitCode: ran.exitCode, tail, seconds }
}

export const checkMinutesOf = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, CHECK_MAX_MINUTES) : CHECK_DEFAULT_MINUTES

/** Runs the check in `cwd` through the shell, as the person, outside every Head's lockdown. */
export async function runCheck($: EngineInterface, check: string, cwd: string, minutes: number): Promise<CheckOutcome> {
  const argv = (await platformOf($)) === 'windows' ? ['cmd', '/d', '/s', '/c', check] : ['/bin/sh', '-c', check]
  const startedAt = await $.clock.now()
  const ran = await $.process.run(argv, { cwd, timeoutMs: Math.round(minutes * 60_000) }).catch((error: unknown) => error as Error)
  const seconds = Math.round(((await $.clock.now()) - startedAt) / 1000)
  if (ran instanceof Error || !ran) return { kind: 'unknown', reason: `it did not finish within ${minutes} min or could not start (${String(ran).slice(0, 120)})`, tail: '' }
  return outcomeOf(ran, seconds)
}

/** One level up from the Lead's pick for the next try; the person's fixed level still wins inside each engine. */
export const raisedEffort = (effort: string | undefined) => {
  const levels = HEAD_EFFORTS as readonly string[]
  const at = levels.indexOf(effort ?? DEFAULT_EFFORT)
  return levels[Math.min(at < 0 ? 0 : at + 1, levels.length - 1)]
}

/** What the Head is told when it goes back: the check, what it printed, and that the files it changed are still there. */
export const fixNote = (check: string, outcome: Extract<CheckOutcome, { kind: 'failed' }>, files: readonly string[]) =>
  `\n\nYour previous attempt finished, but the acceptance check failed. Check: \`${check}\` (exit ${outcome.exitCode}). Its last output:\n\`\`\`\n${outcome.tail || '(no output)'}\n\`\`\`\nFiles already changed: ${files.length > 0 ? files.join(', ') : 'none recorded'}. Fix the code so the check passes. Do not weaken, skip or delete tests or the check to get there.`

/** Build and test files: when the Head changed one, the check ran code the Head wrote, and a pass proves less. */
const RUNS_CODE = [
  /(^|\/)(tests?|__tests__|spec|specs|androidTest|testDebug|testRelease|Tests)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i, /(Test|Tests|Spec)\.(kt|kts|java|swift|scala|cs)$/, /(^|\/)test_[^/]*\.py$/, /_test\.(py|go|rb|exs?)$/, /(^|\/)conftest\.py$/,
  /(^|\/)(build|settings)\.gradle(\.kts)?$/, /(^|\/)gradlew(\.bat)?$/, /(^|\/)gradle\/wrapper\//, /(^|\/)gradle\.properties$/,
  /(^|\/)package\.json$/, /(^|\/)(jest|vitest|playwright|karma|babel)\.config\.[cm]?[jt]s$/, /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)(Makefile|makefile|CMakeLists\.txt|Rakefile|Gemfile|Justfile|justfile)$/, /(^|\/)(pom\.xml|Package\.swift|Cargo\.toml|go\.mod|pyproject\.toml|setup\.py|setup\.cfg|tox\.ini|pytest\.ini|noxfile\.py)$/,
  /\.(sh|bash|zsh|ps1|bat|cmd)$/i,
]

/** The edited files a check may have run: build and test files, and any file the check command names. */
export const checkedEdits = (check: string, files: readonly string[], cwd: string) =>
  files.map(file => relativeTo(cwd, file)).filter(rel => {
    const name = rel.split('/').pop() ?? rel
    return RUNS_CODE.some(pattern => pattern.test(rel)) || (name.length > 2 && check.includes(name))
  })

/** Hydra's own lines about the check: the verdict, every try, and a warning when the check ran code the Head changed. */
export const checkLines = (check: string, outcome: CheckOutcome, rounds: readonly CheckOutcome[], edits: readonly string[]) => {
  const label = outcome.kind === 'passed' ? `✓ passed (${outcome.seconds}s)`
    : outcome.kind === 'failed' ? `✗ FAILED, exit ${outcome.exitCode} (${outcome.seconds}s)`
    : `? UNKNOWN, ${outcome.reason}: run it yourself`
  const lines = [`check: \`${check}\` ${label}${rounds.length > 1 ? ` · ${rounds.length} tries: ${rounds.map(round => (round.kind === 'passed' ? '✓' : round.kind === 'failed' ? '✗' : '?')).join(' ')}` : ''}`]
  if (edits.length > 0) lines.push(`⚠ the check ran code this Head changed (${edits.join(', ')}): read those changes before trusting the result`)
  return lines
}

const MARKER = '\n--- head report ---'

/**
 * Puts Hydra's check lines at the end of the report's summary, above the Head's own text, and what the check printed at the
 * very end: the check ran code the Head may have written, so its output is framed as data with the Head's report.
 */
export const withSummary = (report: string, lines: readonly string[], output?: string) => {
  const at = report.indexOf(MARKER)
  const summary = at < 0 ? report : report.slice(0, at)
  const rest = at < 0 ? '' : report.slice(at)
  return `${summary}\n${lines.join('\n')}${rest}${output ? `\n--- check output (last lines) ---\n${output}` : ''}`
}

/** The steps `checkHead` takes, wired by the caller to the engine, the run record and the clock. */
export type CheckSteps<R extends { text: string; isDone: boolean; files?: string[] }> = {
  check: string
  cwd: string
  /** The Head's whole time budget, in minutes: fix rounds only start while some of it is left. */
  minutes: number
  effort?: string
  /** Runs the Head: the first time as asked, then with a fix note added to the task, a raised effort and the minutes left. */
  run: (change?: { note: string; effort?: string; minutes: number }) => Promise<R>
  runCheck: () => Promise<CheckOutcome>
  now: () => Promise<number>
  isAborted: () => boolean
  /** Called before each check runs and before each fix round. */
  onStep?: (activity: string) => Promise<void>
}

/**
 * A Head with an acceptance check: once it finishes, the check runs; a failure sends it back with the check's output,
 * one effort level up, up to `CHECK_FIX_ROUNDS` times. A check that could not judge the code (no start, a timeout,
 * command not found) is UNKNOWN and never retried, and a Head that did not finish is never checked. Returns the last
 * run with every try's files and the check lines in its report, and the final outcome (none when the check never ran).
 */
export async function checkHead<R extends { text: string; isDone: boolean; files?: string[] }>(steps: CheckSteps<R>): Promise<{ result: R; outcome?: CheckOutcome }> {
  const startedAt = await steps.now()
  const edited: string[] = []
  const tries: CheckOutcome[] = []
  let effort = steps.effort
  let result = await steps.run()
  for (;;) {
    for (const file of result.files ?? []) if (!edited.includes(file)) edited.push(file)
    if (!result.isDone || steps.isAborted()) {
      const line = tries.length > 0 ? `✗ FAILED earlier, and the Head did not finish its fix round` : 'not run: the Head did not finish'
      return { result: { ...result, files: edited, text: withSummary(result.text, [`check: \`${steps.check}\` ${line}`]) }, outcome: tries.at(-1) }
    }
    await steps.onStep?.(`check: ${steps.check}`)
    const outcome = await steps.runCheck()
    tries.push(outcome)
    const minutesLeft = steps.minutes - Math.floor(((await steps.now()) - startedAt) / 60_000)
    if (outcome.kind !== 'failed' || tries.length > CHECK_FIX_ROUNDS || minutesLeft < 1 || steps.isAborted()) {
      const lines = checkLines(steps.check, outcome, tries, outcome.kind === 'unknown' ? [] : checkedEdits(steps.check, edited, steps.cwd))
      return { result: { ...result, files: edited, text: withSummary(result.text, lines, outcome.kind === 'passed' ? undefined : outcome.tail) }, outcome }
    }
    effort = raisedEffort(effort)
    await steps.onStep?.(`check failed (exit ${outcome.exitCode}): sending it back`)
    result = await steps.run({ note: fixNote(steps.check, outcome, edited.map(file => relativeTo(steps.cwd, file))), effort, minutes: minutesLeft })
  }
}
