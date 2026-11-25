/**
 * @author Shakib
 * @since 18/10/26
 */
import type { EngineInterface } from 'claude-code'

import { DEFAULT_EFFORT, HEAD_EFFORTS } from './effort'
import { relativeTo } from './format'
import { platformOf, realPaths } from './platform'

/** How many times a Head is sent back after a failed check before Hydra hands the failure to the Lead. */
export const CHECK_FIX_ROUNDS = 2

/** `$.process.run` waits ten minutes at most, so a check can never run longer. */
export const CHECK_MAX_MINUTES = 10
export const CHECK_DEFAULT_MINUTES = 10

const TAIL_LINES = 60
const TAIL_CHARS = 4_000
const FAILURE_LINES = 20
const FAILURE_LINE = /\b(fail(ed|ure)?|error|panic)\b|✗|\bFAIL\b/i

export type CheckOutcome =
  | { kind: 'passed'; seconds: number }
  | { kind: 'failed'; exitCode: number; tail: string; seconds: number }
  /** The check did not get to judge the code: it could not start, timed out or its command was not found. Never retried. */
  | { kind: 'unknown'; reason: string; tail: string }

/** The last lines of what the check printed, colours stripped and capped: it goes to the Head's model, so keep it short. */
export const checkTail = (stdout: string, stderr: string) => {
  const text = [stdout, stderr].filter(part => part.trim()).join('\n')
  const plain = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n')
  const lines = plain.trimEnd().split('\n')
  const tail = lines.slice(-TAIL_LINES).join('\n').slice(-TAIL_CHARS)
  // A test runner's summary is last, its failing test names earlier: keep those lines from the cut part.
  const failures = lines.slice(0, -TAIL_LINES).filter(line => FAILURE_LINE.test(line)).slice(0, FAILURE_LINES).map(line => line.slice(0, 200))
  return failures.length > 0 ? `${failures.join('\n')}\n[…]\n${tail}`.slice(-(TAIL_CHARS + FAILURE_LINES * 200)) : tail
}

/** Exit 0 passes; 126 and 127 mean the shell could not run the command (not executable, not found), which judges nothing. */
export const outcomeOf = (ran: { exitCode: number; stdout: string; stderr: string }, seconds: number): CheckOutcome => {
  const tail = checkTail(ran.stdout, ran.stderr)
  if (ran.exitCode === 0) return { kind: 'passed', seconds }
  if (ran.exitCode === 126 || ran.exitCode === 127) return { kind: 'unknown', reason: `the shell could not run it (exit ${ran.exitCode})`, tail }
  const output = `${ran.stdout}\n${ran.stderr}`
  const reason = ran.exitCode === 137 || /OutOfMemoryError|Java heap space|GC overhead limit exceeded|Cannot allocate memory/i.test(output) || /^(?:.*: )?Killed(?::.*)?$/m.test(output) ? 'out of memory'
    : /(?:Gradle|Kotlin).*daemon[^\n]*(?:disappeared|crash|died|terminated)|daemon[^\n]*(?:disappeared|crash|died|terminated)[^\n]*(?:Gradle|Kotlin)/i.test(output) ? 'daemon disappeared or crashed'
    : /No space left on device/i.test(output) ? 'no space left on device'
    : /Too many open files/i.test(output) ? 'too many open files' : ''
  if (reason) return { kind: 'unknown', reason: `environment: ${reason}`, tail }
  if (!ran.stdout && !ran.stderr) return { kind: 'unknown', reason: 'the check printed nothing', tail }
  return { kind: 'failed', exitCode: ran.exitCode, tail, seconds }
}

export const checkMinutesOf = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, CHECK_MAX_MINUTES) : CHECK_DEFAULT_MINUTES

/** Runs the check in `cwd` through the shell, as the person, outside every Head's lockdown. */
const checkQueues = new Map<string, Promise<void>>()

export async function runCheck($: EngineInterface, check: string, cwd: string, minutes: number, options?: { signal?: AbortSignal; onWait?: () => Promise<void>; onStart?: () => Promise<void> }): Promise<CheckOutcome> {
  const git = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 10_000 }).catch(() => undefined)
  const folder = git?.exitCode === 0 && git.stdout.trim() ? git.stdout.trim() : cwd
  const key = (await realPaths($, [folder]))[0] ?? folder
  const previous = checkQueues.get(key)
  let release = () => {}
  const current = new Promise<void>(resolve => { release = resolve })
  const queued = previous ? previous.then(() => current) : current
  checkQueues.set(key, queued)
  try {
    if (previous) {
      await options?.onWait?.()
      const signal = options?.signal
      if (signal && !signal.aborted) {
        let stopped = () => {}
        const aborted = new Promise<void>(resolve => { stopped = resolve; signal.addEventListener('abort', stopped, { once: true }) })
        try { await Promise.race([previous, aborted]) } finally { signal.removeEventListener('abort', stopped) }
      } else if (!signal) await previous
    }
    if (options?.signal?.aborted) return { kind: 'unknown', reason: 'the Head was stopped', tail: '' }
    if (previous) await options?.onStart?.()
    const argv = (await platformOf($)) === 'windows' ? ['cmd', '/d', '/s', '/c', check] : ['/bin/sh', '-c', check]
    const startedAt = await $.clock.now()
    const ran = await $.process.run(argv, { cwd, timeoutMs: Math.round(minutes * 60_000) }).catch((error: unknown) => error as Error)
    const seconds = Math.round(((await $.clock.now()) - startedAt) / 1000)
    if (ran instanceof Error || !ran) return { kind: 'unknown', reason: `it did not finish within ${minutes} min or could not start (${String(ran).slice(0, 120)})`, tail: '' }
    return outcomeOf(ran, seconds)
  } finally {
    release()
    if (checkQueues.get(key) === queued) checkQueues.delete(key)
  }
}

/** One level up from the Lead's pick for the next try; the person's fixed level still wins inside each engine. */
export const raisedEffort = (effort: string | undefined) => {
  const levels = HEAD_EFFORTS as readonly string[]
  const at = levels.indexOf(effort ?? DEFAULT_EFFORT)
  return levels[Math.min(at < 0 ? 0 : at + 1, levels.length - 1)]
}

/** What the Head is told when it goes back: the check, what it printed, and that the files it changed are still there. */
export const fixNote = (check: string, outcome: Extract<CheckOutcome, { kind: 'failed' }>, files: readonly string[], named: readonly string[] = [], task = '') => {
  const rules = task.split(/\n|(?<=[.!?])\s+/).map(rule => rule.trim()).filter(rule => /\b(?:do not|don't|never|only|must not)\b/i.test(rule)).slice(0, 8)
  return `\n\nYour previous attempt ended, but the acceptance check failed. Check: \`${check}\` (exit ${outcome.exitCode}). Its last output:\n\`\`\`\n${outcome.tail || '(no output)'}\n\`\`\`\nFiles already changed: ${files.length > 0 ? files.join(', ') : 'none recorded'}.${named.length ? ` Only change these task files: ${named.join(', ')}.` : ''}${rules.length ? ` Original task rules:\n${rules.map(rule => `"${rule}"`).join('\n')}` : ''}\nFix the code so the check passes. Do not weaken, skip or delete tests or the check to get there. If passing the check would break these rules, stop and say so instead (HEAD BLOCKED); do not edit outside them. Hydra runs the check again when you finish: you need not run it yourself.`
}

/** What a Head is told about its check before it starts: Hydra runs it, so the Head neither has to nor has to wait for it. */
export const checkNote = (check: string) =>
  `\n\nAcceptance check: when you finish, Hydra runs \`${check.slice(0, 300)}\` itself, outside your sandbox, and sends you back with its output if it fails. You do not have to run it, and if you cannot, do not wait for it or ask for its result: finish the work and end your report.`

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
/** What `checkHead` reads of a Head's result. */
export type Checked = { text: string; isDone: boolean; files?: string[]; ending?: string }

/** Endings where the work may still be whole: the Head stopped on its own limits, not on a refusal or a failure. */
const UNFINISHED_BUT_CHECKABLE = new Set(['stalled', 'capped', 'timeout', 'blocked'])

/** A finished Head is checked, and so is one that ran out of turns, time or words after editing files: the check, not the Head, says whether the work is done. */
export const isCheckable = (result: Checked) =>
  result.isDone || (UNFINISHED_BUT_CHECKABLE.has(result.ending ?? '') && (result.files?.length ?? 0) > 0)

const UNFINISHED_PASS = 'the Head did not report HEAD DONE, but the check passed: read its last message for what it left undone'

export type CheckSteps<R extends Checked> = {
  check: string
  cwd: string
  /** The Head's whole time budget, in minutes: fix rounds only start while some of it is left. */
  minutes: number
  effort?: string
  task?: string
  files?: readonly string[]
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
 * one effort level up, up to `CHECK_FIX_ROUNDS` times. A Head that ran out of turns or time, or stalled, after editing
 * files is checked too (`isCheckable`): the check's verdict counts for more than the missing HEAD DONE. A check that
 * could not judge the code (no start, a timeout, command not found) is UNKNOWN and never retried, and a Head that was
 * stopped or failed is never checked. A blocked Head is checked but never sent back. Returns every try's report and files and the check lines in its
 * report, and the final outcome (none when the check never ran).
 */
export async function checkHead<R extends Checked>(steps: CheckSteps<R>): Promise<{ result: R; outcome?: CheckOutcome }> {
  const startedAt = await steps.now()
  const edited: string[] = []
  const outside: string[] = []
  const warnings = () => outside.length ? [`⚠ the fix round changed files outside \`files\`: ${outside.join(', ')}`] : []
  const tries: CheckOutcome[] = []
  let effort = steps.effort
  const efforts = [effort ?? DEFAULT_EFFORT]
  let result = await steps.run()
  const reports = [result.text]
  const report = () => reports.map((text, index) => index === 0 ? text : `--- fix round ${index} ---\n${text}`).join('\n')
  const effortLines = () => efforts.length > 1 ? [`effort: ${efforts.join(' → ')} (raised after each failed check)`] : []
  for (;;) {
    for (const file of result.files ?? []) if (!edited.includes(file)) edited.push(file)
    if (!isCheckable({ ...result, files: edited }) || steps.isAborted()) {
      const line = tries.length > 0 ? `✗ FAILED earlier, and the Head did not finish its fix round` : 'not run: the Head did not finish'
      return { result: { ...result, files: edited, text: withSummary(report(), [`check: \`${steps.check}\` ${line}`, ...warnings(), ...effortLines()]) }, outcome: tries.at(-1) }
    }
    await steps.onStep?.(`check: ${steps.check}`)
    const outcome = await steps.runCheck()
    tries.push(outcome)
    const minutesLeft = steps.minutes - Math.floor(((await steps.now()) - startedAt) / 60_000)
    if (outcome.kind !== 'failed' || result.ending === 'blocked' || tries.length > CHECK_FIX_ROUNDS || minutesLeft < 1 || steps.isAborted()) {
      const lines = checkLines(steps.check, outcome, tries, outcome.kind === 'unknown' ? [] : checkedEdits(steps.check, edited, steps.cwd))
      lines.push(...warnings())
      lines.push(...effortLines())
      if (outcome.kind === 'passed' && !result.isDone) lines.push(result.ending === 'blocked' ? '⚠ the Head said it was blocked, but the check passed' : `⚠ ${UNFINISHED_PASS}`)
      return { result: { ...result, ...(outcome.kind === 'passed' && result.ending === 'blocked' ? { isDone: true } : {}), files: edited, text: withSummary(report(), lines, outcome.kind === 'passed' ? undefined : outcome.tail) }, outcome }
    }
    const nextEffort = raisedEffort(effort)
    if (nextEffort && nextEffort !== (effort ?? DEFAULT_EFFORT)) efforts.push(nextEffort)
    effort = nextEffort
    await steps.onStep?.(`check failed (exit ${outcome.exitCode}): sending it back`)
    result = await steps.run({ note: fixNote(steps.check, outcome, edited.map(file => relativeTo(steps.cwd, file)), steps.files, steps.task), effort, minutes: minutesLeft })
    if (steps.files?.length) for (const file of result.files ?? []) {
      const rel = relativeTo(steps.cwd, file).replace(/^\.\//, '')
      if (!steps.files.some(named => rel === relativeTo(steps.cwd, named).replace(/^\.\//, '')) && !outside.includes(rel)) outside.push(rel)
    }
    reports.push(result.text)
  }
}
