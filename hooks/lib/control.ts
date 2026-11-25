/**
 * @author Shakib
 * @since 25/11/26
 */
import type { EngineInterface } from 'claude-code'

import { headLine, hideFinished, visibleRuns } from './accounts'
import { EFFORTS, effortModeOf, isEffortMode } from './effort'
import type { EffortMode } from './effort'
import { AUTO, ENGINES, engineLabel, engineOf, headModelFor, isAuto, isEngine, isModelFor, parseEngineList, poolOf } from './engines'
import type { Engine } from './engines'
import { listRuns } from './format'
import { huntControllers } from './launch'
import { homeOf } from './platform'
import { NO_CONSENT } from './policy'
import { controllers, hasConsent, hasConsentAll, needsEngineCheck, preflight, preflightText, readyEngines, stopHeadsNow } from './runtime'
import { readMode, readRuns, updateMode, updateRuns } from './state'

/** What the control tool needs to know about the Lead's defaults; `onChanged` refreshes whatever the host shows. */
export type ControlSettings = { defaultEngine: Engine; defaultHead: string; defaultEffort: EffortMode; isAutoDefault: boolean; onChanged?: () => Promise<void> }

/** The control tool: list, stop and clear Heads, or turn Hydra on, off or to another effort or engine. */
export async function runControl($: EngineInterface, e: Readonly<Record<string, unknown>>, settings: ControlSettings): Promise<{ result: string } | { deny: string }> {
  const { defaultEngine, defaultHead, defaultEffort, isAutoDefault } = settings
    const action = String(e.action ?? 'list')
    const now = await $.clock.now()
    const ids = typeof e.id === 'string' && e.id && e.id !== 'all' ? [e.id] : ('all' as const)
    if (action === 'list') {
      const hydra = await readMode($)
      const head = hydra?.isOn ? `Hydra on · ${headLine(hydra, defaultEngine)} · effort ${effortModeOf(hydra)}` : 'Hydra off'

      const home = await homeOf($)
      const saved = home ? `\nReports: ${home}/.claude/hydra/heads/${await $.session.id()}/<head>.md (a hunt's in ${home}/.claude/hydra/hunts/${await $.session.id()}/<hunt>/)` : ''
      return { result: `${head}\n${listRuns(visibleRuns(await readRuns($)), now, id => controllers.has(id))}${saved}` }
    }
    if (action === 'stop') {
      const list = await readRuns($)
      const targets = list.filter(run => (run.state === 'running' || run.state === 'queued') && (ids === 'all' || ids.includes(run.id)))
      // A stopped hunt starts no further Head and stops the ones it has running.
      const hunts = [...huntControllers.keys()].filter(name => ids === 'all' || ids.includes(name))
      for (const name of hunts) huntControllers.get(name)?.abort('stopped by the Lead')
      const stoppedHunts = hunts.length > 0 ? `Stopping hunt ${hunts.join(', ')} and its Heads. ` : ''
      if (targets.length === 0) return { result: stoppedHunts || `No running or queued Head or hunt${ids === 'all' ? '' : ` ${ids[0]}`}.` }
      const ghosts = await stopHeadsNow($, targets.map(run => run.id), 'stopped by the Lead')

      return { result: `${stoppedHunts}Stopping ${targets.map(run => run.id).join(', ')}.${ghosts.length > 0 ? ` ${ghosts.join(', ')} had no live process and were marked failed.` : ''}` }
    }
    if (action === 'clear') {
      // Only hide them: they stay in the session's runs, so `resume "<name>"` still finds them.
      await updateRuns($, hideFinished)

      return { result: 'Cleared finished and failed Heads from the views. They can still be resumed by name.' }
    }
    const stored = await readMode($)
    const current = stored ?? { isOn: false, headModel: defaultHead, effort: defaultEffort, engine: defaultEngine }
    if (action === 'off') {
      await updateMode($, () => ({ ...current, isOn: false, surge: undefined }))
    } else if ((action === 'on' || action === 'effort') && (String(e.engine) === AUTO || Array.isArray(e.engines) || (isAuto(stored) && e.engine === undefined) || (action === 'on' && !stored?.isOn && !stored?.pinned && isAutoDefault && e.engine === undefined))) {
      const listed = Array.isArray(e.engines) ? parseEngineList(e.engines.map(String).join(',')) : undefined
      if (listed && (listed.bad.length > 0 || listed.engines.length === 0)) return { deny: `engines must be some of: ${ENGINES.join(', ')}.` }
      const wanted = listed ? listed.engines : isAuto(stored) ? poolOf(stored) : [...ENGINES]
      const effort = typeof e.effort === 'string' ? e.effort : undefined
      if (effort !== undefined && !isEffortMode(effort)) return { deny: `effort must be auto or one of: ${EFFORTS.join(', ')}.` }
      let pool: Engine[] = wanted
      if (needsEngineCheck(action, e)) {
        const ready = await readyEngines($, wanted)
        if (ready.pool.length === 0) return { deny: ['No requested engine is ready:', ...ready.skipped.map(item => `${item.engine}: ${item.problem}`)].join(' ') }
        if (!(await hasConsentAll($, ready.pool, false))) return { deny: NO_CONSENT }
        pool = ready.pool
      }
      const headModel = typeof e.headModel === 'string' && e.headModel ? e.headModel : isModelFor('commandcode', current.headModel) ? current.headModel : defaultHead
      await updateMode($, () => ({ isOn: action === 'on' ? true : current.isOn, headModel, effort: effort ?? effortModeOf(stored), engine: AUTO, engines: pool, pinned: listed === undefined && stored?.pinned === true, surge: stored?.surge }))
    } else if (action === 'on' || action === 'effort') {
      if (e.engine !== undefined && !isEngine(e.engine)) return { deny: `engine must be one of: ${[...ENGINES, AUTO].join(', ')}.` }
      const engine = isEngine(e.engine) ? e.engine : engineOf(stored, defaultEngine)
      if (needsEngineCheck(action, e)) {
        const check = await preflight($, engine)
        if (check.problems.length > 0) return { deny: preflightText(check) }
        if (!(await hasConsent($, current.headModel, false, engine))) return { deny: NO_CONSENT }
      }
      const effort = typeof e.effort === 'string' ? e.effort : undefined
      if (effort !== undefined && !isEffortMode(effort)) return { deny: `effort must be auto or one of: ${EFFORTS.join(', ')}.` }
      const headModel = headModelFor(engine, typeof e.headModel === 'string' && e.headModel ? e.headModel : undefined, current.headModel, defaultHead)
      await updateMode($, () => ({ isOn: action === 'on' ? true : current.isOn, headModel, effort: effort ?? effortModeOf(stored), engine, pinned: e.engine === undefined && stored?.pinned === true, surge: stored?.surge }))
    } else {
      return { deny: `Unknown action "${action}". Use list, stop, clear, on, off or effort.` }
    }
    await settings.onChanged?.()
    const hydra = await readMode($)

    return { result: hydra?.isOn ? `Hydra on · Head ${hydra.headModel} on ${engineLabel(hydra, defaultEngine)} · effort ${effortModeOf(hydra)}` : 'Hydra off.' }
}
