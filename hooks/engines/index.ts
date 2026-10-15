/**
 * @author Shakib
 * @since 15/10/26
 */
import type { EngineInterface } from 'claude-code'

import type { HeadRun } from '../../types'
import { accountEnv, accountsOf, markUsed, pickUsable, recordCooldown, rotateAccounts } from '../lib/accounts'
import type { Account } from '../lib/accounts'
import { isHeadEffort } from '../lib/effort'
import { AGY_MODEL, DEFAULT_ENGINE, modelFor, workbuddyEnv } from '../lib/engines'
import type { Engine } from '../lib/engines'
import { addTokens, formatReport, strings } from '../lib/format'
import type { HeadLimits } from '../lib/format'
import { DEFAULT_MINUTES, gate, notStarted, realPaths, refreshStatus, setRun, stopReason } from '../lib/runtime'
import type { HeadResult } from '../lib/runtime'
import { homeOf } from '../lib/platform'
import { homeHeadRefusal, secretDirRefusal, union } from '../lib/safety'
import { readRuns, updateRuns, updateTick } from '../lib/state'
import { runAgyHead } from './agy'
import { runBuddyHead } from './codebuddy'
import { runCodexHead } from './codex'
import { runCommandCodeHead } from './commandcode'
import { runOpenCodeHead } from './opencode'

const RUN_HISTORY = 20

export async function runHead($: EngineInterface, input: Record<string, unknown>, headModel: string, signal: AbortSignal, limits: HeadLimits, id: string, engine: Engine = DEFAULT_ENGINE) {
  const task = String(input.task ?? '').trim()
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : await $.session.root()
  const model = engine === 'agy' ? AGY_MODEL : modelFor(engine, typeof input.model === 'string' && input.model ? input.model : headModel)
  // Codex and Antigravity number no model messages, so their turns are tool calls: a Head needs more of them for the same work.
  const maxTurns = Number(input.maxTurns ?? (engine === 'codex' || engine === 'agy' ? 150 : 60))
  const addDirs = strings(input.addDirs)
  const writeDirs = strings(input.writeDirs)
  const shell = input.shell === true || strings(input.allowShell).length > 0
  const minutes = Number(input.maxMinutes ?? DEFAULT_MINUTES)
  const effort = isHeadEffort(input.effort) ? input.effort : undefined

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
    return await runHeadInside($, { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort, engine }, signal, limits, id)
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
  head: { task: string; cwd: string; model: string; maxTurns: number; addDirs: string[]; writeDirs: string[]; shell: boolean; minutes: number; effort?: string; engine: Engine },
  outer: AbortSignal,
  limits: HeadLimits,
  id: string,
) {
  const { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort, engine } = head
  const home = await homeOf($)
  const [realCwd, realHome] = await realPaths($, home ? [cwd, home] : [cwd])
  const granted = await realPaths($, union(addDirs, writeDirs))
  const refusal = homeHeadRefusal(realCwd ?? cwd, realHome ?? '') ?? secretDirRefusal(granted, realHome ?? '', 'addDirs/writeDirs')
  if (refusal) {
    await setRun($, id, { state: 'failed', endedAt: await $.clock.now(), activity: refusal })
    await refreshStatus($, limits)
    return notStarted(id, model, cwd, `${refusal} A Head never runs where Hydra's rules cannot keep it inside a project.`, engine)
  }
  const accounts = await accountsOf($, engine)
  // One account (the usual case, and every engine without account support): run as before, nothing recorded.
  if (accounts.length <= 1) return startHead($, { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort, engine }, undefined, outer, limits, id)
  return runOnAccounts($, { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort, engine }, accounts, outer, limits, id)
}

type HeadSpec = { task: string; cwd: string; model: string; maxTurns: number; addDirs: string[]; writeDirs: string[]; shell: boolean; minutes: number; effort?: string; engine: Engine }

/** Starts one Head run on `account` (undefined: the CLI's own config): its engine's run function, with the account's env or token folder. */
async function startHead($: EngineInterface, head: HeadSpec, account: Account | undefined, outer: AbortSignal, limits: HeadLimits, id: string): Promise<HeadResult> {
  const { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort, engine } = head
  const env = accountEnv(account)
  if (engine === 'agy') return runAgyHead($, { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort, tokenDir: account?.dir }, outer, limits, id)
  if (engine === 'codex') return runCodexHead($, { task, cwd, model, maxTurns, addDirs: union(addDirs, writeDirs), writeDirs, minutes, effort, env }, outer, limits, id)
  if (engine === 'codebuddy') return runBuddyHead($, { task, cwd, model, maxTurns, addDirs: union(addDirs, writeDirs), writeDirs, shell, minutes, effort, env }, outer, limits, id)
  if (engine === 'workbuddy') {
    const buddyEnv = { ...workbuddyEnv(await homeOf($)), ...(env ?? {}) }
    return runBuddyHead($, { task, cwd, model, maxTurns, addDirs: union(addDirs, writeDirs), writeDirs, shell, minutes, effort, env: buddyEnv, engine: 'workbuddy' }, outer, limits, id)
  }
  // OpenCode never gets a shell (it does not check a command's paths) and takes no effort level.
  if (engine === 'opencode') return runOpenCodeHead($, { task, cwd, model, maxTurns, addDirs, writeDirs, minutes, env }, outer, limits, id)
  return runCommandCodeHead($, { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort }, outer, limits, id)
}

/**
 * A Head on an engine with several accounts: `rotateAccounts` (lib/accounts.ts) runs it on the strategy's pick and, when it
 * stops at a usage limit, on the next free account. Here the steps are wired to the store, the run record and the engine.
 */
async function runOnAccounts($: EngineInterface, head: HeadSpec, accounts: readonly Account[], outer: AbortSignal, limits: HeadLimits, id: string): Promise<HeadResult> {
  const { engine, cwd, model } = head
  // Each account's run reports its own tokens; a Head that switched used every one of them.
  let spent: string | undefined
  const tokensNow = async () => (await readRuns($)).find(run => run.id === id)?.tokens
  const result = await rotateAccounts<HeadResult>({
    count: accounts.length,
    minutes: head.minutes,
    cwd,
    engine,
    isAborted: () => outer.aborted,
    pick: tried => pickUsable($, engine, accounts, tried),
    now: () => $.clock.now(),
    begin: async (name, isSwitch) => {
      if (isSwitch) spent = addTokens(spent, await tokensNow())
      await markUsed($, name, await $.clock.now())
      await setRun($, id, { account: name, ...(isSwitch ? { state: 'running' as const, endedAt: undefined, activity: `switched to ${name}` } : {}) })
    },
    run: (account, note, minutes) => startHead($, { ...head, task: head.task + note, minutes }, account, outer, limits, id),
    cooled: (name, until) => recordCooldown($, name, until),
    refuse: async reason => {
      await setRun($, id, { state: 'failed', endedAt: await $.clock.now(), activity: reason })
      await refreshStatus($, limits)
      return notStarted(id, model, cwd, reason, engine)
    },
  })
  if (spent) await setRun($, id, { tokens: addTokens(spent, await tokensNow()) })
  return result
}
