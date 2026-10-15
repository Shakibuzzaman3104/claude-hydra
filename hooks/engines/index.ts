/**
 * @author Shakib
 * @since 15/10/26
 */
import type { EngineInterface } from 'claude-code'

import type { HeadRun } from '../../types'
import { isHeadEffort } from '../lib/effort'
import { AGY_MODEL, DEFAULT_ENGINE, modelFor } from '../lib/engines'
import type { Engine } from '../lib/engines'
import { formatReport, strings } from '../lib/format'
import type { HeadLimits } from '../lib/format'
import { DEFAULT_MINUTES, gate, notStarted, realPaths, refreshStatus, setRun, stopReason } from '../lib/runtime'
import { homeOf } from '../lib/platform'
import { homeHeadRefusal, union } from '../lib/safety'
import { updateRuns, updateTick } from '../lib/state'
import { runAgyHead } from './agy'
import { runBuddyHead } from './codebuddy'
import { runCodexHead } from './codex'
import { runCommandCodeHead } from './commandcode'

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
 * Where each engine's Head is started. To add an engine: write `engines/<name>.ts` (its stream fold, command line, lockdown settings
 * and a `run<Name>Head` function, as `codex.ts` does), name it in `lib/engines.ts`, and add one line here.
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
  const refusal = homeHeadRefusal(realCwd ?? cwd, realHome ?? '')
  if (refusal) {
    await setRun($, id, { state: 'failed', endedAt: await $.clock.now(), activity: refusal })
    await refreshStatus($, limits)
    return notStarted(id, model, cwd, `${refusal} A Head never runs where Hydra's rules cannot keep it inside a project.`, engine)
  }
  if (engine === 'agy') return runAgyHead($, { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort }, outer, limits, id)
  if (engine === 'codex') return runCodexHead($, { task, cwd, model, maxTurns, addDirs: union(addDirs, writeDirs), writeDirs, minutes, effort }, outer, limits, id)
  if (engine === 'codebuddy') return runBuddyHead($, { task, cwd, model, maxTurns, addDirs: union(addDirs, writeDirs), writeDirs, shell, minutes, effort }, outer, limits, id)
  return runCommandCodeHead($, { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort }, outer, limits, id)
}
