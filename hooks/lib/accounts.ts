/**
 * @author Shakib
 * @since 15/10/26
 */
import type { EngineInterface } from 'claude-code'

import { AGY_TOKEN, ENGINES, ENGINE_LABEL, isEngine } from './engines'
import type { Engine } from './engines'
import { relativeTo } from './format'
import { commandOf, homeOf, platformOf } from './platform'
import type { Platform } from './platform'

/**
 * Several accounts per engine. An account is the CLI's own sign-in: `default` is its normal config (no override), and
 * every other account is a folder under `~/.claude/hydra/accounts/<engine>/<name>/` that the CLI is pointed at with an
 * environment variable (or, for Antigravity, the folder its token is copied from). Hydra never reads or writes a
 * credential: the person signs in with the CLI itself, and Hydra only checks that a sign-in exists.
 */
export type Account = { engine: Engine; name: string; dir?: string }

export const DEFAULT_ACCOUNT = 'default'
const ACCOUNTS_KEY = 'accounts-v1'
const COOLDOWNS_KEY = 'cooldowns-v1'
const LAST_USED_KEY = 'lastUsed-v1'
const ACCOUNTS_DIR = '.claude/hydra/accounts'

export const COOLDOWN_DEFAULT_MS = 60 * 60_000
export const COOLDOWN_MAX_MS = 7 * 86_400_000

export const STRATEGIES = ['fill', 'spread'] as const
export type Strategy = (typeof STRATEGIES)[number]
export const isStrategy = (value: unknown): value is Strategy => typeof value === 'string' && (STRATEGIES as readonly string[]).includes(value)

/** The `accountStrategy` option, for code outside `register` that picks accounts. */
let configuredStrategy: Strategy = 'fill'
export const setAccountStrategy = (strategy: Strategy) => {
  configuredStrategy = strategy
}
export const accountStrategy = () => configuredStrategy

export const accountId = (account: Pick<Account, 'engine' | 'name'>) => `${account.engine}/${account.name}`
export const accountDir = (home: string, engine: Engine, name: string) => `${home}/${ACCOUNTS_DIR}/${engine}/${name}`

/** Lowercase kebab, at most 20 characters; `default` is the implicit account and cannot be added. */
export const isAccountName = (name: string) => name.length <= 20 && name !== DEFAULT_ACCOUNT && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)

/** Where an extra account's Antigravity token lives (the source Hydra copies into a Head's own HOME). */
export const agyTokenOf = (dir: string) => `${dir}/${AGY_TOKEN}`

/** `VAR="value" command` on macOS and Linux, `$env:VAR="value"; command` in PowerShell. */
export const withEnv = (platform: Platform, vars: Record<string, string>, command: string) => {
  const entries = Object.entries(vars)
  return platform === 'windows'
    ? `${entries.map(([key, value]) => `$env:${key}="${value}"; `).join('')}${command}`
    : `${entries.map(([key, value]) => `${key}="${value}"`).join(' ')} ${command}`
}

export type AccountSupport = {
  /** The environment that points the CLI at an account folder. Absent when the engine is not driven by env (Antigravity). */
  env?: (dir: string) => Record<string, string>
  /** The command the person runs in a terminal to sign this account in. */
  login: (dir: string, platform: Platform) => string
  /** What to do inside that command, as one sentence. */
  hint: string
}

async function codexSignedIn($: EngineInterface, dir?: string): Promise<boolean> {
  const argv = [...(await commandOf($, 'codex')), 'login', 'status']
  return $.process.run(argv, { timeoutMs: 15_000, ...(dir ? { env: { CODEX_HOME: dir } } : {}) }).then(ran => ran.exitCode === 0, () => false)
}

/** CodeBuddy keeps its sign-in in its own config folder; Hydra can only see that the folder holds more than its `.keep`. The default account is not checked. */
async function buddySignedIn($: EngineInterface, dir?: string): Promise<boolean | undefined> {
  if (!dir) return undefined
  const entries = await $.fs.list(dir).catch(() => [])
  return entries.some(entry => entry.name !== '.keep')
}

async function agySignedIn($: EngineInterface, home: string, dir?: string): Promise<boolean> {
  const path = dir ? agyTokenOf(dir) : `${home}/${AGY_TOKEN}`
  return $.fs.exists(path).catch(() => false)
}

/** The engines that can hold more than one account. Command Code is left out: it has no per-run config location. */
export const ACCOUNT_SUPPORT: Partial<Record<Engine, AccountSupport>> = {
  codex: {
    env: dir => ({ CODEX_HOME: dir }),
    login: (dir, platform) => withEnv(platform, { CODEX_HOME: dir }, 'codex login'),
    hint: 'Add --device-auth to `codex login` on a remote machine.',
  },
  codebuddy: {
    env: dir => ({ CODEBUDDY_CONFIG_DIR: dir }),
    login: (dir, platform) => withEnv(platform, { CODEBUDDY_CONFIG_DIR: dir }, 'codebuddy'),
    hint: 'In CodeBuddy, type /login, finish signing in, then exit.',
  },
  agy: {
    login: (dir, platform) => withEnv(platform, { HOME: dir }, 'agy'),
    hint: 'In Antigravity, choose Google OAuth and finish signing in, then exit.',
  },
}

export const supportsAccounts = (engine: Engine) => ACCOUNT_SUPPORT[engine] !== undefined

/** The environment a Head on `account` runs with; `undefined` for the default account and for engines not driven by env. */
export const accountEnv = (account: Account | undefined) =>
  account?.dir ? ACCOUNT_SUPPORT[account.engine]?.env?.(account.dir) : undefined

/**
 * What the person is told after `/hydra accounts add`: the login command and what to do in it. It goes in a terminal of its
 * own: the sign-ins are interactive (a browser hand-off, Antigravity's full-screen UI), which the session's `!` shell cannot host.
 */
export const loginInstructions = (engine: Engine, name: string, dir: string, platform: Platform) => {
  const support = ACCOUNT_SUPPORT[engine]
  if (!support) return ''
  const command = support.login(dir, platform)
  return [
    `Added ${engine}/${name}. Sign it in yourself (Hydra never handles credentials) by running this in a separate ${platform === 'windows' ? 'PowerShell window' : 'terminal'}:`,
    `  ${command}`,
    support.hint,
    'Heads switch to it when the others hit a usage limit. /hydra accounts shows when it is signed in.',
  ].join('\n')
}

/** `HH:MM` in the local time zone. */
export const timeOf = (ms: number) => {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

// --- Quota failures ---------------------------------------------------------------------------------------------------

const QUOTA_WORDING = [
  /rate[\s_-]?limit/i, /usage[\s_-]?limit/i, /\bquota\b/i, /too many requests/i, /\b429\b/, /insufficient_quota/i,
  /exceeded your current/i, /limit reached/i, /out of credits/i, /credits? (?:are |is |have been )?exhausted/i, /try again in/i, /resource_exhausted/i,
]

/**
 * Whether a CLI's failure output is a usage or rate limit. Feed it only what the CLI itself reported as the reason it
 * stopped (its error stream and failure line), never the model's own report: code that mentions "rate limit handling" is not one.
 */
export const isQuotaFailure = (text: string | undefined) => !!text && QUOTA_WORDING.some(pattern => pattern.test(text))

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 }
const unitOf = (word: string) => (/^(ms|millis)/i.test(word) ? 1 : UNIT_MS[word.toLowerCase()[0] ?? 's'] ?? 1_000)
const DURATION = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|milliseconds?|ms|minutes?|mins?|m|seconds?|secs?|s)\b/gi

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * A wall-clock time a CLI names, in local time: "Oct 15 2026 3:05 PM", "October 15 3:05 PM" (this year), or "3:05 PM" /
 * "15:05" alone (today, else tomorrow). Parsed by hand: `Date.parse` reads these differently from one runtime to the next.
 */
const clockTimeOf = (text: string, now: number) => {
  const found = /^(?:([A-Za-z]{3})[a-z]*\.? (\d{1,2})(?: (\d{4}))? (?:at )?)?(\d{1,2}):(\d{2})(?::\d{2})? ?([AaPp][Mm])?(?: [A-Z]{2,5})?$/.exec(text.trim())
  if (!found) return undefined
  const [, monthName, dayText, yearText, hourText, minuteText, meridiem] = found
  let hours = Number(hourText)
  if (meridiem) hours = (hours % 12) + (/p/i.test(meridiem) ? 12 : 0)
  const at = new Date(now)
  if (monthName) {
    const month = MONTHS.indexOf(monthName.toLowerCase())
    if (month < 0) return undefined
    at.setFullYear(yearText ? Number(yearText) : at.getFullYear(), month, Number(dayText))
  }
  at.setHours(hours, Number(minuteText), 0, 0)
  return monthName || at.getTime() > now ? at.getTime() : at.getTime() + 86_400_000
}

/**
 * When the limit lifts, as a time in ms: the wait the CLI names ("try again in 2 hours 30 minutes", "retry-after: 90"), else a
 * reset time (an ISO date, or an epoch after "reset"), else an hour from `now`. Never more than 7 days away.
 */
export const cooldownFrom = (text: string, now: number) => {
  const clamp = (until: number) => Math.min(now + COOLDOWN_MAX_MS, Math.max(now + 1_000, until))
  const wait = /(?:try again in|retry(?:ing)? (?:again )?in|retry[\s_-]?after:?|resets? in)\s*((?:[^\n.;]|\.(?=\d))*)/i.exec(text)
  if (wait) {
    let total = 0
    for (const part of wait[1]!.matchAll(DURATION)) total += Number(part[1]) * unitOf(part[2]!)
    if (total === 0) {
      const bare = /^\s*(\d+)\s*$/.exec(wait[1]!)
      if (bare) total = Number(bare[1]) * 1_000
    }
    if (total > 0) return clamp(now + total)
  }
  const at = /try again at\s+([^\n;]+?)(?:\.\s|\.?$|\n)/im.exec(text)
  if (at) {
    const when = clockTimeOf(at[1]!.replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ').trim(), now)
    if (when !== undefined && when > now) return clamp(when)
  }
  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/.exec(text)
  if (iso) {
    const at = Date.parse(iso[1]!)
    if (Number.isFinite(at) && at > now) return clamp(at)
  }
  const epoch = /reset[\w\s]{0,12}?\D{0,6}(\d{10,13})\b/i.exec(text)
  if (epoch) {
    const raw = Number(epoch[1])
    const at = epoch[1]!.length >= 13 ? raw : raw * 1_000
    if (at > now) return clamp(at)
  }
  return clamp(now + COOLDOWN_DEFAULT_MS)
}

// --- Picking ---------------------------------------------------------------------------------------------------------

export type Cooldowns = Record<string, number>
export type LastUsed = Record<string, number>

/** The cooldowns that have not lapsed yet. */
export const activeCooldowns = (cooldowns: Cooldowns, now: number): Cooldowns =>
  Object.fromEntries(Object.entries(cooldowns).filter(([, until]) => until > now))

export type Picked = { account: Account } | { account: null; until: number | null }

/**
 * The account a Head runs on: skip the ones cooling down (and any id in `skip`: not signed in, already tried), then `fill` takes
 * the first left in order (the default account first) and `spread` the least recently used. With none left, `until` is when
 * the earliest cooling one frees up (null when nothing is cooling: every account was skipped for another reason).
 */
export const pickAccount = (
  engine: Engine,
  accounts: readonly Account[],
  cooldowns: Cooldowns,
  now: number,
  strategy: Strategy = 'fill',
  lastUsed: LastUsed = {},
  skip: readonly string[] = [],
): Picked => {
  const ofEngine = accounts.filter(account => account.engine === engine && !skip.includes(accountId(account)))
  const free = ofEngine.filter(account => (cooldowns[accountId(account)] ?? 0) <= now)
  if (free.length > 0) {
    if (strategy === 'fill') return { account: free[0]! }
    let best = free[0]!
    for (const account of free) if ((lastUsed[accountId(account)] ?? 0) < (lastUsed[accountId(best)] ?? 0)) best = account
    return { account: best }
  }
  const waits = ofEngine.map(account => cooldowns[accountId(account)] ?? 0).filter(until => until > now)
  return { account: null, until: waits.length > 0 ? Math.min(...waits) : null }
}

// --- The report line and messages ------------------------------------------------------------------------------------

export type Attempt = { id: string; until?: number }

/** `accounts: codex/default (usage limit, cooling until 14:05) → codex/work`; one account and no switch reads `accounts: codex/work`. */
export const accountsLine = (trail: readonly Attempt[]) =>
  `accounts: ${trail.map(step => (step.until !== undefined ? `${step.id} (usage limit, cooling until ${timeOf(step.until)})` : step.id)).join(' → ')}`

/** The not-started report's reason when every account of an engine is at its limit. */
export const allCoolingText = (engine: Engine, until: number | null) =>
  `all accounts of ${engine} are at their usage limit${until !== null ? `; the earliest frees up at ${timeOf(until)}` : ''}. Route this task to another engine, or run /hydra accounts reset if the limits have lifted.`

/** The note a Head gets when it continues another account's work. */
export const switchNote = (files: readonly string[]) =>
  `A previous attempt on another account stopped at a usage limit. Files it already changed: ${files.length > 0 ? files.join(', ') : 'none recorded'}. Check them and continue from the current state.`

// --- The store ------------------------------------------------------------------------------------------------------

/** The extra account names per engine; entries for unknown engines, engines without support and bad names are dropped. */
export async function readAccountNames($: EngineInterface): Promise<Partial<Record<Engine, string[]>>> {
  const stored = await $.store.get(ACCOUNTS_KEY).catch(() => undefined)
  const names: Partial<Record<Engine, string[]>> = {}
  if (!stored || typeof stored !== 'object') return names
  for (const [engine, list] of Object.entries(stored as Record<string, unknown>)) {
    if (!isEngine(engine) || !supportsAccounts(engine) || !Array.isArray(list)) continue
    const valid = [...new Set(list.filter((name): name is string => typeof name === 'string' && isAccountName(name)))]
    if (valid.length > 0) names[engine] = valid
  }
  return names
}

/** Every account of an engine, the default one first. */
export async function accountsOf($: EngineInterface, engine: Engine): Promise<Account[]> {
  const base: Account = { engine, name: DEFAULT_ACCOUNT }
  if (!supportsAccounts(engine)) return [base]
  const names = (await readAccountNames($))[engine] ?? []
  if (names.length === 0) return [base]
  const home = await homeOf($)
  return [base, ...names.map(name => ({ engine, name, dir: accountDir(home, engine, name) }))]
}

export async function addAccount($: EngineInterface, engine: Engine, name: string): Promise<{ account: Account } | { error: string }> {
  if (!supportsAccounts(engine)) return { error: `${ENGINE_LABEL[engine]} has no way to switch accounts, so it keeps one.` }
  if (!isAccountName(name)) return { error: `"${name}" is not a usable name: lowercase letters, digits and dashes, up to 20 characters, and not "${DEFAULT_ACCOUNT}".` }
  const names = await readAccountNames($)
  const home = await homeOf($)
  const dir = accountDir(home, engine, name)
  if ((names[engine] ?? []).includes(name)) return { account: { engine, name, dir } }
  await $.fs.write(`${dir}/.keep`, '')
  await $.store.set(ACCOUNTS_KEY, { ...names, [engine]: [...(names[engine] ?? []), name] })
  return { account: { engine, name, dir } }
}

export async function removeAccount($: EngineInterface, engine: Engine, name: string): Promise<{ dir: string } | { error: string }> {
  const names = await readAccountNames($)
  if (!(names[engine] ?? []).includes(name)) return { error: `There is no ${engine} account named "${name}". /hydra accounts lists them.` }
  const left = (names[engine] ?? []).filter(item => item !== name)
  await $.store.set(ACCOUNTS_KEY, { ...names, [engine]: left })
  const cooldowns = await readCooldowns($)
  delete cooldowns[`${engine}/${name}`]
  await $.store.set(COOLDOWNS_KEY, cooldowns)
  return { dir: accountDir(await homeOf($), engine, name) }
}

export async function readCooldowns($: EngineInterface): Promise<Cooldowns> {
  const stored = await $.store.get(COOLDOWNS_KEY).catch(() => undefined)
  if (!stored || typeof stored !== 'object') return {}
  return Object.fromEntries(Object.entries(stored as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
}

export async function recordCooldown($: EngineInterface, id: string, until: number) {
  await $.store.set(COOLDOWNS_KEY, { ...activeCooldowns(await readCooldowns($), await $.clock.now()), [id]: until })
}

export async function resetCooldowns($: EngineInterface) {
  await $.store.set(COOLDOWNS_KEY, {})
}

export async function readLastUsed($: EngineInterface): Promise<LastUsed> {
  const stored = await $.store.get(LAST_USED_KEY).catch(() => undefined)
  if (!stored || typeof stored !== 'object') return {}
  return Object.fromEntries(Object.entries(stored as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
}

export async function markUsed($: EngineInterface, id: string, now: number) {
  await $.store.set(LAST_USED_KEY, { ...(await readLastUsed($)), [id]: now })
}

// --- Sign-in checks ---------------------------------------------------------------------------------------------------

/** Whether the account has a sign-in (never reads it): `undefined` when Hydra cannot tell. Spelled out per engine because `$` is followed only into function declarations. */
async function checkSignIn($: EngineInterface, account: Account): Promise<boolean | undefined> {
  if (account.engine === 'codex') return codexSignedIn($, account.dir)
  if (account.engine === 'codebuddy') return buddySignedIn($, account.dir)
  if (account.engine === 'agy') return agySignedIn($, await homeOf($), account.dir)
  return undefined
}

const SIGNED_OUT_RETRY_MS = 60_000
const signIns = new Map<string, { ok: boolean | undefined; at: number }>()

/**
 * Whether an account has a sign-in, checked lazily and kept for the session: a yes stays, a no is asked again after a
 * minute (the person may have just signed in). `undefined` when Hydra cannot tell. `fresh` ignores the cache.
 */
export async function signedInOf($: EngineInterface, account: Account, fresh = false): Promise<boolean | undefined> {
  if (!supportsAccounts(account.engine)) return undefined
  const id = accountId(account)
  const now = await $.clock.now()
  const cached = signIns.get(id)
  if (!fresh && cached && (cached.ok !== false || now - cached.at < SIGNED_OUT_RETRY_MS)) return cached.ok
  const ok = await checkSignIn($, account).catch(() => false)
  signIns.set(id, { ok, at: now })
  return ok
}

/** Picks the account a Head starts on: the strategy's choice among accounts that are free and signed in. */
/**
 * Picks this session made that the store may not hold yet. Heads fanned out together all read the store before any of them
 * marks its account, so `spread` would send every one to the same least-used account; a claim is taken in the same step as
 * the pick, which no other pick can interleave with.
 */
const claims: LastUsed = {}

export async function pickUsable($: EngineInterface, engine: Engine, accounts: readonly Account[], skip: readonly string[] = []): Promise<Picked> {
  const now = await $.clock.now()
  const cooldowns = await readCooldowns($)
  const lastUsed = await readLastUsed($)
  const passed = [...skip]
  for (;;) {
    const picked = pickAccount(engine, accounts, cooldowns, now, configuredStrategy, { ...lastUsed, ...claims }, passed)
    if (!picked.account) return picked
    const id = accountId(picked.account)
    const held = claims[id]
    claims[id] = Math.max(now, (held ?? 0) + 1)
    // The default account is Hydra's own preflight's business; an extra one that is signed out is passed over.
    if (!picked.account.dir || (await signedInOf($, picked.account)) !== false) return picked
    if (held === undefined) delete claims[id]
    else claims[id] = held
    passed.push(id)
  }
}

// --- Rotation --------------------------------------------------------------------------------------------------------

/** The steps `rotateAccounts` takes, wired by the caller to the store, the run record and the engine. */
export type Rotation<R extends { text: string; isDone: boolean; failure?: string; files?: string[] }> = {
  /** How many accounts the engine has: one run per account at most. */
  count: number
  /** The Head's time limit; each run after a switch gets what is left. */
  minutes: number
  cwd: string
  engine: Engine
  isAborted: () => boolean
  pick: (tried: readonly string[]) => Promise<Picked>
  now: () => Promise<number>
  /** A run is about to start on `name` (the first, or a switch). */
  begin: (name: string, isSwitch: boolean) => Promise<void>
  /** Runs the Head on `account`; `note` is appended to its task after a switch. */
  run: (account: Account, note: string, minutes: number) => Promise<R>
  /** `name` stopped at a usage limit until `until`. */
  cooled: (name: string, until: number) => Promise<void>
  /** The Head cannot start: every account is cooling down. */
  refuse: (reason: string) => Promise<R>
}

/**
 * Runs a Head on the strategy's account. When it stops at a usage limit (the engine's `failure`, never the model's report) the
 * account's cooldown is recorded and the Head runs again on the next free one, with the original task plus a note naming the files
 * already changed: one switch per other account at most. A Head that is done, stopped on purpose or failed for another reason ends there.
 * The report starts with the accounts used. With every account cooling down the Head does not start.
 */
export async function rotateAccounts<R extends { text: string; isDone: boolean; failure?: string; files?: string[] }>(steps: Rotation<R>): Promise<R> {
  const trail: Attempt[] = []
  const tried: string[] = []
  const edited: string[] = []
  const startedAt = await steps.now()
  const withTrail = (result: R, stopped?: string): R => ({ ...result, text: `${accountsLine(trail)}${stopped ? ` (${stopped})` : ''}\n${result.text}` })
  let last: R | undefined
  for (let attempt = 0; attempt < steps.count; attempt++) {
    const picked = await steps.pick(tried)
    if (!picked.account) {
      const earliest = picked.until !== null ? `; the earliest frees up at ${timeOf(picked.until)}` : ''
      return last ? withTrail(last, `no other account of ${steps.engine} is free${earliest}`) : steps.refuse(allCoolingText(steps.engine, picked.until))
    }
    const name = accountId(picked.account)
    tried.push(name)
    await steps.begin(name, attempt > 0)
    const now = await steps.now()
    const note = attempt > 0 ? `\n\n${switchNote(edited.map(file => relativeTo(steps.cwd, file)))}` : ''
    last = await steps.run(picked.account, note, Math.max(1, steps.minutes - Math.floor((now - startedAt) / 60_000)))
    for (const file of last.files ?? []) if (!edited.includes(file)) edited.push(file)
    if (last.isDone || steps.isAborted() || !isQuotaFailure(last.failure)) {
      trail.push({ id: name })
      return withTrail(last)
    }
    const until = cooldownFrom(last.failure ?? '', await steps.now())
    await steps.cooled(name, until)
    trail.push({ id: name, until })
  }
  return withTrail(last!, 'every account hit its limit')
}

// --- The overview (/hydra accounts, /hydra-usage) ---------------------------------------------------------------------

export type AccountRow = { name: string; signedIn?: boolean; until?: number }
export type EngineAccounts = { engine: Engine; isSupported: boolean; rows: AccountRow[] }

/** Every engine's accounts with their sign-in and cooldown state. Sign-ins are checked afresh unless `fresh` is false (a pane that redraws often reads the session's cache). */
export async function accountOverview($: EngineInterface, engines: readonly Engine[] = ENGINES, fresh = true): Promise<EngineAccounts[]> {
  const now = await $.clock.now()
  const cooldowns = activeCooldowns(await readCooldowns($), now)
  const overview: EngineAccounts[] = []
  for (const engine of engines) {
    if (!supportsAccounts(engine)) {
      overview.push({ engine, isSupported: false, rows: [] })
      continue
    }
    const rows: AccountRow[] = []
    for (const account of await accountsOf($, engine)) {
      const until = cooldowns[accountId(account)]
      rows.push({ name: account.name, signedIn: await signedInOf($, account, fresh), ...(until !== undefined ? { until } : {}) })
    }
    overview.push({ engine, isSupported: true, rows })
  }
  return overview
}

export const hasExtraAccounts = (overview: readonly EngineAccounts[]) => overview.some(item => item.rows.length > 1)

export const rowText = (row: AccountRow) =>
  `${row.signedIn === true ? '✓ signed in' : row.signedIn === false ? '✗ not signed in' : '· sign-in not checked'}${row.until !== undefined ? ` · cooling until ${timeOf(row.until)}` : ''}`

export const accountsText = (overview: readonly EngineAccounts[], strategy: Strategy) => {
  const lines = [`🐉 Accounts (strategy: ${strategy}${strategy === 'fill' ? ', default first, the next when one is at its limit' : ', the least recently used first'})`]
  for (const item of overview) {
    if (!item.isSupported) {
      lines.push(`  ${item.engine} (${ENGINE_LABEL[item.engine]}): one account (no switch supported)`)
      continue
    }
    lines.push(`  ${item.engine} (${ENGINE_LABEL[item.engine]}):`, ...item.rows.map(row => `    ${row.name.padEnd(DEFAULT_ACCOUNT.length + 4)} ${rowText(row)}`))
  }
  lines.push('Add one: /hydra accounts add <engine> [name] · remove: /hydra accounts remove <engine> <name> · clear limits: /hydra accounts reset')
  return lines.join('\n')
}

// --- /hydra accounts … ------------------------------------------------------------------------------------------------

export type AccountsCommand =
  | { kind: 'list' }
  | { kind: 'reset' }
  | { kind: 'add'; engine: Engine; name: string }
  | { kind: 'remove'; engine: Engine; name: string }
  | { kind: 'error'; message: string }

const ACCOUNTS_USAGE = 'Usage: /hydra accounts · /hydra accounts add <engine> [name] · /hydra accounts remove <engine> <name> · /hydra accounts reset'

/** The words after `/hydra accounts`. An add with no name takes `work`. */
export const parseAccountsArgs = (text: string): AccountsCommand => {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const verb = (words[0] ?? 'list').toLowerCase()
  if (verb === 'list' && words.length <= 1) return { kind: 'list' }
  if (verb === 'reset' && words.length === 1) return { kind: 'reset' }
  if (verb !== 'add' && verb !== 'remove') return { kind: 'error', message: `Unknown accounts option "${words[0]}". ${ACCOUNTS_USAGE}` }
  const engine = (words[1] ?? '').toLowerCase()
  if (!isEngine(engine)) return { kind: 'error', message: `${words[1] ? `Unknown engine "${words[1]}"` : 'Name an engine'}. Use ${ENGINES.join(', ')}. ${ACCOUNTS_USAGE}` }
  if (verb === 'remove') {
    return words.length === 3 ? { kind: 'remove', engine, name: words[2]! } : { kind: 'error', message: `remove needs an engine and an account name. ${ACCOUNTS_USAGE}` }
  }
  if (words.length > 3) return { kind: 'error', message: `add takes an engine and one name. ${ACCOUNTS_USAGE}` }
  return { kind: 'add', engine, name: words[2] ?? 'work' }
}

/** Runs a parsed `/hydra accounts` command and returns the reply text. */
export async function runAccountsCommand($: EngineInterface, command: AccountsCommand): Promise<string> {
  if (command.kind === 'error') return command.message
  if (command.kind === 'list') return accountsText(await accountOverview($), configuredStrategy)
  if (command.kind === 'reset') {
    await resetCooldowns($)
    return 'Cleared every account cooldown.'
  }
  if (command.kind === 'remove') {
    const removed = await removeAccount($, command.engine, command.name)
    if ('error' in removed) return removed.error
    return `Removed ${command.engine}/${command.name} from Hydra. Its folder and sign-in are untouched; delete ${removed.dir} if you want them gone.`
  }
  const added = await addAccount($, command.engine, command.name)
  if ('error' in added) return added.error
  return loginInstructions(command.engine, command.name, added.account.dir!, await platformOf($))
}
