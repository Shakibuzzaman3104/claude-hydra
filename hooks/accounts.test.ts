/**
 * @author Shakib
 * @since 15/10/26
 */
import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import {
  ACCOUNT_SUPPORT, COOLDOWN_DEFAULT_MS, COOLDOWN_MAX_MS, accountEnv, accountOverview, accountsLine, accountsOf, accountsText, addAccount, allCoolingText,
  cooldownFrom, isAccountName, isQuotaFailure, loginInstructions, parseAccountsArgs, pickAccount, readAccountNames, readCooldowns, recordCooldown,
  removeAccount, rotateAccounts, rowText, supportsAccounts, switchNote, timeOf, withEnv,
} from './lib/accounts'
import type { Account } from './lib/accounts'
import { parseHydraArgs, HYDRA_HELP, HYDRA_POLICY } from './lib/policy'

/** A `$` with an in-memory store, a home folder, a clock and a file system that records writes: what the accounts code touches. */
const withHome = (entries: Record<string, unknown> = {}, now = 1_000_000) => {
  const kept = new Map(Object.entries(entries))
  const written: string[] = []
  const $ = {
    store: { get: async (key: string) => kept.get(key), set: async (key: string, value: unknown) => void kept.set(key, JSON.parse(JSON.stringify(value))) },
    env: { get: async (name: string) => (name === 'HOME' ? '/home/me' : undefined) },
    clock: { now: async () => now },
    fs: { write: async (path: string) => void written.push(path), list: async () => [], exists: async () => false },
  } as unknown as EngineInterface
  return { $, kept, written }
}

const NOW = Date.parse('2026-10-15T12:00:00Z')
const MIN = 60_000

// ---- quota failures ----
test('recognises usage and rate limit wording in a CLI failure', async () => {
  for (const text of [
    'You have hit your usage limit. Try again in 3 hours.',
    'Error: 429 Too Many Requests',
    'rate limit exceeded for gpt-6.1-sol',
    'Rate-limit reached',
    'insufficient_quota: You exceeded your current quota',
    'RESOURCE_EXHAUSTED: quota exceeded for gemini-3.8-flash',
    'Credits exhausted. Please top up.',
    'You are out of credits',
    'The 5 hour limit reached',
    'Please try again in 20 minutes',
    'usage exceeds frequency limit',
  ]) expect(isQuotaFailure(text)).toBe(true)
})

test('does not read ordinary text as a quota failure', async () => {
  expect(isQuotaFailure(undefined)).toBe(false)
  expect(isQuotaFailure('')).toBe(false)
  // Failure text only: a stderr with a crash or a network problem is the Head's own failure.
  expect(isQuotaFailure('Error: connect ECONNREFUSED 127.0.0.1:443')).toBe(false)
  expect(isQuotaFailure('Segmentation fault (core dumped)')).toBe(false)
  expect(isQuotaFailure('permission denied: /etc/hosts')).toBe(false)
  expect(isQuotaFailure('port 14290 is in use')).toBe(false)
  expect(isQuotaFailure('stopped at the 60-turn cap')).toBe(false)
})

// ---- cooldowns ----
test('reads the wait from a "try again in" message', async () => {
  expect(cooldownFrom('Try again in 45 minutes.', NOW)).toBe(NOW + 45 * MIN)
  expect(cooldownFrom('usage limit. try again in 2 hours 30 minutes', NOW)).toBe(NOW + 150 * MIN)
  expect(cooldownFrom('try again in 90 seconds', NOW)).toBe(NOW + 90_000)
  expect(cooldownFrom('Try again in 1.5 hours.', NOW)).toBe(NOW + 90 * MIN)
  expect(cooldownFrom('rate limited, try again in 1d 2h', NOW)).toBe(NOW + 26 * 3_600_000)
  expect(cooldownFrom('retry-after: 120', NOW)).toBe(NOW + 120_000)
  expect(cooldownFrom('rate limited, retry in 1500ms', NOW)).toBe(NOW + 1_500)
})

test('reads the wall-clock time a CLI says to try again at', async () => {
  const at = new Date(NOW + 3 * 3_600_000)
  const stamp = at.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(',', 'th,')
  const expected = new Date(at).setSeconds(0, 0)
  expect(cooldownFrom(`You've hit your usage limit. Try again at ${stamp}.`, NOW)).toBe(expected)
  const clock = new Date(NOW + 2 * 3_600_000)
  const hhmm = `${clock.getHours()}:${String(clock.getMinutes()).padStart(2, '0')}`
  expect(cooldownFrom(`limit reached, try again at ${hhmm}`, NOW)).toBe(new Date(clock).setSeconds(0, 0))
})

test('reads a reset time when the wait is not given', async () => {
  expect(cooldownFrom('quota exceeded, resets at 2026-10-15T14:05:00Z', NOW)).toBe(Date.parse('2026-10-15T14:05:00Z'))
  expect(cooldownFrom('limit reached {"resetsAt": 1792072800}', NOW)).toBe(1792072800 * 1000)
  expect(cooldownFrom('limit reached, reset_time: 1792072800000', NOW)).toBe(1792072800000)
  expect(cooldownFrom("429 usage exceeds frequency limit, but don't worry, your usage will reset at 2026-10-17 11:28:41 UTC+8", NOW)).toBe(Date.parse('2026-10-17T03:28:41Z'))
  expect(cooldownFrom('limit reached, resets at 2026-10-16 09:30 GMT-05:00', NOW)).toBe(Date.parse('2026-10-16T14:30:00Z'))
  expect(cooldownFrom('limit reached, resets at 2026-10-16 09:30:00 UTC', NOW)).toBe(Date.parse('2026-10-16T09:30:00Z'))
  expect(cooldownFrom('limit reached, resets at 2026-10-16 09:30', NOW)).toBe(new Date(2026, 9, 16, 9, 30).getTime())
  // A reset time in the past is no use.
  expect(cooldownFrom('quota exceeded, resets at 2020-01-01T00:00:00Z', NOW)).toBe(NOW + COOLDOWN_DEFAULT_MS)
})

test('defaults to an hour and never waits more than 7 days', async () => {
  expect(cooldownFrom('usage limit reached', NOW)).toBe(NOW + 60 * MIN)
  expect(cooldownFrom('try again in 30 days', NOW)).toBe(NOW + COOLDOWN_MAX_MS)
  expect(cooldownFrom('resets at 2030-01-01T00:00:00Z', NOW)).toBe(NOW + COOLDOWN_MAX_MS)
  expect(cooldownFrom('try again in 1 second', NOW)).toBe(NOW + 1_000)
})

// ---- picking ----
const acc = (engine: Account['engine'], name: string): Account => ({ engine, name, ...(name === 'default' ? {} : { dir: `/h/${engine}/${name}` }) })
const ACCOUNTS = [acc('codex', 'default'), acc('codex', 'work'), acc('codex', 'team')]

test('fill takes the first free account, the default one first', async () => {
  expect(pickAccount('codex', ACCOUNTS, {}, NOW, 'fill')).toEqual({ account: ACCOUNTS[0] })
  expect(pickAccount('codex', ACCOUNTS, { 'codex/default': NOW + MIN }, NOW, 'fill')).toEqual({ account: ACCOUNTS[1] })
  expect(pickAccount('codex', ACCOUNTS, { 'codex/default': NOW + MIN, 'codex/work': NOW + MIN }, NOW, 'fill')).toEqual({ account: ACCOUNTS[2] })
})

test('a cooldown that has lapsed no longer counts', async () => {
  expect(pickAccount('codex', ACCOUNTS, { 'codex/default': NOW - 1 }, NOW, 'fill')).toEqual({ account: ACCOUNTS[0] })
  expect(pickAccount('codex', ACCOUNTS, { 'codex/default': NOW }, NOW, 'fill')).toEqual({ account: ACCOUNTS[0] })
})

test('spread takes the least recently used free account', async () => {
  const used = { 'codex/default': NOW - 5 * MIN, 'codex/work': NOW - 30 * MIN }
  expect(pickAccount('codex', ACCOUNTS, {}, NOW, 'spread', used)).toEqual({ account: ACCOUNTS[2] }) // never used
  expect(pickAccount('codex', ACCOUNTS, {}, NOW, 'spread', { ...used, 'codex/team': NOW - MIN })).toEqual({ account: ACCOUNTS[1] })
  expect(pickAccount('codex', ACCOUNTS, { 'codex/work': NOW + MIN }, NOW, 'spread', { ...used, 'codex/team': NOW - MIN })).toEqual({ account: ACCOUNTS[0] })
  // Ties go to the earlier account in the list.
  expect(pickAccount('codex', ACCOUNTS, {}, NOW, 'spread')).toEqual({ account: ACCOUNTS[0] })
})

test('skips accounts it was told to skip', async () => {
  expect(pickAccount('codex', ACCOUNTS, {}, NOW, 'fill', {}, ['codex/default'])).toEqual({ account: ACCOUNTS[1] })
  expect(pickAccount('codex', ACCOUNTS, {}, NOW, 'fill', {}, ['codex/default', 'codex/work', 'codex/team'])).toEqual({ account: null, until: null })
})

test('says when the earliest account frees up when all are cooling', async () => {
  const cooling = { 'codex/default': NOW + 50 * MIN, 'codex/work': NOW + 20 * MIN, 'codex/team': NOW + 90 * MIN }
  expect(pickAccount('codex', ACCOUNTS, cooling, NOW, 'fill')).toEqual({ account: null, until: NOW + 20 * MIN })
  // Another engine's accounts never count.
  expect(pickAccount('agy', ACCOUNTS, cooling, NOW, 'fill')).toEqual({ account: null, until: null })
  const text = allCoolingText('codex', NOW + 20 * MIN)
  expect(text.startsWith('all accounts of codex are at their usage limit')).toBe(true)
  expect(text).toContain(timeOf(NOW + 20 * MIN))
  expect(HYDRA_POLICY('m', 'auto', 'auto', ['codex', 'agy'])).toContain('Hydra moves it on its own')
  expect(HYDRA_POLICY('m', 'auto', 'codex', ['codex'])).toContain('`fallback:` line')
  expect(HYDRA_POLICY('m', 'auto', 'auto', ['codex', 'agy'], { fallback: false })).toContain('all accounts of <engine> are at their usage limit')
})

test('the report line names the accounts used and the switch', async () => {
  expect(accountsLine([{ id: 'codex/work' }])).toBe('accounts: codex/work')
  expect(accountsLine([{ id: 'codex/default', until: NOW + 30 * MIN }, { id: 'codex/work' }])).toBe(`accounts: codex/default (usage limit, cooling until ${timeOf(NOW + 30 * MIN)}) → codex/work`)
  expect(switchNote(['a.kt', 'b.kt'])).toBe('A previous attempt on another account stopped at a usage limit. Files it already changed: a.kt, b.kt. Check them and continue from the current state.')
  expect(switchNote([])).toContain('none recorded')
})

// ---- login commands ----
test('writes the login command for each engine on macOS, Linux and Windows', async () => {
  expect(ACCOUNT_SUPPORT.codex!.login('/h/codex/work', 'darwin')).toBe('CODEX_HOME="/h/codex/work" codex login')
  expect(ACCOUNT_SUPPORT.codex!.login('/h/codex/work', 'linux')).toBe('CODEX_HOME="/h/codex/work" codex login')
  expect(ACCOUNT_SUPPORT.codex!.login('C:/Users/me/work', 'windows')).toBe('$env:CODEX_HOME="C:/Users/me/work"; codex login')
  expect(ACCOUNT_SUPPORT.codebuddy!.login('/h/cb/x', 'darwin')).toBe('CODEBUDDY_CONFIG_DIR="/h/cb/x" codebuddy')
  expect(ACCOUNT_SUPPORT.codebuddy!.login('C:/h/cb/x', 'windows')).toBe('$env:CODEBUDDY_CONFIG_DIR="C:/h/cb/x"; codebuddy')
  expect(ACCOUNT_SUPPORT.agy!.login('/h/agy/x', 'darwin')).toBe('HOME="/h/agy/x" agy')
  expect(withEnv('windows', { A: '1', B: '2' }, 'run')).toBe('$env:A="1"; $env:B="2"; run')
  const mac = loginInstructions('codex', 'work', '/h/codex/work', 'darwin')
  expect(mac).toContain('  CODEX_HOME="/h/codex/work" codex login')
  expect(mac).toContain('separate terminal')
  expect(mac).toContain('--device-auth')
  const win = loginInstructions('codex', 'work', 'C:/h/work', 'windows')
  expect(win).toContain('PowerShell')
  expect(win).toContain('$env:CODEX_HOME="C:/h/work"; codex login')
  expect(win).not.toContain('! ')
  expect(loginInstructions('agy', 'work', '/h/agy/work', 'linux')).toContain('Google OAuth')
  expect(loginInstructions('codebuddy', 'work', '/h/cb/work', 'linux')).toContain('/login')
})

test('only some engines can hold several accounts', async () => {
  expect(supportsAccounts('codex')).toBe(true)
  expect(supportsAccounts('codebuddy')).toBe(true)
  expect(supportsAccounts('agy')).toBe(true)
  expect(supportsAccounts('commandcode')).toBe(false)
  expect(accountEnv(acc('codex', 'work'))).toEqual({ CODEX_HOME: '/h/codex/work' })
  expect(accountEnv(acc('codebuddy', 'work'))).toEqual({ CODEBUDDY_CONFIG_DIR: '/h/codebuddy/work' })
  expect(accountEnv(acc('codex', 'default'))).toBeUndefined()
  expect(accountEnv(acc('agy', 'work'))).toBeUndefined() // Antigravity runs with its own HOME: only the token source changes
  expect(accountEnv(undefined)).toBeUndefined()
})

// ---- /hydra accounts … ----
test('parses /hydra accounts arguments', async () => {
  expect(parseHydraArgs('accounts')).toMatchObject({ action: 'accounts', task: '', unknown: undefined })
  expect(parseHydraArgs('accounts add codex work')).toMatchObject({ action: 'accounts', task: 'add codex work', unknown: undefined })
  expect(parseHydraArgs('accounts reset')).toMatchObject({ action: 'accounts', task: 'reset', unknown: undefined })
  expect(parseHydraArgs('accounts remove codex work').task).toBe('remove codex work')
  // The older forms are unchanged.
  expect(parseHydraArgs('engines').action).toBe('engines')
  expect(parseHydraArgs('build the accounts page')).toMatchObject({ action: 'on', task: 'build the accounts page' })
  expect(HYDRA_HELP).toContain('/hydra accounts')

  expect(parseAccountsArgs('')).toEqual({ kind: 'list' })
  expect(parseAccountsArgs('add codex work')).toEqual({ kind: 'add', engine: 'codex', name: 'work' })
  expect(parseAccountsArgs('add CODEX personal')).toEqual({ kind: 'add', engine: 'codex', name: 'personal' })
  expect(parseAccountsArgs('add agy')).toEqual({ kind: 'add', engine: 'agy', name: 'work' })
  expect(parseAccountsArgs('remove codex work')).toEqual({ kind: 'remove', engine: 'codex', name: 'work' })
  expect(parseAccountsArgs('reset')).toEqual({ kind: 'reset' })
  expect(parseAccountsArgs('add nope work')).toMatchObject({ kind: 'error' })
  expect(parseAccountsArgs('add')).toMatchObject({ kind: 'error' })
  expect(parseAccountsArgs('remove codex')).toMatchObject({ kind: 'error' })
  expect(parseAccountsArgs('add codex a b')).toMatchObject({ kind: 'error' })
  expect(parseAccountsArgs('frobnicate')).toMatchObject({ kind: 'error' })
})

test('account names are lowercase kebab, up to 20 characters', async () => {
  for (const name of ['work', 'team-2', 'a', 'x'.repeat(20)]) expect(isAccountName(name)).toBe(true)
  for (const name of ['', 'Work', 'my_acct', '-x', 'x-', 'a--b', 'default', 'x'.repeat(21), 'a b', '../x']) expect(isAccountName(name)).toBe(false)
})

// ---- the store ----
test('adds an account: validates, creates the folder and saves the name', async () => {
  const { $, kept, written } = withHome()
  const added = await addAccount($, 'codex', 'work')
  expect(added).toEqual({ account: { engine: 'codex', name: 'work', dir: '/home/me/.claude/hydra/accounts/codex/work' } })
  expect(written).toEqual(['/home/me/.claude/hydra/accounts/codex/work/.keep'])
  expect(kept.get('accounts-v1')).toEqual({ codex: ['work'] })
  // Adding it again changes nothing.
  await addAccount($, 'codex', 'work')
  await addAccount($, 'codex', 'team')
  expect(await readAccountNames($)).toEqual({ codex: ['work', 'team'] })
  expect((await accountsOf($, 'codex')).map(account => account.name)).toEqual(['default', 'work', 'team'])
  expect(await accountsOf($, 'agy')).toEqual([{ engine: 'agy', name: 'default' }])

  expect(await addAccount($, 'commandcode', 'work')).toHaveProperty('error')
  expect(await addAccount($, 'codex', 'Bad Name')).toHaveProperty('error')
  expect(await addAccount($, 'codex', 'default')).toHaveProperty('error')
  expect(written).toHaveLength(2)
})

test('removing an account keeps its folder and forgets its cooldown', async () => {
  const { $, kept } = withHome({ 'accounts-v1': { codex: ['work', 'team'] }, 'cooldowns-v1': { 'codex/work': 9_999_999, 'codex/team': 9_999_999 } })
  expect(await removeAccount($, 'codex', 'work')).toEqual({ dir: '/home/me/.claude/hydra/accounts/codex/work' })
  expect(kept.get('accounts-v1')).toEqual({ codex: ['team'] })
  expect(kept.get('cooldowns-v1')).toEqual({ 'codex/team': 9_999_999 })
  expect(await removeAccount($, 'codex', 'work')).toHaveProperty('error')
})

test('keeps Antigravity limits per usage pool: one pool cooling leaves the others free', async () => {
  const AGY: Account[] = [{ engine: 'agy', name: 'default' }, { engine: 'agy', name: 'work', dir: '/w' }]
  const claudeOut = { 'agy/default#claude': NOW + 30 * MIN }
  expect(pickAccount('agy', AGY, claudeOut, NOW, 'fill', {}, [], 'claude')).toEqual({ account: AGY[1] })
  expect(pickAccount('agy', AGY, claudeOut, NOW, 'fill', {}, [], 'gemini')).toEqual({ account: AGY[0] })
  expect(pickAccount('agy', AGY, { 'agy/default': NOW + MIN }, NOW, 'fill', {}, [], 'argon')).toEqual({ account: AGY[1] })
  expect(pickAccount('agy', AGY, { ...claudeOut, 'agy/work#claude': NOW + 10 * MIN }, NOW, 'fill', {}, [], 'claude')).toEqual({ account: null, until: NOW + 10 * MIN })
  expect(allCoolingText('agy', null, 'claude')).toContain('Claude + GPT-OSS usage limit')
  expect(allCoolingText('agy', null, 'claude')).toContain('another model')

  const { $, kept } = withHome({ 'accounts-v1': { agy: ['work'] }, 'cooldowns-v1': { 'agy/work#argon': 1_000_000 + 30 * MIN, 'agy/default#claude': 1_000_000 + 20 * MIN } })
  const [agy] = await accountOverview($, ['agy'])
  expect(agy!.rows).toEqual([
    { name: 'default', signedIn: false, pools: [{ pool: 'claude', until: 1_000_000 + 20 * MIN }] },
    { name: 'work', signedIn: false, pools: [{ pool: 'argon', until: 1_000_000 + 30 * MIN }] },
  ])
  expect(rowText(agy!.rows[1]!)).toContain(`Gemini 4 Argon cooling until ${timeOf(1_000_000 + 30 * MIN)}`)
  await removeAccount($, 'agy', 'work')
  expect(kept.get('cooldowns-v1')).toEqual({ 'agy/default#claude': 1_000_000 + 20 * MIN })
})

test('ignores bad entries in the stored accounts', async () => {
  const { $ } = withHome({ 'accounts-v1': { codex: ['ok', 'Bad', 3, 'ok'], commandcode: ['x'], nope: ['y'], agy: 'z' }, 'cooldowns-v1': { 'codex/ok': 5, 'codex/x': 'soon' } })
  expect(await readAccountNames($)).toEqual({ codex: ['ok'] })
  expect(await readCooldowns($)).toEqual({ 'codex/ok': 5 })
})

test('records a cooldown and drops the ones that have lapsed', async () => {
  const { $, kept } = withHome({ 'cooldowns-v1': { 'codex/old': 10, 'codex/live': 5_000_000 } }, 1_000_000)
  await recordCooldown($, 'codex/work', 4_000_000)
  expect(kept.get('cooldowns-v1')).toEqual({ 'codex/live': 5_000_000, 'codex/work': 4_000_000 })
})

test('lists accounts with sign-in and cooling state, and says which engines keep one', async () => {
  const { $ } = withHome({ 'accounts-v1': { agy: ['work'] }, 'cooldowns-v1': { 'agy/default': 1_000_000 + 30 * MIN } })
  const overview = await accountOverview($, ['agy', 'commandcode'])
  expect(overview).toEqual([
    { engine: 'agy', isSupported: true, rows: [{ name: 'default', signedIn: false, until: 1_000_000 + 30 * MIN }, { name: 'work', signedIn: false }] },
    { engine: 'commandcode', isSupported: false, rows: [] },
  ])
  const text = accountsText(overview, 'fill')
  expect(text).toContain('strategy: fill')
  expect(text).toContain('commandcode (Command Code): one account (no switch supported)')
  expect(text).toContain(`✗ not signed in · cooling until ${timeOf(1_000_000 + 30 * MIN)}`)
  expect(rowText({ name: 'x', signedIn: true })).toBe('✓ signed in')
  expect(rowText({ name: 'x' })).toBe('· sign-in not checked')
})

// ---- rotation ----
type Fake = { text: string; isDone: boolean; failure?: string; files?: string[] }

/** `rotateAccounts` wired to in-memory steps: `outcomes` is what each run on an account returns, in order. */
const rotate = async (outcomes: Fake[], options: { cooling?: Record<string, number>; isAborted?: boolean; accounts?: Account[] } = {}) => {
  const accounts = options.accounts ?? ACCOUNTS
  const cooling = { ...options.cooling }
  const started: { name: string; note: string; minutes: number; isSwitch: boolean }[] = []
  const cooled: [string, number][] = []
  let clock = NOW
  let next = 0
  const result = await rotateAccounts<Fake>({
    count: accounts.length, minutes: 40, cwd: '/p', engine: 'codex',
    isAborted: () => options.isAborted === true,
    pick: async tried => pickAccount('codex', accounts, cooling, clock, 'fill', {}, tried),
    now: async () => clock,
    begin: async (name, isSwitch) => void started.push({ name, note: '', minutes: 0, isSwitch }),
    run: async (account, note, minutes) => {
      const last = started[started.length - 1]!
      expect(last.name).toBe(`codex/${account.name}`)
      last.note = note
      last.minutes = minutes
      clock += 5 * MIN
      return outcomes[next++]!
    },
    cooled: async (name, until) => {
      cooling[name] = until
      cooled.push([name, until])
    },
    refuse: async reason => ({ text: `not started: ${reason}`, isDone: false }),
  })
  return { result, started, cooled }
}

const LIMIT = 'You have hit your usage limit. Try again in 3 hours.'

test('runs a Head that finishes on the first account without a switch', async () => {
  const { result, started, cooled } = await rotate([{ text: 'report', isDone: true }])
  expect(result.text).toBe('accounts: codex/default\nreport')
  expect(started.map(step => step.name)).toEqual(['codex/default'])
  expect(started[0]!.isSwitch).toBe(false)
  expect(cooled).toEqual([])
})

test('switches to the next account on a usage limit, with a note naming the files already changed', async () => {
  const { result, started, cooled } = await rotate([
    { text: 'first', isDone: false, failure: LIMIT, files: ['/p/src/a.kt', '/p/b.kt'] },
    { text: 'second', isDone: true, files: ['/p/c.kt'] },
  ])
  expect(started.map(step => step.name)).toEqual(['codex/default', 'codex/work'])
  expect(started.map(step => step.isSwitch)).toEqual([false, true])
  expect(started[0]!.note).toBe('')
  expect(started[1]!.note).toContain('A previous attempt on another account stopped at a usage limit. Files it already changed: src/a.kt, b.kt.')
  expect(started[1]!.minutes).toBe(35) // the 5 minutes the first run took are not given again
  expect(cooled).toEqual([['codex/default', NOW + 5 * MIN + 180 * MIN]])
  expect(result.text).toBe(`accounts: codex/default (usage limit, cooling until ${timeOf(NOW + 185 * MIN)}) → codex/work\nsecond`)
})

test('skips an account that is already cooling and goes to the next', async () => {
  const { result, started } = await rotate([{ text: 'ok', isDone: true }], { cooling: { 'codex/default': NOW + 30 * MIN } })
  expect(started.map(step => step.name)).toEqual(['codex/work'])
  expect(result.text.split('\n')[0]).toBe('accounts: codex/work')
})

test('makes at most one run per account and ends with the last report when all hit their limit', async () => {
  const limit = { text: 'cut off', isDone: false, failure: 'Error: 429 Too Many Requests' }
  const { result, started, cooled } = await rotate([limit, limit, limit])
  expect(started.map(step => step.name)).toEqual(['codex/default', 'codex/work', 'codex/team'])
  expect(cooled).toHaveLength(3)
  expect(result.isDone).toBe(false)
  expect(result.text.split('\n')[0]).toMatch(/^accounts: codex\/default \(usage limit, cooling until \d\d:\d\d\) → codex\/work \(usage limit, cooling until \d\d:\d\d\) → codex\/team \(usage limit, cooling until \d\d:\d\d\) \(every account hit its limit\)$/)
})

test('says no other account is free when the rest are cooling', async () => {
  const { result, started } = await rotate([{ text: 'cut off', isDone: false, failure: LIMIT }], { cooling: { 'codex/work': NOW + 20 * MIN, 'codex/team': NOW + 90 * MIN } })
  expect(started.map(step => step.name)).toEqual(['codex/default'])
  expect(result.text.split('\n')[0]).toContain(`(no other account of codex is free; the earliest frees up at ${timeOf(NOW + 20 * MIN)})`)
})

test('does not start a Head when every account is cooling down', async () => {
  const { result, started } = await rotate([], { cooling: { 'codex/default': NOW + 50 * MIN, 'codex/work': NOW + 20 * MIN, 'codex/team': NOW + 90 * MIN } })
  expect(started).toEqual([])
  expect(result.isDone).toBe(false)
  expect(result.text.startsWith('not started: all accounts of codex are at their usage limit')).toBe(true)
  expect(result.text).toContain(timeOf(NOW + 20 * MIN))
})

test('a failure that is not a usage limit, a stop, or no failure text never switches', async () => {
  for (const outcome of [{ text: 'x', isDone: false, failure: 'Error: connect ECONNREFUSED' }, { text: 'x', isDone: false }]) {
    const { result, started } = await rotate([outcome])
    expect(started).toHaveLength(1)
    expect(result.text.split('\n')[0]).toBe('accounts: codex/default')
  }
  const stopped = await rotate([{ text: 'x', isDone: false, failure: LIMIT }], { isAborted: true })
  expect(stopped.started).toHaveLength(1)
  expect(stopped.cooled).toEqual([])
})

test('a model report that mentions rate limits does not switch accounts', async () => {
  // Only `failure` is tested: the engines fill it from the CLI's own error output, never from the model's report.
  const { started } = await rotate([{ text: 'Added rate limit handling and a quota check. HEAD DONE', isDone: false, failure: undefined }])
  expect(started).toHaveLength(1)
})
