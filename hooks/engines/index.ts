/**
 * @author Shakib
 * @since 15/10/26
 */
import type { EngineInterface } from 'claude-code'

import type { HeadRun } from '../../types'
import { accountEnv, accountId, accountsOf, cooldownKey, markUsed, pickAccount, pickUsable, readCooldowns, recordCooldown, recordSignedOut, rotateAccounts, switchNote } from '../lib/accounts'
import type { Account, EngineBound, Picked } from '../lib/accounts'
import { isHeadEffort } from '../lib/effort'
import { AGY_MODEL, DEFAULT_ENGINE, ENGINE_LABEL, FALLBACK_ORDER, agyBaseOf, modelAlternates, modelFor, modelOn, usagePoolOf, workbuddyEnv } from '../lib/engines'
import type { Engine, Routing } from '../lib/engines'
import { checkHead, checkMinutesOf, runCheck, withSummary } from '../lib/check'
import { addTokens, formatReport, relativeTo, strings } from '../lib/format'
import type { HeadLimits } from '../lib/format'
import { DEFAULT_MINUTES, gate, hasConsent, notStarted, preflight, realPaths, refreshStatus, setRun, stopReason } from '../lib/runtime'
import type { HeadResult } from '../lib/runtime'
import { homeOf } from '../lib/platform'
import { guardedPaths, ignoreChangedLine, ignoreChanges, snapshotIgnoreFiles } from '../lib/protect'
import type { Guarded } from '../lib/protect'
import { homeHeadRefusal, secretDirRefusal, union } from '../lib/safety'
import { readRuns, updateRuns, updateTick } from '../lib/state'
import { agyBlockedUntil, readAgyUsage, runAgyHead } from './agy'
import { runBuddyHead } from './codebuddy'
import { runCodexHead } from './codex'
import { runCommandCodeHead } from './commandcode'
import { runOpenCodeHead } from './opencode'

const RUN_HISTORY = 20

// Codex and Antigravity number no model messages, so their turns are tool calls: a Head needs more of them for the same work.
const turnsOn = (engine: Engine, given: unknown) => Number(given ?? (engine === 'codex' || engine === 'agy' ? 150 : 60))

export async function runHead($: EngineInterface, input: Record<string, unknown>, headModel: string, signal: AbortSignal, limits: HeadLimits, id: string, engine: Engine = DEFAULT_ENGINE, routing?: Routing) {
  const task = String(input.task ?? '').trim()
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : await $.session.root()
  const requested = typeof input.model === 'string' && input.model ? input.model : headModel
  const model = engine === 'agy' ? (agyBaseOf(requested) ?? agyBaseOf(headModel) ?? AGY_MODEL) : modelFor(engine, requested)
  const maxTurns = turnsOn(engine, input.maxTurns)
  const addDirs = strings(input.addDirs)
  const writeDirs = strings(input.writeDirs)
  const shell = input.shell === true || strings(input.allowShell).length > 0
  const minutes = Number(input.maxMinutes ?? DEFAULT_MINUTES)
  const effort = isHeadEffort(input.effort) ? input.effort : undefined
  const check = typeof input.check === 'string' ? input.check.trim() : ''
  const checkMinutes = checkMinutesOf(input.checkMinutes)

  const queued: HeadRun = { id, task: task.slice(0, 200), model, state: 'queued', turns: 0, maxTurns, activity: 'waiting for a slot', cwd, engine }
  await updateRuns($, list => [...list, queued].slice(-RUN_HISTORY))
  await refreshStatus($, limits)
  await gate.enter()
  if (signal.aborted) {
    gate.leave()
    await setRun($, id, { state: 'failed', endedAt: await $.clock.now(), activity: stopReason(signal) })
    await refreshStatus($, limits)
    return {
      text: formatReport({ id, model, cwd, finished: false, rounds: 0, turns: 0, usd: 0, files: [], denied: [], finalText: '', exit: stopReason(signal), engine }),
      isDone: false,
    }
  }
  const startedAt = await $.clock.now()
  await setRun($, id, { state: 'running', startedAt, activity: 'starting' })
  await updateTick($, () => startedAt)
  try {
    return await runHeadInside($, { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort, engine, check, checkMinutes, turnsGiven: input.maxTurns }, signal, limits, id, routing)
  } finally {
    gate.leave()
  }
}

/**
 * Where a Head is started on an engine's account (see `startHead` and `runOnAccounts`). To add an engine: write `engines/<name>.ts` (its stream fold,
 * command line, lockdown settings and a `run<Name>Head` function, as `codex.ts` does), name it in `lib/engines.ts`, and add one line to `startHead`.
 * An engine that can hold several accounts also gets an entry in `ACCOUNT_SUPPORT` (lib/accounts.ts).
 */
async function runHeadInside(
  $: EngineInterface,
  head: { task: string; cwd: string; model: string; maxTurns: number; addDirs: string[]; writeDirs: string[]; shell: boolean; minutes: number; effort?: string; engine: Engine; check: string; checkMinutes: number; turnsGiven?: unknown },
  outer: AbortSignal,
  limits: HeadLimits,
  id: string,
  routing?: Routing,
) {
  const { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort, engine, check, checkMinutes, turnsGiven } = head
  const home = await homeOf($)
  const [realCwd, realHome] = await realPaths($, home ? [cwd, home] : [cwd])
  const granted = await realPaths($, union(addDirs, writeDirs))
  const refusal = homeHeadRefusal(realCwd ?? cwd, realHome ?? '') ?? secretDirRefusal(granted, realHome ?? '', 'addDirs/writeDirs')
  if (refusal) {
    await setRun($, id, { state: 'failed', endedAt: await $.clock.now(), activity: refusal })
    await refreshStatus($, limits)
    return notStarted(id, model, cwd, `${refusal} A Head never runs where Hydra's rules cannot keep it inside a project.`, engine)
  }
  const given = union([cwd, ...writeDirs], addDirs)
  const reals = await realPaths($, given)
  const guarded = await guardedPaths($, given.map((path, index) => ({ path, real: reals[index] })))
  if ('refusal' in guarded) {
    await setRun($, id, { state: 'failed', endedAt: await $.clock.now(), activity: guarded.refusal })
    await refreshStatus($, limits)
    return notStarted(id, model, cwd, guarded.refusal, engine)
  }
  const spec = { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort, engine, guarded }
  const run = (head: HeadSpec) => runRoutes($, head, turnsGiven, routing, outer, limits, id)
  // Not every engine can stop a delete or a new spelling, so every run ends by comparing each `.hydraignore` with how it started.
  const before = await snapshotIgnoreFiles($, guarded.ignoreFiles)
  const result = check ? await runChecked($, spec, check, checkMinutes, run, outer, limits, id) : await run(spec)
  const changed = ignoreChanges(before, await snapshotIgnoreFiles($, guarded.ignoreFiles))
  return changed.length > 0 ? { ...result, text: withSummary(result.text, [ignoreChangedLine(changed)]) } : result
}

/** A Head with an acceptance check (`checkHead` in lib/check.ts), wired to the engine, the run record and the views. */
async function runChecked(
  $: EngineInterface,
  spec: HeadSpec,
  check: string,
  checkMinutes: number,
  run: (head: HeadSpec) => Promise<HeadResult>,
  outer: AbortSignal,
  limits: HeadLimits,
  id: string,
): Promise<HeadResult> {
  // Each fix round reports its own tokens; the Head used all of them.
  let spent: string | undefined
  const tokensNow = async () => (await readRuns($)).find(entry => entry.id === id)?.tokens
  const { result, outcome } = await checkHead<HeadResult>({
    check,
    cwd: spec.cwd,
    minutes: spec.minutes,
    effort: spec.effort,
    run: async change => {
      if (!change) return run(spec)
      spent = addTokens(spent, await tokensNow())
      const ran = await run({ ...spec, task: spec.task + change.note, effort: change.effort, minutes: change.minutes })
      await setRun($, id, { tokens: addTokens(spent, await tokensNow()) })
      return ran
    },
    runCheck: () => runCheck($, check, spec.cwd, checkMinutes),
    now: () => $.clock.now(),
    isAborted: () => outer.aborted,
    onStep: async activity => {
      await setRun($, id, { state: 'running', endedAt: undefined, activity: activity.slice(0, 80) })
      await refreshStatus($, limits)
    },
  })
  if (outcome) {
    await setRun($, id, { state: outcome.kind === 'failed' ? 'failed' : 'done', endedAt: await $.clock.now(), activity: outcome.kind === 'passed' ? 'check passed' : outcome.kind === 'failed' ? `check failed (exit ${outcome.exitCode})` : 'check could not run' })
    await refreshStatus($, limits)
  }
  return result
}

type HeadSpec = { task: string; cwd: string; model: string; maxTurns: number; addDirs: string[]; writeDirs: string[]; shell: boolean; minutes: number; effort?: string; engine: Engine; guarded: Guarded }

/** Starts one Head run on `account` (undefined: the CLI's own config): its engine's run function, with the account's env or token folder. */
async function startHead($: EngineInterface, head: HeadSpec, account: Account | undefined, outer: AbortSignal, limits: HeadLimits, id: string): Promise<HeadResult> {
  const { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort, engine, guarded } = head
  const env = accountEnv(account)
  if (engine === 'agy') return runAgyHead($, { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort, tokenDir: account?.dir, guarded }, outer, limits, id)
  if (engine === 'codex') return runCodexHead($, { task, cwd, model, maxTurns, addDirs: union(addDirs, writeDirs), writeDirs, minutes, effort, env, guarded }, outer, limits, id)
  if (engine === 'codebuddy') return runBuddyHead($, { task, cwd, model, maxTurns, addDirs: union(addDirs, writeDirs), writeDirs, shell, minutes, effort, env, guarded }, outer, limits, id)
  if (engine === 'workbuddy') {
    const buddyEnv = { ...workbuddyEnv(await homeOf($)), ...(env ?? {}) }
    return runBuddyHead($, { task, cwd, model, maxTurns, addDirs: union(addDirs, writeDirs), writeDirs, shell, minutes, effort, env: buddyEnv, engine: 'workbuddy', guarded }, outer, limits, id)
  }
  // OpenCode never gets a shell (it does not check a command's paths) and takes no effort level.
  if (engine === 'opencode') return runOpenCodeHead($, { task, cwd, model, maxTurns, addDirs, writeDirs, minutes, env, guarded }, outer, limits, id)
  return runCommandCodeHead($, { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort, guarded }, outer, limits, id)
}

/** Why a route stopped, as the report's fallback line says it. */
const BOUND_TEXT: Record<EngineBound, string> = { quota: 'usage limit', 'signed out': 'not signed in', unavailable: 'could not start here' }
const BOUND_WHY: Record<EngineBound, string> = { quota: 'at a usage limit', 'signed out': 'because its sign-in failed', unavailable: 'because it could not start there' }

export type Route = { engine: Engine; model: string }
const routeKey = (route: Route) => `${route.engine}:${route.model}`
const routeText = (route: Route) => `${route.engine} ${route.model}`
const MAX_ROUTES = 4

/**
 * Runs a Head on its engine and model and, when the engine stops it (`engineBound`: every account at its limit, signed out, a
 * setup this engine cannot run), on the next route that is free: another model of the same engine first (its own usage pool),
 * then the other engines in `FALLBACK_ORDER`, as far as `routing` allows. Each move carries a note naming the files already
 * changed, and the report starts with the routes taken. At most `MAX_ROUTES` runs.
 */
async function runRoutes($: EngineInterface, head: HeadSpec, turnsGiven: unknown, routing: Routing | undefined, outer: AbortSignal, limits: HeadLimits, id: string): Promise<HeadResult> {
  const startedAt = await $.clock.now()
  const tried = new Set([routeKey(head)])
  const trail: string[] = []
  const edited: string[] = []
  let spent: string | undefined
  const tokensNow = async () => (await readRuns($)).find(run => run.id === id)?.tokens
  let current: HeadSpec = head
  let result = await runOnAccounts($, current, outer, limits, id)
  let ending = ''
  while (!result.isDone && !outer.aborted && result.engineBound && routing?.fallback) {
    for (const file of result.files ?? []) if (!edited.includes(file)) edited.push(file)
    trail.push(`${routeText(current)} (${BOUND_TEXT[result.engineBound]})`)
    const next = tried.size < MAX_ROUTES ? await nextRoute($, head, current, result.engineBound, routing, tried) : undefined
    if (!next) {
      ending = tried.size < MAX_ROUTES ? 'no other engine or model is free' : `stopped after ${MAX_ROUTES} routes`
      break
    }
    tried.add(routeKey(next))
    spent = addTokens(spent, await tokensNow())
    const where = next.engine === current.engine ? `${current.model} on ${ENGINE_LABEL[current.engine]}` : ENGINE_LABEL[current.engine]
    const note = `\n\n${switchNote(edited.map(file => relativeTo(head.cwd, file)), where, BOUND_WHY[result.engineBound])}`
    const minutes = Math.max(1, head.minutes - Math.floor(((await $.clock.now()) - startedAt) / 60_000))
    await setRun($, id, { engine: next.engine, model: next.model, account: undefined, state: 'running', endedAt: undefined, activity: `moved to ${routeText(next)}` })
    current = { ...head, ...next, maxTurns: turnsOn(next.engine, turnsGiven), task: head.task + note, minutes }
    result = await runOnAccounts($, current, outer, limits, id)
  }
  if (spent) await setRun($, id, { tokens: addTokens(spent, await tokensNow()) })
  if (trail.length === 0) return result
  const line = `fallback: ${trail.join(' → ')}${ending ? ` (${ending})` : ` → ${routeText(current)}`}`
  return { ...result, text: `${line}\n${result.text}` }
}

/** Where a Head may go next, nearest first, before any check: `current`'s models in other pools (not for a lost sign-in), then the engines in `first`'s fallback order. */
export const fallbackRoutes = (first: Engine, current: Route, bound: EngineBound, routing: Routing): Route[] => {
  const routes: Route[] = []
  if (bound !== 'signed out') for (const model of modelAlternates(current.engine, current.model)) routes.push({ engine: current.engine, model: modelOn(current.engine, model, routing.headModel, routing.configured) })
  for (const engine of FALLBACK_ORDER[first]) {
    if (engine === current.engine || (routing.pool && !routing.pool.includes(engine))) continue
    routes.push({ engine, model: modelOn(engine, routing.model, routing.headModel, routing.configured) })
  }
  return routes
}

/**
 * The next route for a Head the engine stopped: on a usage limit or a model this engine cannot start, the same engine's models in
 * other pools first; then each engine in the first engine's fallback order that the auto pool allows, passes its checks, has the
 * person's saved consent and has an account free for that model.
 */
async function nextRoute($: EngineInterface, head: HeadSpec, current: HeadSpec, bound: EngineBound, routing: Routing, tried: ReadonlySet<string>): Promise<Route | undefined> {
  const candidates = fallbackRoutes(head.engine, current, bound, routing)
  const now = await $.clock.now()
  const cooldowns = await readCooldowns($)
  for (const route of candidates) {
    if (tried.has(routeKey(route))) continue
    if (route.engine !== current.engine && ((await preflight($, route.engine)).problems.length > 0 || !(await hasConsent($, route.model, false, route.engine)))) continue
    const picked = pickAccount(route.engine, await accountsOf($, route.engine), cooldowns, now, 'fill', {}, [], usagePoolOf(route.engine, route.model))
    if (picked.account) return route
  }
  return undefined
}

/**
 * A Head on its engine's accounts: `rotateAccounts` (lib/accounts.ts) runs it on the strategy's pick and, when it stops at a usage
 * limit or its sign-in fails, on the next free account. With one account it still records the limit, so the next Head goes
 * elsewhere at once. Antigravity accounts are checked against `agy /usage` before a Head starts on one. Here the steps are wired
 * to the store, the run record and the engine.
 */
async function runOnAccounts($: EngineInterface, head: HeadSpec, outer: AbortSignal, limits: HeadLimits, id: string): Promise<HeadResult> {
  const { engine, cwd, model } = head
  const accounts = await accountsOf($, engine)
  const pool = usagePoolOf(engine, model)
  const named = (name: string) => accounts.find(account => accountId(account) === name)
  // Each account's run reports its own tokens; a Head that switched used every one of them.
  let spent: string | undefined
  const tokensNow = async () => (await readRuns($)).find(run => run.id === id)?.tokens
  const result = await rotateAccounts<HeadResult>({
    count: accounts.length,
    minutes: head.minutes,
    cwd,
    engine,
    pool,
    isAborted: () => outer.aborted,
    pick: tried => pickWithQuota($, engine, model, accounts, tried, pool),
    now: () => $.clock.now(),
    begin: async (name, isSwitch) => {
      if (isSwitch) spent = addTokens(spent, await tokensNow())
      await markUsed($, name, await $.clock.now())
      if (accounts.length > 1) await setRun($, id, { account: name, ...(isSwitch ? { state: 'running' as const, endedAt: undefined, activity: `switched to ${name}` } : {}) })
    },
    run: (account, note, minutes) => startHead($, { ...head, task: head.task + note, minutes }, account.dir ? account : undefined, outer, limits, id),
    cooled: async (key, until) => {
      // Antigravity says exactly when each bucket refills; its error text may not.
      const account = engine === 'agy' ? named(key.split('#')[0]!) : undefined
      const exact = account ? agyBlockedUntil(await readAgyUsage($, account.dir, true), model) : undefined
      await recordCooldown($, key, exact ?? until)
    },
    signedOut: name => recordSignedOut($, name),
    refuse: async reason => {
      await setRun($, id, { state: 'failed', endedAt: await $.clock.now(), activity: reason })
      await refreshStatus($, limits)
      return notStarted(id, model, cwd, reason, engine)
    },
  })
  if (spent) await setRun($, id, { tokens: addTokens(spent, await tokensNow()) })
  return result
}

/** `pickUsable`, and for Antigravity a look at the account's quota first: a spent bucket is recorded as a cooldown and the next account picked. */
async function pickWithQuota($: EngineInterface, engine: Engine, model: string, accounts: readonly Account[], tried: readonly string[], pool?: string): Promise<Picked> {
  for (let left = accounts.length; ; left--) {
    const picked = await pickUsable($, engine, accounts, tried, pool)
    if (engine !== 'agy' || !picked.account || left <= 0) return picked
    const until = agyBlockedUntil(await readAgyUsage($, picked.account.dir), model)
    if (until === undefined || until <= (await $.clock.now())) return picked
    await recordCooldown($, cooldownKey(accountId(picked.account), pool), until)
  }
}
