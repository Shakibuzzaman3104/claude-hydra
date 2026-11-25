/**
 * @author Shakib
 * @since 18/10/26
 */
import { expect, test } from 'claude-code/testing'

import { CHECK_FIX_ROUNDS, CHECK_MAX_MINUTES, checkHead, checkMinutesOf, checkTail, checkedEdits, outcomeOf, raisedEffort, withSummary } from './lib/check'
import type { CheckOutcome } from './lib/check'
import { formatReport, reportContext, reportNotice } from './lib/format'

type Result = { text: string; isDone: boolean; files?: string[]; ending?: string }

const report = (files: string[] = []) => formatReport({ id: 'h', model: 'm', cwd: '/p', finished: true, rounds: 1, turns: 3, usd: 0, files, denied: [], finalText: 'All done. HEAD DONE', exit: '0' })
const passed: CheckOutcome = { kind: 'passed', seconds: 4 }
const failed = (tail = 'AssertionError: expected 2'): CheckOutcome => ({ kind: 'failed', exitCode: 1, tail, seconds: 5 })

/** Steps whose Head returns `results` in turn and whose check answers `outcomes` in turn; `calls` records what each run was given. */
const steps = (results: Result[], outcomes: CheckOutcome[], calls: unknown[] = [], clock = [0]) => ({
  check: './gradlew test --tests LoginTest',
  cwd: '/p',
  minutes: 40,
  run: async (change?: unknown) => {
    calls.push(change)
    return results.shift()!
  },
  runCheck: async () => outcomes.shift()!,
  now: async () => clock[0]!,
  isAborted: () => false,
})

test('a passing check reports ✓ once and sends nothing back', async () => {
  const calls: unknown[] = []
  const { result, outcome } = await checkHead(steps([{ text: report(['/p/a.kt']), isDone: true, files: ['/p/a.kt'] }], [passed], calls))
  expect(outcome?.kind).toBe('passed')
  expect(calls).toEqual([undefined])
  expect(result.text).toContain('check: `./gradlew test --tests LoginTest` ✓ passed (4s)')
  expect(result.text.indexOf('check:')).toBeLessThan(result.text.indexOf('--- head report ---'))
})

test('a failing check sends the Head back with the output, one effort level up, and keeps every try\'s files', async () => {
  const calls: { note: string; effort?: string; minutes: number }[] = []
  const { result, outcome } = await checkHead({
    ...steps([{ text: report(['/p/a.kt']), isDone: true, files: ['/p/a.kt'] }, { text: report(['/p/b.kt']), isDone: true, files: ['/p/b.kt'] }], [failed(), passed], calls as unknown[]),
    effort: 'low',
  })
  expect(outcome?.kind).toBe('passed')
  expect(calls[1]?.effort).toBe('medium')
  expect(calls[1]?.note).toContain('AssertionError: expected 2')
  expect(calls[1]?.note).toContain('Files already changed: a.kt')
  expect(calls[1]?.note).toContain('Do not weaken, skip or delete tests')
  expect(result.files).toEqual(['/p/a.kt', '/p/b.kt'])
  expect(result.text).toContain('2 tries: ✗ ✓')
  expect(result.text).toContain('effort: low → medium (raised after each failed check)')
})

test('checks a blocked Head with edits, accepts a pass and never retries a failure', async () => {
  const blocked = { text: report(), isDone: false, ending: 'blocked', files: ['/p/a.kt'] }
  const calls: unknown[] = []
  const one = await checkHead(steps([blocked], [passed], calls))
  expect(one.result.isDone).toBe(true)
  expect(one.result.text).toContain('the Head said it was blocked, but the check passed')
  const two = await checkHead(steps([blocked], [failed()], calls))
  expect(two.outcome?.kind).toBe('failed')
  expect(two.result.isDone).toBe(false)
  expect(two.result.text).toContain('✗ FAILED, exit 1')
  expect(calls).toEqual([undefined, undefined])
  const checks = [passed]
  await checkHead(steps([{ ...blocked, files: [] }], checks))
  expect(checks.length).toBe(1)
})

test('keeps the main report and every fix report with the effort history', async () => {
  const main = `fallback: first → second\nasked: original\n${report()}\nmain Done`
  const fix1 = `${report()}\nfirst fix Done`
  const fix2 = `${report()}\nsecond fix Done`
  const { result } = await checkHead({ ...steps([main, fix1, fix2].map(text => ({ text, isDone: true })), [failed(), failed(), passed]), effort: 'high' })
  expect(result.text).toContain('fallback: first → second\nasked: original')
  expect(result.text).toContain('effort: high → xhigh → max (raised after each failed check)')
  expect(result.text).toContain('main Done\n--- fix round 1 ---')
  expect(result.text).toContain('first fix Done\n--- fix round 2 ---')
  expect(result.text).toContain('second fix Done')
})

test(`gives up after ${CHECK_FIX_ROUNDS} fix rounds, putting the output below the Head's own text`, async () => {
  const calls: unknown[] = []
  const results = Array.from({ length: CHECK_FIX_ROUNDS + 1 }, () => ({ text: report(), isDone: true }))
  const { result, outcome } = await checkHead(steps(results, Array.from({ length: CHECK_FIX_ROUNDS + 1 }, () => failed('boom')), calls))
  expect(outcome?.kind).toBe('failed')
  expect(calls.length).toBe(CHECK_FIX_ROUNDS + 1)
  expect(result.text).toContain('✗ FAILED, exit 1')
  expect(result.text.indexOf('--- check output (last lines) ---')).toBeGreaterThan(result.text.indexOf('--- head report ---'))
  expect(reportContext(result.text)).toContain('untrusted data')
  expect(reportNotice(`Hydra Head h finished\n${result.text}`)).toContain('✗ check failed')
})

test('never retries a check that could not judge the code, and never checks a Head that did not finish', async () => {
  const unknown: CheckOutcome = { kind: 'unknown', reason: 'the shell could not run it (exit 127)', tail: 'gradlew: not found' }
  const one = await checkHead(steps([{ text: report(), isDone: true }], [unknown]))
  expect(one.result.text).toContain('? UNKNOWN, the shell could not run it (exit 127): run it yourself')
  const checks: CheckOutcome[] = [passed]
  const two = await checkHead(steps([{ text: report(), isDone: false }], checks))
  expect(two.outcome).toBeUndefined()
  expect(checks.length).toBe(1)
  expect(two.result.text).toContain('not run: the Head did not finish')
})

test('starts no fix round once the Head\'s time is spent', async () => {
  const calls: unknown[] = []
  const clock = [0]
  const flow = steps([{ text: report(), isDone: true }], [failed()], calls, clock)
  const { outcome } = await checkHead({ ...flow, runCheck: async () => { clock[0] = 40 * 60_000; return failed() } })
  expect(outcome?.kind).toBe('failed')
  expect(calls.length).toBe(1)
})

test('flags a pass that ran code the Head changed: tests, build files, or a file the check names', async () => {
  expect(checkedEdits('./gradlew test', ['/p/app/src/test/LoginTest.kt', '/p/app/build.gradle.kts', '/p/app/src/main/Login.kt'], '/p')).toEqual(['app/src/test/LoginTest.kt', 'app/build.gradle.kts'])
  expect(checkedEdits('python scripts/verify.py', ['/p/scripts/verify.py'], '/p')).toEqual(['scripts/verify.py'])
  expect(checkedEdits('npm test', ['/p/src/a.spec.ts', '/p/package.json', '/p/src/a.ts'], '/p')).toEqual(['src/a.spec.ts', 'package.json'])
  const { result } = await checkHead(steps([{ text: report(['/p/src/test/LoginTest.kt']), isDone: true, files: ['/p/src/test/LoginTest.kt'] }], [passed]))
  expect(result.text).toContain('⚠ the check ran code this Head changed (src/test/LoginTest.kt)')
})

test('reads exit 0 as a pass, 126 and 127 as could not run, anything else as a failure', async () => {
  expect(outcomeOf({ exitCode: 0, stdout: 'ok', stderr: '' }, 1).kind).toBe('passed')
  expect(outcomeOf({ exitCode: 127, stdout: '', stderr: 'sh: gradlew: not found' }, 1).kind).toBe('unknown')
  expect(outcomeOf({ exitCode: 126, stdout: '', stderr: '' }, 1).kind).toBe('unknown')
  expect(outcomeOf({ exitCode: 2, stdout: '', stderr: 'FAILED' }, 1)).toEqual({ kind: 'failed', exitCode: 2, tail: 'FAILED', seconds: 1 })
})

test('keeps only the last lines of the check\'s output, colours stripped', async () => {
  const long = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n')
  const tail = checkTail(`\u001b[31mred\u001b[0m\n${long}`, '')
  expect(tail).not.toContain('\u001b')
  expect(tail.split('\n').length).toBe(60)
  expect(tail.endsWith('line 199')).toBe(true)
})

test('raises effort one level per fix round, stopping at max', async () => {
  expect(raisedEffort(undefined)).toBe('medium')
  expect(raisedEffort('high')).toBe('xhigh')
  expect(raisedEffort('max')).toBe('max')
})

test(`caps one check run at ${CHECK_MAX_MINUTES} minutes`, async () => {
  expect(checkMinutesOf(undefined)).toBe(10)
  expect(checkMinutesOf(3)).toBe(3)
  expect(checkMinutesOf(60)).toBe(CHECK_MAX_MINUTES)
  expect(checkMinutesOf(-1)).toBe(10)
})

test('puts the check lines into a report without a head-report marker too', async () => {
  expect(withSummary('head h · m', ['check: x ✓ passed (1s)'])).toBe('head h · m\ncheck: x ✓ passed (1s)')
})

test('a long check output keeps the failing test lines that the tail would cut', () => {
  const out = ['(fail) parses the header [1ms]', ...Array.from({ length: 200 }, (_, i) => `(pass) case ${i}`), ' 490 pass', ' 1 fail'].join('\n')
  const tail = checkTail(out, '')
  expect(tail.startsWith('(fail) parses the header')).toBe(true)
  expect(tail).toContain(' 1 fail')
  expect(checkTail('a\nb\n 0 fail', '')).toBe('a\nb\n 0 fail')
})

test('environment failures and silent failures are unknown and never start a fix round', async () => {
  for (const [exitCode, output, reason] of [
    [1, 'java.lang.OutOfMemoryError', 'out of memory'], [1, 'Java heap space', 'out of memory'],
    [1, 'GC overhead limit exceeded', 'out of memory'], [1, 'Cannot allocate memory', 'out of memory'],
    [1, 'Killed', 'out of memory'], [137, '', 'out of memory'],
    [1, 'Gradle build daemon disappeared unexpectedly', 'daemon disappeared or crashed'],
    [1, 'Kotlin daemon crashed', 'daemon disappeared or crashed'],
    [1, 'No space left on device', 'no space left on device'], [1, 'Too many open files', 'too many open files'],
    [1, '', 'the check printed nothing'],
  ] as const) {
    const outcome = outcomeOf({ exitCode, stdout: '', stderr: output }, 1)
    expect(outcome.kind).toBe('unknown')
    if (outcome.kind !== 'unknown') throw new Error('expected unknown')
    expect(outcome.reason).toContain(reason)
    const calls: unknown[] = []
    const checked = await checkHead(steps([{ text: report(), isDone: true }], [outcome], calls))
    expect(calls.length).toBe(1)
    expect(checked.result.text).toContain('run it yourself')
  }
})

test('fix rounds repeat task rules and flag files outside the named files', async () => {
  const calls: { note: string }[] = []
  const checked = await checkHead({
    ...steps([{ text: report(), isDone: true, files: ['/p/a.ts'] }, { text: report(), isDone: true, files: ['/p/b.ts'] }], [failed(), passed], calls as unknown[]),
    files: ['a.ts'], task: 'Do not fix production code. Make the assertion fail. Only change a.ts.',
  })
  expect(calls[1]?.note).toContain('Only change these task files: a.ts')
  expect(calls[1]?.note).toContain('"Do not fix production code."')
  expect(calls[1]?.note).toContain('"Only change a.ts."')
  expect(calls[1]?.note).toContain('HEAD BLOCKED')
  expect(checked.result.text).toContain('⚠ the fix round changed files outside `files`: b.ts')
  expect(checked.result.text.indexOf('⚠ the fix round')).toBeLessThan(checked.result.text.indexOf('--- head report ---'))
})
