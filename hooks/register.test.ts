/**
 * @author Shakib
 * @since 06/10/26
 */
import { expect, test } from 'claude-code/testing'

import { barOf, leadLabel, parseHydraArgs, resetsIn, statusLine } from './register'

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
  const line = statusLine([], null, 14, { isOn: true, headModel: 'deepseek/deepseek-v4.1-flash' }, 2)
  expect(line).toBe('🐉 Hydra · deepseek-v4.1-flash · 2 running')
  expect(statusLine([], null, 14, { isOn: false, headModel: 'x' })).toBeUndefined()
})
