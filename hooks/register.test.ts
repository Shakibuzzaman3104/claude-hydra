/**
 * @author Shakib
 * @since 06/10/26
 */
import { expect, test } from 'claude-code/testing'

import {
  barOf, continuePrompt, DANGEROUS_SHELL, DONE_MARK, formatReport, headSettings, outsideFiles, PROJECT_DENY, isFinished, isResumable, leadLabel, parseHydraArgs,
  relativeTo, resetsIn, statusLine, createGate, createJobQueue,
} from './register'

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

test('summarises both sides in the status line', async () => {
  const line = statusLine(
    [{ kind: 'five_hour', percentUsed: 30 }, { kind: 'seven_day', percentUsed: 93 }],
    { fiveHour: { usd: 1.5, resetsAt: null }, weekly: { usd: 3, resetsAt: null }, measuredAt: 0 },
    14,
  )
  expect(line).toBe('Lead 5h 30% wk 93% │ Heads 5h $1.50/$14')
  expect(statusLine([], null, 14)).toBeUndefined()
})

test('parses /hydra arguments', async () => {
  expect(parseHydraArgs('')).toEqual({ action: 'on', leadModel: undefined, headModel: undefined, task: '' })
  expect(parseHydraArgs('off').action).toBe('off')
  expect(parseHydraArgs('opus head=moonshotai/kimi-k3 build the login screen')).toEqual({
    action: 'on',
    leadModel: 'opus',
    headModel: 'moonshotai/kimi-k3',
    task: 'build the login screen',
  })
  expect(parseHydraArgs('fix the opus label').leadModel).toBeUndefined()
})

test('shows Hydra first in the status line while it is on', async () => {
  const line = statusLine([], null, 14, { isOn: true, headModel: 'deepseek/deepseek-v4.1-flash' }, 2, 17)
  expect(line).toBe('🐉 Hydra · deepseek-v4.1-flash · 2 running · 17 turns')
  expect(statusLine([], null, 14, { isOn: true, headModel: 'deepseek/deepseek-v4.1-flash' })).toBe('🐉 Hydra · deepseek-v4.1-flash')
  expect(statusLine([], null, 14, { isOn: false, headModel: 'x' })).toBeUndefined()
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
