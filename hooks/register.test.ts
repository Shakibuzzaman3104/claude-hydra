/**
 * @author Shakib
 * @since 06/10/26
 */
import { expect, test } from 'claude-code/testing'

import {
  ancestorDenyRules, guardCommand, waysDown, writeDirDeny, applyEvent, barOf, HYDRA_HELP, mergeHeads, preflightText, spentOf, summaryOf, clockOf, continuePrompt, describeTool, elapsedOf, glyphOf, headsSummary, isLive, nowLine, effortModeOf, headEffort, HYDRA_POLICY, isEffort, isEffortMode, isHeadEffort, nearestEffort, supportedEfforts, DANGEROUS_SHELL, DONE_MARK, formatReport, headSettings, outsideFiles, windowsPathRefusal, PROJECT_DENY, isFinished, isResumable, leadLabel, parseHydraArgs,
  relativeTo, resetsIn, SEARCH_DENY, statusFile, statusLine, createGate, createJobQueue, createQueue, createReplyBox, headName, waitForResult, listRuns, nameFromTask, slugOf, stopReason, stopRuns,
} from './register'
import type { On } from 'claude-code'

import type { HeadRun } from '../types'

test('labels Claude windows like the Droppy panel', async () => {
  expect(leadLabel('five_hour')).toBe('5-hour limit')
  expect(leadLabel('seven_day')).toBe('Weekly · all models')
  expect(leadLabel('seven_day_fable')).toBe('Weekly · Fable')
})

test('formats reset countdowns', async () => {
  const now = Date.parse('2026-10-06T12:00:00Z')
  expect(resetsIn('2026-10-06T13:17:00Z', now)).toBe('Resets in 1 hr 17 min')
  expect(resetsIn('2026-10-06T12:40:00Z', now)).toBe('Resets in 40 min')
  expect(resetsIn(null, now)).toBe('')
})

test('draws a bar proportional to the percent', async () => {
  expect(barOf(30, 10)).toBe('███░░░░░░░')
  expect(barOf(150, 4)).toBe('████')
})

test('writes the Head model, effort and Heads usage for the status line only while Hydra is on', async () => {
  const usage = { fiveHour: { usd: 0.06, resetsAt: null }, weekly: { usd: 1.41, resetsAt: null }, measuredAt: 0 }
  const limits = { fiveHourUsd: 14, weeklyUsd: 35 }
  const on = { isOn: true, headModel: 'deepseek/deepseek-v4.1-flash', effort: 'high' }
  expect(statusLine(on, usage, limits)).toBe('🐉 deepseek-v4.1-flash · high | Heads 5h $0.06/$14 | 7d $1.41/$35')
  expect(statusLine(on, null, limits)).toBe('🐉 deepseek-v4.1-flash · high')
  expect(statusLine(on, { ...usage, error: 'offline' }, limits)).toBe('🐉 deepseek-v4.1-flash · high')
  expect(statusLine({ isOn: true, headModel: 'm' }, null, limits)).toBe('🐉 m · auto')
  expect(statusLine({ ...on, isOn: false }, usage, limits)).toBeUndefined()
  expect(statusLine(null, usage, limits)).toBeUndefined()
  expect(statusFile('/Users/x', 'abc-123')).toBe('/Users/x/.claude/hydra/status/abc-123.txt')
})

test('parses /hydra arguments', async () => {
  expect(parseHydraArgs('')).toEqual({ action: 'on', leadModel: undefined, headModel: undefined, effort: undefined, task: '', unknown: undefined })
  expect(parseHydraArgs('off').action).toBe('off')
  expect(parseHydraArgs('opus head=moonshotai/kimi-k3 build the login screen')).toEqual({
    action: 'on',
    leadModel: 'opus',
    headModel: 'moonshotai/kimi-k3',
    effort: undefined,
    task: 'build the login screen',
    unknown: undefined,
  })
  expect(parseHydraArgs('effort=MAX').effort).toBe('max')
  expect(parseHydraArgs('opus --effort low fix it')).toMatchObject({ leadModel: 'opus', effort: 'low', task: 'fix it' })
  expect(parseHydraArgs('fix the effort=max label').effort).toBeUndefined()
  expect(parseHydraArgs('fix the opus label').leadModel).toBeUndefined()
})

test('treats a Head as finished only after its done mark', async () => {
  expect(isFinished("I'll start by reading the brief.")).toBe(false)
  expect(isFinished(`All done.\n${DONE_MARK}`)).toBe(true)
})

test('denies shell outright unless a running Head asked for it, and always protects the repo', async () => {
  const outside = ['Edit(//Users)', 'Edit(//Users/**)']
  const quiet = headSettings([{ addDirs: ['/Volumes/Design'], shell: false }], outside)
  expect(quiet.managedBy).toBe('hydra')
  expect(quiet.permissions?.deny).toContain('Shell')
  expect(quiet.permissions?.deny).toContain('Edit(//Users/**)')
  for (const rule of PROJECT_DENY) expect(quiet.permissions?.deny).toContain(rule)
  expect(quiet.permissions?.additionalDirectories).toEqual(['/Volumes/Design'])
  expect(quiet.permissions?.allow).toBeUndefined()

  const mixed = headSettings([{ addDirs: ['/a'], shell: false }, { addDirs: ['/a', '/b'], shell: true }], outside)
  expect(mixed.permissions?.deny).not.toContain('Shell')
  expect(mixed.permissions?.deny).toContain('Shell(git push*)')
  expect(mixed.permissions?.deny).toContain('Shell(xcodebuild*)')
  expect(mixed.permissions?.deny?.length).toBe(outside.length + PROJECT_DENY.length + DANGEROUS_SHELL.length)
  expect(mixed.permissions?.additionalDirectories).toEqual(['/a', '/b'])
})

test('never lets a Head read or edit .env files, with or without shell', async () => {
  for (const shell of [false, true]) {
    const deny = headSettings([{ addDirs: [], shell }], []).permissions?.deny
    for (const rule of ['Read(.env)', 'Read(.env.*)', 'Edit(.env)', 'Edit(.env.*)', 'Shell(* .env*)', 'Shell(*/.env*)']) expect(deny).toContain(rule)
    expect(deny).not.toContain('Shell(*.env*)')
  }
})

test('denies the search tool only when a .env file is in reach', async () => {
  expect(headSettings([{ addDirs: [], shell: false }], []).permissions?.deny).not.toContain(SEARCH_DENY)
  expect(headSettings([{ addDirs: [], shell: false }], [], true).permissions?.deny).toContain(SEARCH_DENY)
})

test('flags any write outside the project', async () => {
  expect(outsideFiles('/repo', ['/repo/a.swift', '/repository/x', '/etc/hosts', 'relative.txt'])).toEqual(['/repository/x', '/etc/hosts'])
  const text = formatReport({
    id: 'h2', model: 'm', cwd: '/repo', finished: true, rounds: 1, turns: 1, usd: 0, files: ['/repo/a', '/etc/hosts'], denied: [], finalText: 'ok', exit: '0',
  })
  expect(text).toContain('WROTE OUTSIDE THE PROJECT (1): /etc/hosts')
})

test('tells a resumed Head which calls stay denied', async () => {
  expect(continuePrompt([])).not.toContain('denied')
  expect(continuePrompt(['read_file /x/mock.html'])).toContain('read_file /x/mock.html')
})

test('reports edited files relative to the repo and lists denials', async () => {
  expect(relativeTo('/repo', '/repo/a/b.swift')).toBe('a/b.swift')
  const text = formatReport({
    id: 'h1', model: 'deepseek/x', cwd: '/repo', sessionId: 's1', finished: false, rounds: 2, turns: 5, usd: 0.01,
    files: ['/repo/a.swift'], denied: [{ tool: 'shell_command', target: 'xcodebuild', text: 'denied' }], finalText: '', exit: '9',
  })
  expect(text).toContain('NOT finished')
  expect(text).toContain('edited (1): a.swift')
  expect(text).toContain('denied (1):')
})

test('resumes a Head after a clean stop, a turn cap or an empty reply', async () => {
  expect(isResumable(0)).toBe(true)
  expect(isResumable(9)).toBe(true)
  expect(isResumable(1)).toBe(false)
  expect(isResumable(null)).toBe(false)
})

test('never runs more Heads at once than the gate allows, and starts them in order', async () => {
  const gate = createGate(2)
  const started: number[] = []
  const run = async (n: number) => {
    await gate.enter()
    started.push(n)
  }
  await run(1)
  await run(2)
  const third = run(3)
  expect(gate.active).toBe(2)
  expect(gate.waiting).toBe(1)
  expect(started).toEqual([1, 2])
  gate.leave()
  await third
  expect(started).toEqual([1, 2, 3])
  expect(gate.active).toBe(2)
  gate.leave()
  gate.leave()
  expect(gate.active).toBe(0)
})

test('hands queued background jobs to the worker in order, waking it when one arrives', async () => {
  const queue = createJobQueue()
  queue.push({ input: { task: 'a' }, headModel: 'm', id: 'h1' })
  expect((await queue.next()).id).toBe('h1')
  const waiting = queue.next()
  queue.push({ input: { task: 'b' }, headModel: 'm', id: 'h2' })
  queue.push({ input: { task: 'c' }, headModel: 'm', id: 'h3' })
  expect((await waiting).id).toBe('h2')
  expect(queue.size).toBe(1)
  expect((await queue.next()).id).toBe('h3')
})

test('reads the levels a model supports from its refusal and rounds a missing one up', async () => {
  const levels = supportedEfforts('Unknown effort "medium". Supported: off, low, high, max.\n')
  expect(levels).toEqual(['off', 'low', 'high', 'max'])
  expect(nearestEffort('medium', levels)).toBe('high')
  expect(nearestEffort('xhigh', levels)).toBe('max')
  expect(nearestEffort('low', levels)).toBe('low')
  expect(nearestEffort('max', ['low', 'high'])).toBe('high')
  expect(nearestEffort('high', [])).toBeUndefined()
  expect(supportedEfforts('some other failure')).toEqual([])
  expect(isEffort('max')).toBe(true)
  expect(isEffort('ultra')).toBe(false)
})

test('lets the Lead pick low to max under auto, and lets the person fix any level', async () => {
  expect(headEffort('auto', undefined)).toBe('low')
  expect(headEffort('auto', 'max')).toBe('max')
  expect(headEffort('auto', 'low')).toBe('low')
  expect(headEffort('auto', 'medium')).toBe('medium')
  expect(headEffort('auto', 'off')).toBe('low')
  expect(headEffort('high', 'max')).toBe('high')
  expect(headEffort('max', undefined)).toBe('max')
  expect(headEffort('low', 'max')).toBe('low')
  expect(effortModeOf({ isOn: true, headModel: 'm', effort: 'max' })).toBe('max')
  expect(effortModeOf({ isOn: true, headModel: 'm', effort: 'off' })).toBe('off')
  expect(effortModeOf({ isOn: true, headModel: 'm', effort: 'ultra' })).toBe('auto')
  expect(effortModeOf(null)).toBe('auto')
  expect(headEffort('auto', 'xhigh')).toBe('xhigh')
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) expect(isHeadEffort(level)).toBe(true)
  expect(isHeadEffort('off')).toBe(false)
  expect(isEffortMode('off')).toBe(true)
  expect(isEffortMode('ultra')).toBe(false)
  expect(isEffortMode('auto')).toBe(true)
  expect(isHeadEffort('auto')).toBe(false)
})

test('tells the Lead who picks the effort and how to pick it', async () => {
  const auto = HYDRA_POLICY('deepseek/x', 'auto')
  expect(auto).toContain("`low` (the default) for every Head whose result you will check")
  for (const level of ['`low`', '`high`', '`max`']) expect(auto).toContain(level)
  expect(auto).toContain('send the Head back one level up with the failure in the task')
  expect(auto).toContain('`max` first only when you cannot check the result cheaply')
  expect(auto).not.toContain('\\`')
  expect(auto).not.toContain('medium runs as high')
  expect(HYDRA_POLICY('deepseek/deepseek-v4.1-flash', 'auto')).toContain('deepseek-v4.1-flash takes low, high and max: medium runs as high, xhigh as max.')
  expect(HYDRA_POLICY('deepseek/x', 'max')).toContain('fixed every Head\'s effort at max')
})

test('describes tool calls in a few words, relative to the repo', async () => {
  expect(describeTool('edit_file', { file_path: '/repo/src/a.ts' }, '/repo')).toBe('edit src/a.ts')
  expect(describeTool('read_directory', { path: '/repo' }, '/repo')).toBe('list .')
  expect(describeTool('grep', { pattern: 'TODO' }, '/repo')).toBe('search "TODO"')
  expect(describeTool('shell_command', { command: 'ls -a' }, '/repo')).toBe('$ ls -a')
  expect(describeTool('web_fetch', {}, '/repo')).toBe('web fetch')
})

test('folds the stream into a live record: activity, steps, edits, denials and turns', async () => {
  const labels = new Map<string, string>()
  let run: HeadRun = { id: 'h1', task: 't', model: 'm', state: 'running', turns: 0 }
  const apply = (event: Parameters<typeof applyEvent>[1]) => { run = { ...run, ...applyEvent(run, event, labels, '/repo') } }
  apply({ type: 'thinking_start' })
  expect(run).toMatchObject({ activity: 'thinking' })
  apply({ type: 'tool_queued', toolCallId: 'c1', toolName: 'edit_file', input: { file_path: '/repo/c.txt' } })
  apply({ type: 'tool_running', toolCallId: 'c1', toolName: 'edit_file' })
  expect(run).toMatchObject({ activity: 'edit c.txt' })
  apply({ type: 'tool_completed', toolCallId: 'c1', toolName: 'edit_file' })
  apply({ type: 'tool_queued', toolCallId: 'c2', toolName: 'shell_command', input: { command: 'ls' } })
  apply({ type: 'tool_denied', toolCallId: 'c2', toolName: 'shell_command' })
  apply({ type: 'turn_end' })
  expect(run).toMatchObject({ edits: 1, denials: 1, turns: 1, steps: [{ isOk: true, text: 'edit c.txt' }, { isOk: false, text: '$ ls' }] })
})

test('draws times, glyphs and summaries for the live view', async () => {
  expect(clockOf(134_000)).toBe('2:14')
  expect(clockOf(3_723_000)).toBe('1:02:03')
  const base = { id: 'h', task: 't', model: 'm', turns: 0 }
  expect(elapsedOf({ ...base, state: 'running', startedAt: 1_000 }, 61_000)).toBe('1:00')
  expect(elapsedOf({ ...base, state: 'queued' }, 5)).toBe('–')
  expect(glyphOf({ ...base, state: 'done' }, 3)).toBe('✓')
  expect(glyphOf({ ...base, state: 'failed' }, 3)).toBe('✗')
  expect(glyphOf({ ...base, state: 'running' }, 1)).not.toBe(glyphOf({ ...base, state: 'running' }, 2))
  expect(isLive({ ...base, state: 'done', endedAt: 0 }, 30_000)).toBe(true)
  expect(isLive({ ...base, state: 'done', endedAt: 0 }, 90_000)).toBe(false)
  expect(headsSummary([{ ...base, state: 'running' }, { ...base, state: 'running' }, { ...base, state: 'failed' }])).toBe('2 running · 1 failed')
  expect(nowLine({ ...base, state: 'done', costUsd: 0.0048 })).toBe('done · $0.0048')
  expect(nowLine({ ...base, state: 'running', activity: 'edit c.txt' })).toBe('edit c.txt')
})

const NOW = 1_000_000

const LIVE_RUNS: HeadRun[] = [
  {
    id: 'hA', task: 'Make 12 edits to c.txt', model: 'deepseek/deepseek-v4.1-flash', state: 'running', turns: 7, maxTurns: 40, effort: 'high', startedAt: NOW - 134_000,
    activity: 'edit c.txt', edits: 5, denials: 1, steps: [{ isOk: true, text: 'search "TODO"' }, { isOk: false, text: '$ wc -l c.txt' }],
  },
  { id: 'hB', task: 'Smoke test the rules', model: 'deepseek/deepseek-v4.1-flash', state: 'done', turns: 14, maxTurns: 40, effort: 'max', costUsd: 0.0336,
    startedAt: NOW - 90_000, endedAt: NOW - 10_000 },
]
const scroll = { offset: 0, bodyRows: 20 }

/** The text a drawn tree shows, its chunks joined per element. */
const textOf = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object') return ''
  const element = node as { children?: unknown[]; props?: { label?: string } }
  return (element.props?.label ?? '') + (element.children ?? []).map(textOf).join('') + '\n'
}

/** Stands in for the engine: the Head list those Heads left, the views' clock, and the engine's own empty band. */
const serveRuns = (on: On, list: HeadRun[]) => {
  on('state.get', ($, e, next) => {
    if (e.plugin === 'hydra' && e.key === 'runs') return Promise.resolve({ value: { value: list, version: 1 } })
    if (e.plugin === 'hydra' && e.key === 'tick') return Promise.resolve({ value: { value: NOW, version: 1 } })
    return next(e)
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`draws the live band above the prompt while Heads work (${surface})`, async ($, on) => {
    serveRuns(on, LIVE_RUNS)
    const band = await $.ui.mount({
      plugin: 'hydra', surface, component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 100, scroll, view: {} },
    })
    const text = textOf(await band.drawn())
    for (const part of ['1 running · 1 done', 'hA', 'high', ' 7/40', '2:14', 'edit c.txt', 'hB', 'max', '14/40', 'done · $0.0336']) expect(text).toContain(part)
  })

  test(`lists Heads in the /heads pane and shows the one picked (${surface})`, async ($, on) => {
    serveRuns(on, LIVE_RUNS)
    const pane = await $.ui.mount({
      plugin: 'hydra', surface, component: 'Pane', requestId: 'hydra-heads',
      props: { title: 'Heads', isFocused: true, bodyColumns: 80, placement: 'dock', scroll, view: {} },
    })
    const first = textOf(await pane.drawn())
    for (const part of ['Make 12 edits to c.txt', '5 edits · 1 denied', '$ wc -l c.txt', '(denied)']) expect(first).toContain(part)
    await $.ui.press({ plugin: 'hydra', key: 'pick-hB', surface })
    const picked = textOf(await pane.drawn())
    expect(picked).toContain('effort max')
    expect(picked).toContain('$0.0336')
  })
}

test('leaves the band to the engine when no Head is live', async ($, on) => {
  serveRuns(on, [])
  // Nothing stands for the engine's own band here, so a pass ends in the kit's "no implementation".
  const passed = await $.ui.mount({
    plugin: 'hydra', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll, view: {} },
  }).then(() => 'drew', (error: unknown) => String(error))
  expect(passed).toContain('no implementation for ui.render')
})

test('marks only running or queued Heads as stopped, by id or all', async () => {
  const run = (id: string, state: HeadRun['state']): HeadRun => ({ id, task: 't', model: 'm', state, turns: 0 })
  const list = [run('h1', 'running'), run('h2', 'queued'), run('h3', 'done'), run('h4', 'failed')]
  const some = stopRuns(list, ['h1'], 'stopped by the Lead', 5)
  expect(some[0]).toEqual({ ...list[0], state: 'failed', endedAt: 5, activity: 'stopped by the Lead' })
  expect(some[1]).toBe(list[1])
  const all = stopRuns(list, 'all', 'ended by a reload or restart', 9)
  expect(all.map(r => r.state)).toEqual(['failed', 'failed', 'done', 'failed'])
  expect(all[2]).toBe(list[2])
  expect(all[3]).toBe(list[3])
})

test('flags a running Head with no live process behind it as stale', async () => {
  const live: HeadRun = { id: 'h1', task: 'convert file', model: 'm', state: 'running', turns: 3, maxTurns: 60, startedAt: 1_000 }
  const ghost: HeadRun = { ...live, id: 'h2' }
  const text = listRuns([live, ghost], 66_000, id => id === 'h1')
  expect(text.split('\n')[0]).toBe('h1 · running · 3/60 turns · 1:05 · running · convert file')
  expect(text.split('\n')[1]).toContain('h2 · running · NO LIVE PROCESS')
  expect(listRuns([], 0, () => false)).toBe('No Heads in this session.')
})

test('names why a Head stopped', async () => {
  const stopped = new AbortController()
  stopped.abort('stopped by the Lead')
  expect(stopReason(stopped.signal)).toBe('stopped by the Lead')
  const plain = new AbortController()
  plain.abort()
  expect(stopReason(plain.signal)).toBe('stopped')
})

test('hands queued prompts to the session in order', async () => {
  const queue = createQueue<string>()
  queue.push('first')
  const waiting = queue.next()
  expect(await waiting).toBe('first')
  const later = queue.next()
  queue.push('second')
  expect(await later).toBe('second')
  expect(queue.size).toBe(0)
})

test('names Heads short and readable, from the Lead or the task', async () => {
  expect(slugOf('Prefs Utils!')).toBe('prefs-utils')
  expect(slugOf('PathaoAppSettings')).toBe('pathao-app-settings')
  expect(slugOf('ShopOrderDetailsActivity')).toBe('shop-order-details')
  expect(nameFromTask('Convert app/src/main/java/com/x/utils/PreferenceUtils.kt from Java to Kotlin')).toBe('preference-utils')
  expect(nameFromTask('Add unit tests for the login screen validation')).toBe('unit-tests-login')
  expect(nameFromTask('')).toBe('head')
  expect(headName('Login Tests', 'anything', new Set())).toBe('login-tests')
  expect(headName(undefined, 'Fix DateTimeUtils.kt parsing', new Set())).toBe('date-time-utils')
})

test('keeps Head names unique within the session', async () => {
  const taken = new Set(['prefs-utils', 'prefs-utils-2'])
  expect(headName('prefs-utils', 't', taken)).toBe('prefs-utils-3')
  expect(headName('abcdefghij-klmnopqrs', 't', new Set(['abcdefghij-klmnopqrs']))).toBe('abcdefghij-klmnopq-2')
})

test('waits for a worker-run Head through pauses, and stops waiting on abort', async () => {
  const box: { result?: string } = {}
  let pauses = 0
  const done = await waitForResult(box, new AbortController().signal, async () => {
    pauses++
    if (pauses === 3) box.result = 'report'
  })
  expect(done).toBe('report')
  expect(pauses).toBe(3)

  const stopper = new AbortController()
  let calls = 0
  const stopped = await waitForResult<string>({}, stopper.signal, async () => {
    calls++
    if (calls === 2) stopper.abort('stopped')
  })
  expect(stopped).toBeUndefined()
  expect(calls).toBe(2)

  let failures = 0
  const recovered = await waitForResult(box, new AbortController().signal, async () => {
    failures++
    throw new Error('sleep failed')
  })
  expect(recovered).toBe('report')
  expect(failures).toBe(0)
})

test('an interrupted foreground call lets go of its Head instead of killing it', async () => {
  const live = new AbortController()
  const kept = createReplyBox<string>(live.signal)
  expect(kept.reply('report')).toBe(true)
  expect(kept.box.result).toBe('report')

  const interrupted = new AbortController()
  const handed = createReplyBox<string>(interrupted.signal)
  interrupted.abort('the person opened /heads')
  expect(handed.reply('late report')).toBe(false)
  expect(handed.box.result).toBeUndefined()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`offers a Stop button for a live Head in /heads, never for a finished one (${surface})`, async ($, on) => {
    serveRuns(on, LIVE_RUNS)
    const pane = await $.ui.mount({
      plugin: 'hydra', surface, component: 'Pane', requestId: 'hydra-heads',
      props: { title: 'Heads', isFocused: true, bodyColumns: 80, placement: 'dock', scroll, view: {} },
    })
    expect(textOf(await pane.drawn())).toContain('Stop hA')
    await $.ui.press({ plugin: 'hydra', key: 'pick-hB', surface })
    expect(textOf(await pane.drawn())).not.toContain('Stop hB')
  })
}

test('denies new files directly in every folder above the project, never inside it', async () => {
  const listings: Record<string, string[]> = { '/': ['Users', 'tmp'], '/Users': ['me', 'other'], '/Users/me': ['app', '.zshrc'] }
  const rules = ancestorDenyRules(['/Users/me/app'], dir => listings[dir] ?? [])
  for (const rule of ['Edit(//*)', 'Edit(//Users/*)', 'Edit(//Users/me/*)', 'Edit(//tmp/**)', 'Edit(//Users/other/**)', 'Edit(//Users/me/.zshrc)']) expect(rules).toContain(rule)
  expect(rules.some(rule => rule.startsWith('Edit(//Users/me/app'))).toBe(false)
})

test('runs the write guard on every write and edit, quoting its paths for the shell', async () => {
  const command = guardCommand('/plug ins/hydra', "/Users/me/it's app")
  expect(command).toBe(`/usr/bin/env python3 -I '/plug ins/hydra/bin/head-guard.py' '/Users/me/it'\\''s app'`)
  const settings = headSettings([{ addDirs: [], shell: false }], [], false, command)
  expect(settings.hooks?.PreToolUse[0]).toMatchObject({ matcher: 'write|edit', hooks: [{ type: 'command', command }] })
  expect(headSettings([{ addDirs: [], shell: false }], []).hooks).toBeUndefined()
})

test('never turns a typo into a task, and knows help and statusline', async () => {
  expect(parseHydraArgs('stauts')).toMatchObject({ action: 'on', unknown: 'stauts', task: '' })
  expect(parseHydraArgs('efort=max fix the login')).toMatchObject({ unknown: 'efort=max', task: '' })
  expect(parseHydraArgs('--fast fix the login')).toMatchObject({ unknown: '--fast', task: '' })
  expect(parseHydraArgs('fix the login bug')).toMatchObject({ unknown: undefined, task: 'fix the login bug' })
  expect(parseHydraArgs('effort=max')).toMatchObject({ unknown: undefined, effort: 'max', task: '' })
  expect(parseHydraArgs('help').action).toBe('help')
  expect(parseHydraArgs('statusline').action).toBe('statusline')
  expect(HYDRA_HELP).toContain('/hydra-usage')
})

test('shows spend without a limit until the person sets one', async () => {
  expect(spentOf(1.5, 0)).toBe('$1.50')
  expect(spentOf(1.5, 35)).toBe('$1.50/$35')
  const usage = { fiveHour: { usd: 0.06, resetsAt: null }, weekly: { usd: 1.41, resetsAt: null }, measuredAt: 0 }
  expect(statusLine({ isOn: true, headModel: 'a/m', effort: 'auto' }, usage, { fiveHourUsd: 0, weeklyUsd: 0 })).toBe('🐉 m · auto | Heads 5h $0.06 | 7d $1.41')
})

test('keeps the rules file for other sessions\' live Heads only, and this session\'s from memory', async () => {
  const entry = (key: string, until: number) => ({ key, until, addDirs: [], shell: false })
  const inFile = [entry('me/a', 100), entry('other/b', 100), entry('other/old', 5)]
  expect(mergeHeads(inFile, [], 'me', 10).map(head => head.key)).toEqual(['other/b'])
  expect(mergeHeads(inFile, [entry('me/c', 100)], 'me', 10).map(head => head.key)).toEqual(['other/b', 'me/c'])
  expect(mergeHeads([entry('me/a', 100)], [], 'me', 10)).toEqual([])
})

test('keeps the last lines of a Head\'s report, without the done mark', async () => {
  expect(summaryOf(`a\n\nb\nc\nd\ne\nf\ng\n${DONE_MARK}`)).toBe('b\nc\nd\ne\nf\ng')
  expect(summaryOf(DONE_MARK)).toBeUndefined()
})

test('says what to run when the machine is not ready', async () => {
  const text = preflightText({ problems: ['The Command Code CLI is not installed. Run `npm i -g command-code`.'], warnings: [] })
  expect(text).toContain('npm i -g command-code')
  expect(text).toContain('/hydra again')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`shows a finished Head's edited files and report, and moves with j/k (${surface})`, async ($, on) => {
    const finished: HeadRun = { ...LIVE_RUNS[1]!, files: ['a.kt', 'b.kt'], summary: 'Converted both files.' }
    serveRuns(on, [LIVE_RUNS[0]!, finished])
    const pane = await $.ui.mount({
      plugin: 'hydra', surface, component: 'Pane', requestId: 'hydra-heads',
      props: { title: 'Heads', isFocused: true, bodyColumns: 80, placement: 'dock', scroll, view: {} },
    })
    expect(textOf(await pane.drawn())).toContain('j/k')
    await $.ui.press({ plugin: 'hydra', key: 'prev-head', surface })
    const picked = textOf(await pane.drawn())
    expect(picked).toContain('edited (2): a.kt, b.kt')
    expect(picked).toContain('Converted both files.')
  })
}

test('refuses Windows project paths, which Command Code cannot deny writes to', async () => {
  expect(windowsPathRefusal('D:/projects/app')).toContain('WSL')
  expect(windowsPathRefusal('C:\\Users\\me\\app')).toContain('WSL')
  expect(windowsPathRefusal('\\\\server\\share')).toContain('WSL')
  expect(windowsPathRefusal('/Users/me/app')).toBeUndefined()
})

test('leaves a way down to each folder a Head may write to, and keeps its secrets and history protected', async () => {
  const listings: Record<string, string[]> = { '/': ['Users'], '/Users': ['me'], '/Users/me': ['app', 'shared', 'other'] }
  const rules = ancestorDenyRules(['/Users/me/app', '/Users/me/shared'], dir => listings[dir] ?? [])
  expect(rules).toContain('Edit(//Users/me/other/**)')
  expect(rules).toContain('Edit(//Users/me/*)')
  expect(rules.some(rule => rule.includes('/shared') || rule.includes('/app'))).toBe(false)
  expect([...waysDown(['/a/b/app', '/a/b/app/inner']).keys()]).toEqual(['', '/a', '/a/b'])

  const settings = headSettings([{ addDirs: ['/brief'], shell: false, writeDirs: ['/Users/me/shared'] }], [])
  for (const rule of writeDirDeny('/Users/me/shared')) expect(settings.permissions?.deny).toContain(rule)
  expect(writeDirDeny('/Users/me/shared')).toContain('Edit(//Users/me/shared/**/.env)')
  expect(settings.permissions?.additionalDirectories).toEqual(['/brief', '/Users/me/shared'])
  expect(guardCommand('/p', '/Users/me/app', ['/Users/me/shared'])).toBe("/usr/bin/env python3 -I '/p/bin/head-guard.py' '/Users/me/app' '/Users/me/shared'")
})

test('flags writes outside the project only when no granted folder holds them', async () => {
  expect(outsideFiles('/r', ['/r/a.kt', '/s/b.kt', '/t/c.kt'], ['/s'])).toEqual(['/t/c.kt'])
  expect(outsideFiles('/r', ['/rx/a.kt'])).toEqual(['/rx/a.kt'])
  expect(formatReport({ id: 'h', model: 'm', cwd: '/r', finished: true, rounds: 1, turns: 1, usd: 0, files: ['/s/b.kt'], denied: [], finalText: '', exit: '0', writeDirs: ['/s'] }))
    .toContain('may also write: /s')
})
