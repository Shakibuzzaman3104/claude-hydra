/**
 * @author Shakib
 * @since 23/10/26
 */
import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import {
  SIGNED_OUT_COOLDOWN_MS, accountsOf, addAccount, cooldownFrom, coolingLines, isModelUnavailable, isQuotaFailure, isSignedOutFailure, readAccountNames, removeAccount,
  rotateAccounts, signedInOf, timeOf,
} from './lib/accounts'
import { ENGINES, FALLBACK_ORDER, isModelFor, modelAlternates, modelOn, usagePoolOf } from './lib/engines'
import { agyBlockedUntil, parseAgyUsage } from './engines/agy'
import { fallbackRoutes } from './engines/index'

const MIN = 60_000
const NOW = Date.parse('2026-10-23T06:00:00Z')

/** A `$` with an in-memory store, a home folder and account folders on disk: `dirs` maps a folder to the names in it. */
const withDisk = (entries: Record<string, unknown> = {}, dirs: Record<string, string[]> = {}, now = NOW) => {
  const kept = new Map(Object.entries(entries))
  const $ = {
    store: { get: async (key: string) => kept.get(key), set: async (key: string, value: unknown) => void kept.set(key, JSON.parse(JSON.stringify(value))) },
    env: { get: async (name: string) => (name === 'HOME' ? '/home/me' : undefined) },
    clock: { now: async () => now },
    fs: {
      write: async () => undefined,
      exists: async () => false,
      list: async (path: string) => (dirs[path] ?? []).map(name => ({ name, kind: name.startsWith('.') ? 'file' : 'dir' })),
    },
  } as unknown as EngineInterface
  return { $, kept }
}

const ACCOUNTS = '/home/me/.claude/hydra/accounts'

// ---- models, pools and the fallback order ----
test('each CodeBuddy model and each Antigravity pool is its own usage pool; other engines have none', async () => {
  expect(usagePoolOf('codebuddy', 'deepseek/deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash')
  expect(usagePoolOf('workbuddy', 'GLM-5.3')).toBe('glm-5.3')
  expect(usagePoolOf('agy', 'gemini-4-argon-high')).toBe('argon')
  expect(usagePoolOf('agy', 'gpt-oss-120b')).toBe('claude')
  expect(usagePoolOf('codex', 'gpt-6.1-sol')).toBeUndefined()
  expect(usagePoolOf('commandcode', 'deepseek/deepseek-v4.1-flash')).toBeUndefined()
})

test('a model cut off moves to a model in another pool on the same engine first', async () => {
  expect(modelAlternates('agy', 'gemini-4-argon')).toEqual(['claude-sonnet-5-5', 'gemini-3.8-flash'])
  expect(modelAlternates('agy', 'claude-opus-5-5')).not.toContain('claude-sonnet-5-5')
  expect(modelAlternates('codebuddy', 'deepseek-v4.1-flash')).toEqual(['glm-5.3', 'kimi-k3', 'minimax-m3.1-flash'])
  expect(modelAlternates('codex', 'gpt-6.1-sol')).toEqual([])
})

test('CodeBuddy takes its own GPT and Gemini model names, which no longer get dropped', async () => {
  expect(isModelFor('codebuddy', 'gpt-5.6-terra')).toBe(true)
  expect(isModelFor('workbuddy', 'gemini-3.5-flash')).toBe(true)
  expect(isModelFor('codebuddy', 'gpt-6.1-sol')).toBe(false)
  expect(isModelFor('codex', 'gpt-5.6-terra')).toBe(true)
})

test('picks the model each engine runs when a Head moves to it', async () => {
  expect(modelOn('codex', undefined, 'deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash')).toBe('gpt-6.1-sol')
  expect(modelOn('codebuddy', undefined, 'deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash')
  expect(modelOn('agy', 'gemini-4-argon-high', 'gpt-6.1-sol', 'deepseek/deepseek-v4.1-flash')).toBe('gemini-4-argon')
  expect(modelOn('agy', 'kimi-k3', 'gpt-6.1-sol', 'deepseek/deepseek-v4.1-flash')).toBe('gemini-3.8-flash')
  expect(modelOn('commandcode', 'gpt-6.1-sol', 'gpt-6.1-sol', 'deepseek/deepseek-v4.1-flash')).toBe('deepseek/deepseek-v4.1-flash')
})

test('every engine falls back to every other engine exactly once', async () => {
  for (const engine of ENGINES) expect([...FALLBACK_ORDER[engine]].sort()).toEqual(ENGINES.filter(other => other !== engine).sort())
})

test('fallback routes: same-engine models first, then other engines in order, inside a chosen pool', async () => {
  const routing = { headModel: 'deepseek/deepseek-v4.1-flash', configured: 'deepseek/deepseek-v4.1-flash', fallback: true }
  const routes = fallbackRoutes('codebuddy', { engine: 'codebuddy', model: 'deepseek-v4.1-flash' }, 'quota', routing)
  expect(routes.slice(0, 4)).toEqual([
    { engine: 'codebuddy', model: 'glm-5.3' },
    { engine: 'codebuddy', model: 'kimi-k3' },
    { engine: 'codebuddy', model: 'minimax-m3.1-flash' },
    { engine: 'workbuddy', model: 'deepseek-v4.1-flash' },
  ])
  expect(routes.map(route => route.engine).slice(3)).toEqual(['workbuddy', 'commandcode', 'agy', 'codex', 'opencode'])
  // A lost sign-in is the account's, not the model's: no other model of the same engine.
  expect(fallbackRoutes('codebuddy', { engine: 'codebuddy', model: 'deepseek-v4.1-flash' }, 'signed out', routing)[0]).toEqual({ engine: 'workbuddy', model: 'deepseek-v4.1-flash' })
  const pinned = fallbackRoutes('codex', { engine: 'codex', model: 'gpt-6.1-sol' }, 'quota', { ...routing, pool: ['codex', 'agy'] })
  expect(pinned).toEqual([{ engine: 'agy', model: 'gemini-3.8-flash' }])
})

// ---- Antigravity's own quota report ----
const USAGE = JSON.stringify({
  event: 'command_result',
  command: {
    name: 'usage',
    data: {
      groups: [
        { name: 'Gemini Models', buckets: [{ window: 'weekly', remaining_fraction: 0.92, reset_time: '2026-10-25T14:01:25Z' }, { window: '5h', remaining_fraction: 0, reset_time: '2026-10-23T10:27:53Z' }] },
        { name: 'Claude and GPT models', buckets: [{ window: 'weekly', remaining_fraction: 1, reset_time: '2026-10-30T02:48:27Z' }, { window: '5h', remaining_fraction: 1, reset_time: '2026-10-23T12:07:44Z' }] },
        { name: 'Gemini 4 Argon', buckets: [{ window: 'weekly', remaining_fraction: 0.004, reset_time: '2026-10-29T17:36:18Z' }] },
      ],
    },
  },
})

test('reads Antigravity quota buckets into Hydra pools and says when a spent pool frees up', async () => {
  const buckets = parseAgyUsage(`noise\n${USAGE}\n{"event":"result"}`)
  expect(buckets.map(bucket => `${bucket.pool}/${bucket.window}`)).toEqual(['gemini/weekly', 'gemini/5h', 'claude/weekly', 'claude/5h', 'argon/weekly'])
  expect(agyBlockedUntil(buckets, 'gemini-3.8-flash')).toBe(Date.parse('2026-10-23T10:27:53Z'))
  expect(agyBlockedUntil(buckets, 'gemini-4-argon-low')).toBe(Date.parse('2026-10-29T17:36:18Z'))
  expect(agyBlockedUntil(buckets, 'claude-opus-5-5')).toBeUndefined()
  expect(parseAgyUsage('not json')).toEqual([])
})

test('on a plan with no Argon group (Ultra), Argon reads the Gemini buckets', async () => {
  const buckets = parseAgyUsage(USAGE).filter(bucket => bucket.pool !== 'argon')
  expect(agyBlockedUntil(buckets, 'gemini-4-argon')).toBe(Date.parse('2026-10-23T10:27:53Z'))
})

// ---- failure wording ----
test('tells a lost sign-in from a usage limit', async () => {
  for (const text of ['Error: 401 Unauthorized', 'You are not logged in. Please log in.', 'authentication failed or timed out', 'Invalid API key', 'session expired']) {
    expect(isSignedOutFailure(text)).toBe(true)
  }
  expect(isSignedOutFailure('429 usage exceeds frequency limit')).toBe(false)
  expect(isSignedOutFailure('Error: connect ECONNREFUSED')).toBe(false)
  expect(isSignedOutFailure(undefined)).toBe(false)
})

test('tells a model that cannot run (unknown, retired) from other failures, and moves the Head', async () => {
  for (const text of ['Error: unknown model "bogus/x".', 'invalid model selection', 'The model gpt-oss-120b is not available', 'model has been retired']) expect(isModelUnavailable(text)).toBe(true)
  expect(isModelUnavailable('429 Too Many Requests for model x')).toBe(false)
  expect(isModelUnavailable('Error: connect ECONNREFUSED')).toBe(false)
  const { result } = await rotate(['default'], [{ text: 'x', isDone: false, failure: 'invalid model selection' }])
  expect(result.engineBound).toBe('unavailable')
})

test('reads Antigravity "refreshes in" and CodeBuddy reset wording', async () => {
  expect(cooldownFrom('Claude and GPT models: Refreshes in 18 hours, 10 minutes', NOW)).toBe(NOW + (18 * 60 + 10) * MIN)
  expect(cooldownFrom('it will fully refresh in 2 days, 6 hours.', NOW)).toBe(NOW + 54 * 60 * MIN)
  const codebuddy = "429 usage exceeds frequency limit, but don't worry, your usage will reset at 2026-10-23 22:39:04 UTC+8, alternatively, you can switch to the other models"
  expect(isQuotaFailure(codebuddy)).toBe(true)
  expect(cooldownFrom(codebuddy, NOW)).toBe(Date.parse('2026-10-23T14:39:04Z'))
})

// ---- accounts on disk ----
test('finds account folders the store forgot, and a removed one stays removed until added again', async () => {
  const { $ } = withDisk({ 'accounts-v1': { codebuddy: ['b', 'd'] } }, { [`${ACCOUNTS}/codebuddy`]: ['b', 'd', 'shakib-c', 'Bad Name', '.DS_Store'], [`${ACCOUNTS}/codex`]: ['work'] })
  expect(await readAccountNames($)).toEqual({ codebuddy: ['b', 'd', 'shakib-c'], codex: ['work'] })
  expect((await accountsOf($, 'codebuddy')).map(account => account.name)).toEqual(['default', 'b', 'd', 'shakib-c'])
  expect(await removeAccount($, 'codebuddy', 'shakib-c')).toEqual({ dir: `${ACCOUNTS}/codebuddy/shakib-c` })
  expect((await readAccountNames($)).codebuddy).toEqual(['b', 'd'])
  await addAccount($, 'codebuddy', 'shakib-c')
  expect((await readAccountNames($)).codebuddy).toEqual(['b', 'd', 'shakib-c'])
})

test('a CodeBuddy account is signed in when its folder holds the credentials file', async () => {
  const dir = `${ACCOUNTS}/codebuddy`
  const { $ } = withDisk({}, { [`${dir}/a`]: ['.keep', '.credentials.json', 'settings.json'], [`${dir}/b`]: ['.keep'], [`${dir}/c`]: ['settings.json'] })
  expect(await signedInOf($, { engine: 'codebuddy', name: 'a', dir: `${dir}/a` })).toBe(true)
  expect(await signedInOf($, { engine: 'codebuddy', name: 'b', dir: `${dir}/b` })).toBe(false)
  expect(await signedInOf($, { engine: 'codebuddy', name: 'c', dir: `${dir}/c` })).toBeUndefined()
})

// ---- rotation ----
type Outcome = { text: string; isDone: boolean; failure?: string; files?: string[]; engineBound?: 'quota' | 'signed out' | 'unavailable' }

const rotate = async (names: string[], outcomes: Outcome[], cooling: Record<string, number> = {}) => {
  const started: string[] = []
  const cooled: [string, number][] = []
  const signedOut: string[] = []
  let next = 0
  const result = await rotateAccounts<Outcome>({
    count: names.length,
    minutes: 40,
    cwd: '/p',
    engine: 'codebuddy',
    pool: 'deepseek-v4.1-flash',
    isAborted: () => false,
    pick: async tried => {
      const free = names.find(name => !tried.includes(`codebuddy/${name}`) && !((cooling[`codebuddy/${name}`] ?? 0) > NOW))
      return free ? { account: { engine: 'codebuddy', name: free } } : { account: null, until: null }
    },
    now: async () => NOW,
    begin: async name => void started.push(name),
    run: async () => outcomes[next++]!,
    cooled: async (name, until) => void cooled.push([name, until]),
    signedOut: async name => void signedOut.push(name),
    refuse: async reason => ({ text: `not started: ${reason}`, isDone: false }),
  })
  return { result, started, cooled, signedOut }
}

const LIMIT = 'usage exceeds frequency limit, your usage will reset at 2026-10-23 22:39:04 UTC+8'

test('one account still records its limit, per model, and says the engine stopped the Head', async () => {
  const { result, cooled } = await rotate(['default'], [{ text: 'cut off', isDone: false, failure: LIMIT }])
  expect(cooled).toEqual([['codebuddy/default#deepseek-v4.1-flash', Date.parse('2026-10-23T14:39:04Z')]])
  expect(result.engineBound).toBe('quota')
  expect(result.text.split('\n')[0]).toMatch(/^accounts: codebuddy\/default \(usage limit, cooling until \d\d:\d\d\)$/)
})

test('one account that finishes adds no accounts line', async () => {
  const { result } = await rotate(['default'], [{ text: 'report', isDone: true }])
  expect(result).toEqual({ text: 'report', isDone: true })
})

test('a signed-out account is passed over for the next one', async () => {
  const { result, started, signedOut, cooled } = await rotate(['default', 'b'], [{ text: 'x', isDone: false, failure: 'Error: 401 Unauthorized' }, { text: 'done', isDone: true }])
  expect(started).toEqual(['codebuddy/default', 'codebuddy/b'])
  expect(signedOut).toEqual(['codebuddy/default'])
  expect(cooled).toEqual([])
  expect(result.engineBound).toBeUndefined()
  expect(result.text.split('\n')[0]).toBe('accounts: codebuddy/default (not signed in) → codebuddy/b')
})

test('every account signed out ends as an engine-bound failure', async () => {
  const { result } = await rotate(['default'], [{ text: 'x', isDone: false, failure: 'authentication failed' }])
  expect(result.engineBound).toBe('signed out')
})

test('a Head that cannot start because every account is cooling is engine-bound', async () => {
  const { result, started } = await rotate(['default'], [], { 'codebuddy/default': NOW + 30 * MIN })
  expect(started).toEqual([])
  expect(result.engineBound).toBe('quota')
})

test('a task failure is never engine-bound', async () => {
  const { result } = await rotate(['default'], [{ text: 'x', isDone: false, failure: 'Error: connect ECONNREFUSED' }])
  expect(result.engineBound).toBeUndefined()
})

// ---- what the Lead is told ----
test('names the engines and pools whose every account is at its limit', async () => {
  const { $ } = withDisk({
    'accounts-v1': { codebuddy: ['b'] },
    'cooldowns-v1': {
      'codebuddy/default#deepseek-v4.1-flash': NOW + 60 * MIN,
      'codebuddy/b#deepseek-v4.1-flash': NOW + 90 * MIN,
      'agy/default#argon': NOW + 120 * MIN,
      'codex/default': NOW + 30 * MIN,
      'commandcode/default': NOW - MIN,
    },
  })
  expect(await coolingLines($, ['codebuddy', 'agy', 'codex', 'commandcode'])).toEqual([
    `codebuddy deepseek-v4.1-flash: every account at its limit until ${timeOf(NOW + 60 * MIN)}`,
    `agy Gemini 4 Argon: every account at its limit until ${timeOf(NOW + 120 * MIN)}`,
    `codex: every account at its limit until ${timeOf(NOW + 30 * MIN)}`,
  ])
  expect(SIGNED_OUT_COOLDOWN_MS).toBe(10 * MIN)
})
