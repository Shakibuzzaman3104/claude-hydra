/**
 * @author Shakib
 * @since 10/11/26
 */
import { expect, test } from 'claude-code/testing'

import { checkHead, checkNote, fixNote, isCheckable } from './lib/check'
import type { CheckOutcome } from './lib/check'
import { applyEvent, clipReport, countsOf, editedCount, editedLine, expectedFiles, expectedMarks, formatReport, parseDiffStat, progressBar, progressOf, progressText, resumeTarget, scopeLines, stopLine, turnsOf, withEditStats, withEdits } from './lib/format'
import { BRIEF_RULE, HYDRA_POLICY, READ_RULE, REPORT_RULE } from './lib/policy'
import { createCallCounter, endActivity, exitOf, runRounds } from './lib/rounds'
import type { RoundsSteps } from './lib/rounds'
import { BLOCKED_MARK, DONE_MARK, HANDOFF_TURNS, HEAD_RULES, MAX_ROUNDS, STALL_ROUNDS, continuePrompt, endMark, followUpPrompt, handoffPrompt, isFinished, nudgePrompt, summaryOf } from './lib/runtime'
import type { Ending, HeadRun } from '../types'

type Script = { finalText: string; code?: number | null; subtype?: string; sessionId?: string | null; calls?: number; turns?: number; errors?: string }
type Options = { outer?: AbortSignal; resume?: string; mayResume?: () => boolean; sleep?: (ms: number, signal: AbortSignal) => Promise<unknown> }
type Spec = { prompt: string; maxTurns: number; resume?: string }

// Scripts runRounds: each runRound call logs its spec and returns the next scripted reply.
const scripted = (scripts: Script[], options: Options = {}) => {
  const log: Spec[] = []
  let callTotal = 0
  let turnTotal = 0
  let index = 0
  const runRound = async (spec: Spec) => {
    log.push(spec)
    const next: Script = scripts[index++] ?? { finalText: '' }
    callTotal += next.calls ?? 0
    turnTotal += next.turns ?? 1
    return {
      finalText: next.finalText,
      code: next.code === undefined ? 0 : next.code,
      subtype: next.subtype ?? 'success',
      sessionId: next.sessionId === null ? undefined : next.sessionId ?? 's1',
      errors: next.errors ?? '',
    }
  }
  const never = (ms: number, signal: AbortSignal) =>
    new Promise<unknown>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  const steps: RoundsSteps = {
    task: 'do it',
    maxTurns: 50,
    minutes: 40,
    outer: options.outer ?? new AbortController().signal,
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    runRound,
    turns: () => turnTotal,
    calls: () => callTotal,
    denied: () => [],
    sleep: options.sleep ?? never,
    ...(options.mayResume ? { mayResume: options.mayResume } : {}),
  }
  return { steps, log }
}

test('a first round that ends with HEAD DONE finishes the run at once', async () => {
  const { steps, log } = scripted([{ finalText: `all good\n${DONE_MARK}`, calls: 3 }])
  const result = await runRounds(steps)
  expect(result.ending).toBe('done')
  expect(result.rounds).toBe(1)
  expect(log.length).toBe(1)
  expect(log[0]!.prompt.startsWith('do it')).toBe(true)
  expect(log[0]!.prompt).toContain(HEAD_RULES)
})

test('a round without a mark is continued in the same session', async () => {
  const { steps, log } = scripted([{ finalText: 'still working', calls: 1 }, { finalText: DONE_MARK }])
  const result = await runRounds(steps)
  expect(result.ending).toBe('done')
  expect(result.rounds).toBe(2)
  expect(log[1]!.prompt).toBe(continuePrompt([]))
  expect(log[1]!.resume).toBe('s1')
})

test('a round with no tool call and no mark gets the nudge', async () => {
  const { steps, log } = scripted([{ finalText: 'thinking' }, { finalText: DONE_MARK, calls: 1 }])
  await runRounds(steps)
  expect(log[1]!.prompt).toBe(nudgePrompt([]))
})

test('two silent rounds in a row stop the run as stalled', async () => {
  const { steps, log } = scripted([{ finalText: 'thinking' }, { finalText: 'thinking aloud' }])
  const result = await runRounds(steps)
  expect(result.ending).toBe('stalled')
  expect(log.length).toBe(STALL_ROUNDS)
})

test('a round with tool calls resets the silent count', async () => {
  const { steps, log } = scripted([{ finalText: 'thinking' }, { finalText: 'working', calls: 1 }, { finalText: DONE_MARK, calls: 1 }])
  await runRounds(steps)
  expect(log[2]!.prompt).toBe(continuePrompt([]))
})

test('a round that ends with HEAD BLOCKED stops the run', async () => {
  const { steps, log } = scripted([{ finalText: `${BLOCKED_MARK}` }])
  const result = await runRounds(steps)
  expect(result.ending).toBe('blocked')
  expect(result.rounds).toBe(1)
  expect(log.length).toBe(1)
})

test('the mark written last decides, and only HEAD DONE finishes', async () => {
  expect(endMark(`${DONE_MARK} ... ${BLOCKED_MARK}`)).toBe('blocked')
  expect(endMark(`${BLOCKED_MARK} ... ${DONE_MARK}`)).toBe('done')
  expect(endMark('nothing')).toBeUndefined()
  expect(isFinished(DONE_MARK)).toBe(true)
  expect(isFinished(BLOCKED_MARK)).toBe(false)
  expect(isFinished('nothing')).toBe(false)
})

test('a Head out of turns gets a handoff round on a short budget', async () => {
  const { steps, log } = scripted([
    { finalText: 'working', code: 8, subtype: 'error_max_turns', calls: 5, turns: 50 },
    { finalText: 'Done: a\nNot done: b' },
  ])
  const result = await runRounds(steps)
  expect(result.ending).toBe('capped')
  expect(result.cap).toBe('turn')
  expect(result.rounds).toBe(2)
  expect(log[1]!.prompt).toBe(handoffPrompt('turn'))
  expect(log[1]!.maxTurns).toBe(HANDOFF_TURNS)
  expect(log[1]!.resume).toBe('s1')
  expect(result.round.finalText).toBe('Done: a\nNot done: b')
})

test('a handoff round that ends with HEAD DONE finishes the run', async () => {
  const { steps } = scripted([
    { finalText: 'working', code: 8, subtype: 'error_max_turns', calls: 5, turns: 50 },
    { finalText: DONE_MARK },
  ])
  const result = await runRounds(steps)
  expect(result.ending).toBe('done')
})

test('an empty handoff keeps the capped round text and ending', async () => {
  const { steps } = scripted([
    { finalText: 'working', code: 8, subtype: 'error_max_turns', calls: 5, turns: 50 },
    { finalText: '' },
  ])
  const result = await runRounds(steps)
  expect(result.round.finalText).toBe('working')
  expect(result.ending).toBe('capped')
})

test(`a Head that keeps going is capped at ${MAX_ROUNDS} rounds and gets a round handoff`, async () => {
  const working = Array.from({ length: MAX_ROUNDS }, () => ({ finalText: 'working', calls: 1 }))
  const { steps, log } = scripted([...working, { finalText: 'handoff' }])
  const result = await runRounds(steps)
  expect(result.ending).toBe('capped')
  expect(result.cap).toBe('round')
  expect(log[log.length - 1]!.prompt).toBe(handoffPrompt('round'))
})

test('a stopped Head ends as stopped and gets no handoff round', async () => {
  const outer = new AbortController()
  const { steps, log } = scripted([{ finalText: '', code: null, subtype: undefined }], { outer: outer.signal })
  const run = steps.runRound
  steps.runRound = async (spec, signal) => {
    outer.abort()
    return run(spec, signal)
  }
  const result = await runRounds(steps)
  expect(result.ending).toBe('stopped')
  expect(log.length).toBe(1)
})

test('a CLI failure is an error with no handoff when its code cannot be resumed', async () => {
  const { steps } = scripted([{ finalText: '', code: 1, subtype: 'error', calls: 0, errors: 'boom' }])
  const result = await runRounds(steps)
  expect(result.ending).toBe('error')
  expect(result.rounds).toBe(1)
})

test('a first round that names no session is retried', async () => {
  const sleep = (ms: number, signal: AbortSignal) =>
    ms <= 60_000
      ? Promise.resolve()
      : new Promise<unknown>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  const { steps, log } = scripted([
    { finalText: 'starting', sessionId: null },
    { finalText: 'starting again', sessionId: null },
    { finalText: DONE_MARK },
  ], { sleep })
  const result = await runRounds(steps)
  expect(log.length).toBe(3)
  expect(log[1]!.prompt).toBe(log[0]!.prompt)
  expect(log[2]!.prompt).toBe(log[0]!.prompt)
  expect(result.ending).toBe('done')
})

test('a resumed Head starts with the follow-up prompt on the earlier session', async () => {
  const { steps, log } = scripted([{ finalText: DONE_MARK }], { resume: 'old-session' })
  const result = await runRounds(steps)
  expect(log[0]!.resume).toBe('old-session')
  expect(log[0]!.prompt).toBe(followUpPrompt('do it'))
  expect(result.ending).toBe('done')
})

test('a resume the CLI refuses outright drops the session, so the caller starts fresh', async () => {
  const { steps } = scripted([{ finalText: '', code: 1, subtype: 'error', sessionId: null, errors: 'no such session' }], { resume: 'old-session' })
  const result = await runRounds(steps)
  expect(result.ending).toBe('error')
  expect(result.sessionId).toBeUndefined()
})

test('a resumed round that ran keeps the session it continued', async () => {
  const { steps } = scripted([{ finalText: 'working', calls: 1, sessionId: null }, { finalText: DONE_MARK, sessionId: null }], { resume: 'old-session' })
  const result = await runRounds(steps)
  expect(result.sessionId).toBe('old-session')
})

test('a round that may not be resumed ends the run', async () => {
  const { steps, log } = scripted([{ finalText: 'working', calls: 1 }], { mayResume: () => false })
  await runRounds(steps)
  expect(log.length).toBe(1)
})

const resultOf = (ending: Ending, cap?: 'turn' | 'round') => ({ ending, cap, round: { finalText: '', code: 0, errors: '' } })

test('endActivity says how a Head that did not finish ended', async () => {
  expect(endActivity(resultOf('done'), { maxTurns: 50, minutes: 40 })).toBeUndefined()
  expect(endActivity(resultOf('timeout'), { maxTurns: 50, minutes: 40 })).toBe('timed out after 40 min')
  expect(endActivity(resultOf('stopped'), { maxTurns: 50, minutes: 40 })).toBe('stopped')
  expect(endActivity(resultOf('blocked'), { maxTurns: 50, minutes: 40 })).toContain('blocked')
  expect(endActivity(resultOf('stalled'), { maxTurns: 50, minutes: 40 })).toContain('stalled')
  expect(endActivity(resultOf('capped', 'turn'), { maxTurns: 50, minutes: 40 })).toBe('stopped at the 50-turn cap')
  expect(endActivity(resultOf('capped', 'round'), { maxTurns: 50, minutes: 40 })).toContain('rounds')
  expect(endActivity(resultOf('error'), { maxTurns: 50, minutes: 40 })).toBe('stopped before HEAD DONE')
  expect(endActivity({ ending: 'error', round: { finalText: '', code: 1, errors: 'warming up\n429 quota\n' } }, { maxTurns: 50, minutes: 40 })).toBe('failed: 429 quota')
})

test('exitOf reports the round code but names a timeout or a stop', async () => {
  expect(exitOf(resultOf('timeout'), { minutes: 40 })).toBe('timed out after 40 min')
  expect(exitOf(resultOf('stopped'), { minutes: 40 })).toBe('stopped')
  expect(exitOf({ ending: 'error', round: { finalText: '', code: 7, errors: '' } }, { minutes: 40 })).toBe('7')
})

test('createCallCounter counts only finished and denied tool calls', async () => {
  const counter = createCallCounter()
  counter.see({ type: 'thinking_start' })
  counter.see({ type: 'tool_running' })
  counter.see({ type: 'tool_completed' })
  counter.see({ type: 'tool_denied' })
  expect(counter.calls).toBe(2)
})

test('clipReport trims a short report and cuts a long one from the middle', async () => {
  expect(clipReport('  hi  ')).toBe('hi')
  const text = `${'a'.repeat(5_000)}${'b'.repeat(12_000)}${'c'.repeat(3_000)}`
  const clipped = clipReport(text)
  expect(clipped.startsWith('a'.repeat(5_000))).toBe(true)
  expect(clipped.endsWith('c'.repeat(3_000))).toBe(true)
  expect(clipped).toContain('cut by Hydra')
  expect(clipped.length).toBeLessThan(text.length)
})

test('stopLine says what to do about a Head that did not finish', async () => {
  const capped = { id: 'h1', ending: 'capped' as const, cap: 'turn' as const, maxTurns: 50, sessionId: 's', engine: 'codex' as const, files: [] }
  expect(stopLine(capped)).toContain('out of turns (50)')
  expect(stopLine(capped)).toContain('resume: "h1"')
  const agy = stopLine({ ...capped, engine: 'agy' })
  expect(agy).not.toContain('resume:')
  expect(agy).toContain('new Head')
  expect(stopLine({ id: 'h1', ending: 'blocked', files: [] })!.startsWith('BLOCKED')).toBe(true)
  expect(stopLine({ id: 'h1', ending: 'done', files: [] })).toBeUndefined()
  expect(stopLine({ id: 'h1', ending: undefined, files: [] })).toBeUndefined()
  expect(stopLine({ id: 'h1', ending: 'stalled', files: ['/p/a.kt'] })).toContain('the work may be complete')
})

type Report = Parameters<typeof formatReport>[0]

const reportOf = (extra: Partial<Report> = {}) =>
  formatReport({ id: 'h', model: 'm', cwd: '/p', finished: false, rounds: 1, turns: 3, usd: 0, files: [], denied: [], finalText: '', exit: '0', ...extra })

test('formatReport puts a stop line above the edited list and only when unfinished', async () => {
  const text = reportOf({ ending: 'blocked', sessionId: 's', engine: 'codebuddy' })
  const lines = text.split('\n')
  const blockedAt = lines.findIndex(line => line.startsWith('BLOCKED'))
  const editedAt = lines.findIndex(line => line.startsWith('edited'))
  expect(blockedAt).toBeGreaterThanOrEqual(0)
  expect(blockedAt).toBeLessThan(editedAt)
  expect(reportOf({ finished: true, ending: 'blocked', sessionId: 's', engine: 'codebuddy' }).split('\n').some(line => line.startsWith('BLOCKED'))).toBe(false)
  expect(reportOf({ startedAt: 0, endedAt: 192_000 }).split('\n')[0]!.endsWith(' · 3:12')).toBe(true)
})

const head = (id: string, state: HeadRun['state'], engine: string, sessionId?: string): HeadRun => ({ id, task: 't', model: 'm', state, turns: 0, engine, sessionId })

test('resumeTarget finds the named Head or says why it cannot be continued', async () => {
  const old = head('old', 'done', 'codex', 's')
  const live = head('live', 'running', 'codex', 's')
  const blank = head('blank', 'done', 'codex')
  const missing = resumeTarget([old, live, blank], 'missing')
  expect('deny' in missing).toBe(true)
  if ('deny' in missing) {
    expect(missing.deny).toContain('old')
    expect(missing.deny).not.toContain('live')
    expect(missing.deny).not.toContain('blank')
  }
  const running = resumeTarget([live], 'live')
  expect('deny' in running && running.deny).toContain('still running')
  const agy = resumeTarget([head('a', 'done', 'agy', 's')], 'a')
  expect('deny' in agy && agy.deny).toContain('cannot be continued')
  const none = resumeTarget([blank], 'blank')
  expect('deny' in none && none.deny).toContain('no session')
  const found = head('r', 'done', 'codex', 's')
  expect(resumeTarget([found], 'r')).toEqual({ run: found })
  const later = resumeTarget([head('dup', 'done', 'codex', 'old'), head('dup', 'done', 'codex', 'new')], 'dup')
  expect('run' in later).toBe(true)
  if ('run' in later) expect(later.run.sessionId).toBe('new')
})

test('the edited line carries diff stats and a new file is named as new', async () => {
  expect(parseDiffStat('3\t1\ta.kt\0-\t-\timg.png\0', 'new.kt\0')).toEqual({ 'a.kt': '+3 −1', 'new.kt': 'new' })
  expect(editedLine('/p', ['/p/a.kt', '/p/b.kt'], { 'a.kt': '+3 −1' })).toBe('edited (2): a.kt (+3 −1), b.kt')
})

test('withEditStats rewrites only Hydra\'s edited line, never the Head\'s text', async () => {
  const report = reportOf({ files: ['/p/a.kt'], finalText: 'edited (9): evil' })
  const updated = withEditStats(report, '/p', ['/p/a.kt'], { 'a.kt': '+5 −2' })
  expect(updated).toContain('edited (1): a.kt (+5 −2)')
  expect(updated).toContain('edited (9): evil')
  expect(updated.indexOf('edited (9): evil')).toBeGreaterThan(updated.indexOf('--- head report ---'))
  expect(updated.match(/edited \(\d+\)/g)?.length).toBe(2)
  expect(withEditStats(report, '/p', ['/p/a.kt'], {})).toBe(report)
})

test('a report after a move names the files of the earlier attempts too', async () => {
  const last = reportOf({ finalText: 'edited (9): evil' })
  expect(last).toContain('edited: nothing')
  expect(editedCount(last)).toBe(0)
  const merged = withEdits(last, '/p', ['/p/a.kt', '/p/b.kt'], { 'a.kt': '+3 −1' })
  expect(merged).toContain('edited (2): a.kt (+3 −1), b.kt')
  expect(merged).not.toContain('edited: nothing')
  expect(merged).toContain('edited (9): evil')
  expect(editedCount(merged)).toBe(2)
})

test('isCheckable accepts a finished Head and an unfinished one that edited files', async () => {
  expect(isCheckable({ text: '', isDone: true })).toBe(true)
  expect(isCheckable({ text: '', isDone: false, ending: 'capped', files: ['a'] })).toBe(true)
  expect(isCheckable({ text: '', isDone: false, ending: 'stalled', files: ['a'] })).toBe(true)
  expect(isCheckable({ text: '', isDone: false, ending: 'timeout', files: ['a'] })).toBe(true)
  expect(isCheckable({ text: '', isDone: false, ending: 'capped' })).toBe(false)
  expect(isCheckable({ text: '', isDone: false, ending: 'stalled' })).toBe(false)
  expect(isCheckable({ text: '', isDone: false, ending: 'timeout' })).toBe(false)
  expect(isCheckable({ text: '', isDone: false, ending: 'blocked', files: ['a'] })).toBe(false)
  expect(isCheckable({ text: '', isDone: false, ending: 'stopped', files: ['a'] })).toBe(false)
  expect(isCheckable({ text: '', isDone: false, ending: 'error', files: ['a'] })).toBe(false)
})

type Result = { text: string; isDone: boolean; files?: string[]; ending?: string }

const report = (files: string[] = []) => formatReport({ id: 'h', model: 'm', cwd: '/p', finished: true, rounds: 1, turns: 3, usd: 0, files, denied: [], finalText: 'All done. HEAD DONE', exit: '0' })
const passed: CheckOutcome = { kind: 'passed', seconds: 4 }

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

test('checkHead checks a capped Head that edited files, and never checks a blocked one', async () => {
  const unfinished = reportOf({ ending: 'capped', files: ['/p/a.kt'], finalText: 'ran out of turns' })
  const checked = await checkHead(steps([{ text: unfinished, isDone: false, ending: 'capped', files: ['/p/a.kt'] }], [passed]))
  expect(checked.outcome?.kind).toBe('passed')
  expect(checked.result.text).toContain('✓ passed')
  expect(checked.result.text).toContain('did not report HEAD DONE')
  const blocked = await checkHead(steps([{ text: report(), isDone: false, ending: 'blocked', files: ['/p/a.kt'] }], [passed]))
  expect(blocked.result.text).toContain('not run: the Head did not finish')
})

test('the check notes name the command and what a failed check means', async () => {
  expect(checkNote('./gradlew test')).toContain('./gradlew test')
  expect(checkNote('./gradlew test')).toContain('Hydra runs')
  expect(fixNote('./gradlew test', { kind: 'failed', exitCode: 1, tail: 'boom', seconds: 1 }, ['a.kt'])).toContain('acceptance check failed')
})

test('the round prompts carry the marks and the handoff carries what is left', async () => {
  expect(HEAD_RULES).toContain(DONE_MARK)
  expect(HEAD_RULES).toContain(BLOCKED_MARK)
  expect(HEAD_RULES).toContain('Unverified')
  expect(continuePrompt(['shell ls'])).toContain('shell ls')
  expect(continuePrompt(['shell ls'])).toContain(DONE_MARK)
  expect(continuePrompt(['shell ls'])).toContain(BLOCKED_MARK)
  expect(handoffPrompt('time')).toContain('time limit')
  expect(handoffPrompt('time')).toContain('Not done')
  expect(summaryOf('a\nb\nHEAD BLOCKED')).not.toContain('HEAD BLOCKED')
})

test('the policy carries the rules that matter and names an Antigravity Head only when the pool has one', async () => {
  const withAgy = HYDRA_POLICY('deepseek-v4.1-flash', 'auto', 'auto', ['codebuddy', 'codex', 'agy'])
  expect(withAgy).toContain(BRIEF_RULE)
  expect(withAgy).toContain(REPORT_RULE)
  expect(withAgy).toContain(READ_RULE)
  expect(withAgy).toContain('resume: "<its name>"')
  expect(withAgy).toContain('an Antigravity Head cannot be continued')
  const withoutAgy = HYDRA_POLICY('deepseek-v4.1-flash', 'auto', 'auto', ['codebuddy', 'codex'])
  expect(withoutAgy).not.toContain('an Antigravity Head cannot be continued')
  const single = HYDRA_POLICY('deepseek-v4.1-flash', 'auto', 'codebuddy')
  expect(single).toContain(BRIEF_RULE)
  expect(single).toContain(REPORT_RULE)
})

test('progressOf measures a Head against the files the Lead named', async () => {
  expect(progressOf({})).toBeUndefined()
  const progress = progressOf({ expected: ['a.kt', 'b.kt', 'c.kt'], touched: ['a.kt', 'x.kt'] })
  expect(progress?.done).toBe(1)
  expect(progress?.total).toBe(3)
  expect(Math.abs((progress?.percent ?? 0) - 100 / 3)).toBeLessThan(0.0001)
  expect(progressOf({ expected: ['a.kt', 'b.kt'], files: ['b.kt'] })).toMatchObject({ done: 1, total: 2 })
})

test('progressText shows turns, named files, or the near-cap count', async () => {
  expect(progressText({ turns: 7, maxTurns: 100 })).toBe('7 turns')
  expect(progressText({ turns: 5, maxTurns: 100, expected: ['a.kt', 'b.kt', 'c.kt'], touched: ['a.kt', 'b.kt'] })).toBe('2/3 files')
  expect(progressText({ turns: 80, maxTurns: 100, expected: ['a.kt'] })).toBe('80/100 turns')
  expect(progressText({ turns: 79, maxTurns: 100 })).toBe('79 turns')
})

test('progressBar fills by the named files written, and stays blank without them', async () => {
  expect(progressBar({}, 8)).toBe('        ')
  expect(progressBar({ expected: ['a.kt', 'b.kt'], touched: ['a.kt'] }, 8)).toBe('████░░░░')
})

test('a Head\'s turns add up across its runs, while the cap counts only the run under way', async () => {
  const fixRound = { turns: 22, earlierTurns: 54, maxTurns: 200 }
  expect(turnsOf(fixRound)).toBe(76)
  expect(turnsOf({ turns: 7 })).toBe(7)
  expect(progressText(fixRound)).toBe('76 turns')
  expect(countsOf({ ...fixRound, expected: ['a.kt'], files: ['a.kt'] })).toBe('1/1 files · 76 turns')
  // 190 earlier turns do not put a fresh fix round near its own 200-turn cap.
  expect(progressText({ turns: 20, earlierTurns: 190, maxTurns: 200 })).toBe('210 turns')
  expect(progressText({ turns: 170, earlierTurns: 30, maxTurns: 200 })).toBe('170/200 turns')
})

test('countsOf adds the named files written to a Head\'s turns, and the cap near it', async () => {
  expect(countsOf({ turns: 7 })).toBe('7 turns')
  expect(countsOf({ turns: 7, maxTurns: 100, expected: ['a.kt', 'b.kt', 'c.kt'], touched: ['a.kt', 'b.kt'] })).toBe('2/3 files · 7 turns')
  expect(countsOf({ turns: 90, maxTurns: 100 })).toBe('90/100 turns')
})

test('expectedMarks ticks the files a Head has written', async () => {
  expect(expectedMarks({ expected: ['a.kt', 'b.kt'], touched: ['a.kt'] })).toBe('✓ a.kt  · b.kt')
})

test('expectedFiles makes the named files relative and unique', async () => {
  expect(expectedFiles('/p', ['/p/src/a.kt', './b.kt', 'b.kt', ' c.kt ', ''])).toEqual(['src/a.kt', 'b.kt', 'c.kt'])
})

test('scopeLines reports the named files changed, missed and added to', async () => {
  expect(scopeLines('/p', [], [])).toEqual([])
  expect(scopeLines('/p', ['a.kt', 'b.kt'], ['/p/a.kt', '/p/b.kt'])).toEqual(['named files: 2/2 changed'])
  expect(scopeLines('/p', ['a.kt', 'b.kt'], ['/p/a.kt', '/p/z.kt'])).toEqual(['named files: 1/2 changed', '⚠ named but not changed: b.kt', 'also changed, not named: z.kt'])
  expect(scopeLines('/p', ['a.kt', 'b.kt'], ['/p/a.kt', '/p/z.kt'], ['other-head'])).toEqual(['named files: 1/2 changed', '⚠ named but not changed: b.kt'])
})

test('applyEvent adds the files an edit writes to what the Head has touched', async () => {
  const run = { id: 'h', task: 't', model: 'm', state: 'running' as const, turns: 0 }
  const labels = new Map<string, string>()
  applyEvent(run, { type: 'tool_queued', toolCallId: '1', toolName: 'edit_file', input: { file_path: '/p/src/a.kt' } }, labels, '/p')
  const written = applyEvent(run, { type: 'tool_completed', toolCallId: '1', toolName: 'edit_file' }, labels, '/p')
  expect(written.touched).toEqual(['src/a.kt'])
  const already = { ...run, touched: ['src/a.kt'] }
  applyEvent(already, { type: 'tool_queued', toolCallId: '1', toolName: 'edit_file', input: { file_path: '/p/src/a.kt' } }, labels, '/p')
  const again = applyEvent(already, { type: 'tool_completed', toolCallId: '1', toolName: 'edit_file' }, labels, '/p')
  expect(again.touched).toBeUndefined()
  expect(applyEvent(run, { type: 'tool_completed', toolCallId: 'r', toolName: 'read_file' }, labels, '/p').touched).toBeUndefined()
  expect(applyEvent(run, { type: 'tool_denied', toolCallId: 'd', toolName: 'edit_file' }, labels, '/p').touched).toBeUndefined()
  const many = applyEvent(run, { type: 'tool_completed', toolCallId: '9', toolName: 'edit_file', files: ['/p/a.kt', '/p/b.kt'] }, labels, '/p')
  expect(many.touched).toEqual(['a.kt', 'b.kt'])
})
