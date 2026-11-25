/**
 * @author Shakib
 * @since 06/10/26
 */
import type { EngineInterface, Register } from 'claude-code'
import type { HydraMode } from '../types'

import { sweepAgyHomes } from './engines/agy'
import { sweepBuddySettings } from './engines/codebuddy'
import { sweepCodexTemps } from './engines/codex'
import { writeRules } from './engines/commandcode'
import { sweepOpenCodeFiles } from './engines/opencode'
import { coolingLines, isStrategy, timeOf, parseAccountsArgs, runAccountsCommand, setAccountStrategy } from './lib/accounts'
import { EFFORTS, effortModeOf, isEffortMode } from './lib/effort'
import type { EffortMode } from './lib/effort'
import { AUTO, DEFAULT_ENGINE, ENGINES, ENGINE_LABEL, engineLabel, engineOf, headModelFor, isAuto, isEngine, isModelFor, parseEngineList, poolOf } from './lib/engines'
import type { Engine } from './lib/engines'
import { REPORT_HEAD, isLive, reportContext, reportNotice, stopRuns } from './lib/format'
import { parseHunt } from './lib/hunt'
import { CONTROL_TOOL_DEF, HEAD_TOOL_DEF, HUNT_TOOL_DEF } from './lib/tools'
import { runControl } from './lib/control'
import { REPORT_HUNT, huntContext, huntControllers, huntJobs, huntNotice, prepareHead, runHuntJob, runStructured, sweepHunts, vetHunt } from './lib/launch'
import type { Launch } from './lib/launch'
import { planOnboarding, setupCard, takeWelcome, onlyReadyNote } from './lib/onboarding'
import { pauseOneSecond } from './lib/platform'
import { HYDRA_HELP, HYDRA_POLICY, ROUTES, STATUSLINE_HELP, SURGE_LABEL, SURGE_OFF_HINT, SURGE_POLICY, parseHydraArgs } from './lib/policy'
import { announceEnding, backgroundJobs, controllers, createReplyBox, hasConsent, hasConsentAll, pendingPrompts, preflight, preflightText, readyEngines, refreshHeads, refreshStatus, setConfiguredEngine, storeLead, sweepStatusFiles, waitForResult } from './lib/runtime'
import type { HeadResult } from './lib/runtime'
import { setExtraHomeRead } from './lib/safety'
import { schemaProblem } from './lib/schema'
import type { Schema } from './lib/schema'
import { readMode, readRuns, updateMode, updateRuns, updateTick } from './lib/state'
import { afterChange, afterEdit, afterSubmit, dismiss, isSurgeLive, surgeDecorations, wantsDismissal } from './lib/surge'
import type { SurgeState } from './lib/surge'
import { bandView, headCardView, headsPaneView, usagePaneView } from './lib/views'

export * from './lib/accounts'
export * from './lib/checks'
export * from './lib/effort'
export * from './lib/engines'
export * from './lib/format'
export * from './lib/hunt'
export * from './lib/launch'
export * from './lib/onboarding'
export * from './lib/policy'
export * from './lib/rounds'
export * from './lib/runtime'
export * from './lib/safety'
export * from './lib/schema'
export * from './lib/surge'
export * from './engines/agy'
export * from './engines/codebuddy'
export * from './engines/codex'
export * from './engines/commandcode'
export * from './engines/index'
export * from './engines/opencode'

/** Also declared in lib/policy.ts, which words the policy and help with them: keep the two the same. The validator reads hook matchers only from this file. */
const USAGE_COMMAND = 'hydra-usage'
const HEAD_TOOL = 'mcp__hydra__head'
const CONTROL_TOOL = 'mcp__hydra__control'
const HUNT_TOOL = 'mcp__hydra__hunt'

/** When a background result was sent: the host may hold it until the Lead's turn ends, so a late one can be told from a new one. */
const lateNote = (now: number) => `(sent at ${timeOf(now)}, when it ended; if it reaches you much later, its report file may already have been read and acted on)\n`

const PANE = 'hydra-usage'
const HEADS_PANE = 'hydra-heads'

const REFRESH_MS = 120_000

/** How long the installed-but-not-consented engine check is kept: prompt.compose runs every prompt. */
const ENGINE_NOTE_MS = 10 * 60_000

let engineNote: { at: number; text: string; signature: string } | undefined

/** The Lead's prompt when Hydra was on earlier this session and is off now: the Heads refuse, so Claude works alone. */
const HYDRA_OFF_POLICY = '# Hydra mode (off)\nHydra is off now: the Head and hunt tools refuse, so do the work yourself. The person turns it back on with /hydra.'

const OFF_SECTION: Record<string, string> = {
  'hydra:policy': HYDRA_OFF_POLICY,
  'hydra:limits': '- Usage limits: Hydra is off, so no Head is picking an account.',
  'hydra:surge': '# Hydra surge (off)\nHydra is off now, so no surge applies.',
  'hydra:engines': '- Hydra is off, so no engine can be added right now.',
}

/**
 * The sections that turn last prompt's Hydra text off, each under the id it was sent with: a session section is kept until one
 * with its id replaces it, so the policy, the limits, the surge and the engines note all have to be answered. Ids never sent are
 * harmless: an off line for them says nothing the Lead acts on.
 */
export const offSections = () =>
  Object.entries(OFF_SECTION).map(([id, text]) => ({ id, text, scope: 'session' as const }))

/** The Lead's line naming engines installed and signed in but not agreed to, or '' when every ready engine is in the pool. */
export const engineNoteLine = (missing: readonly Engine[], pool: readonly Engine[]) =>
  missing.length === 0 ? ''
    : `- Installed but not turned on: ${missing.join(',')}. Only the person can add ${missing.length === 1 ? 'it' : 'them'}, with /hydra engines=${pool.join(',')},${missing.join(',')}; ask them instead of naming ${missing.length === 1 ? 'it' : 'them'} in a Head.`

/**
 * The engine note, cached: preflight runs processes, and prompt.compose runs on every prompt. The person otherwise learns of an
 * engine installed but not agreed to only when a Head is refused.
 */
async function engineNoteFor($: EngineInterface, hydra: HydraMode, configured: Engine): Promise<string> {
  const now = await $.clock.now()
  const pool = isAuto(hydra) ? poolOf(hydra) : [engineOf(hydra, configured)]
  const signature = `${hydra.headModel}|${pool.join(',')}`
  if (engineNote && engineNote.signature === signature && now - engineNote.at < ENGINE_NOTE_MS) return engineNote.text
  const missing: Engine[] = []
  for (const engine of ENGINES) {
    if (pool.includes(engine)) continue
    if ((await preflight($, engine)).problems.length > 0) continue
    if (!(await hasConsent($, hydra.headModel, false, engine))) missing.push(engine)
  }
  const text = engineNoteLine(missing, pool)
  engineNote = { at: now, text, signature }
  return text
}

let isWorkerRunning = false

/** The person waved the keyword off for the draft in the box, or undefined while keywords are live. */
let surgeState: SurgeState = undefined

export const register: Register = (on, options) => {
  const fiveHourUsd = Number(options.headsFiveHourUsd ?? 0) || 0
  const weeklyUsd = Number(options.headsWeeklyUsd ?? 0) || 0
  const plan = String(options.headsPlan ?? '')
  const defaultHead = String(options.headModel ?? 'deepseek/deepseek-v4.1-flash')
  const defaultEffort: EffortMode = isEffortMode(options.headEffort) ? options.headEffort : 'auto'
  const defaultEngine: Engine = isEngine(options.headEngine) ? options.headEngine : DEFAULT_ENGINE
  // `auto` is a setting, not an engine: until the person picks one, /hydra uses whichever engines are ready here.
  const isAutoDefault = options.headEngine === AUTO
  // On unless the person turned it off: a Head the engine stops moves to another model or engine instead of failing.
  const isFallbackOn = options.headFallback !== false
  const isAutoStart = options.autoStart === true
  const isKeywordOn = options.surgeKeywords !== false
  const launch: Launch = { defaultEngine, defaultHead, isFallbackOn }
  setConfiguredEngine(defaultEngine)
  setAccountStrategy(isStrategy(options.accountStrategy) ? options.accountStrategy : 'fill')
  setExtraHomeRead([String(options.headReadDirs ?? '')])

  on('session.start', async ($, e, next) => {
    if (!isWorkerRunning) {
      isWorkerRunning = true
      void (async () => {
        for (;;) {
          const text = await pendingPrompts.next()
          await $.prompt.submit({ text, asUser: true }).catch(() => undefined)
        }
      })()
      void (async () => {
        for (;;) {
          const job = await backgroundJobs.next()
          const controller = new AbortController()
          controllers.set(job.id, controller)
          void runStructured($, { input: job.input, headModel: job.headModel, id: job.id, engine: job.engine ?? defaultEngine, routing: job.routing ?? { headModel: job.headModel, configured: defaultHead, fallback: isFallbackOn } }, controller.signal, job.schema)
            .then(structured => structured.result)
            .catch(async error => {
              const reason = `failed before it reported: ${String(error).slice(0, 300)}`
              const now = await $.clock.now()
              await updateRuns($, list => stopRuns(list, [job.id], reason, now))
              await refreshStatus($)
              return { text: `Hydra Head ${job.id} ${reason}`, isDone: false }
            })
            .then(async result => {
              await announceEnding($, job.id)
              if (!job.reply?.(result)) await $.prompt.submit({ text: `Hydra Head ${job.id} finished.\n${lateNote(await $.clock.now())}${result.text}` })
            })
            .finally(() => controllers.delete(job.id))
        }
      })()
      void (async () => {
        for (;;) {
          const job = await huntJobs.next()
          const name = job.plan.name
          const controller = new AbortController()
          huntControllers.set(name, controller)
          void runHuntJob($, job, controller.signal)
            .catch(error => `hunt ${name} · failed before it reported: ${String(error).slice(0, 300)}`)
            .then(async text => {
              if (!job.reply?.(text)) await $.prompt.submit({ text: `Hydra Hunt ${name} finished.\n${lateNote(await $.clock.now())}${text}` }).catch(() => undefined)
            })
            .finally(() => huntControllers.delete(name))
        }
      })()
    }
    await $.command.register({ name: USAGE_COMMAND, description: 'Hydra: Claude and Head usage limits', immediate: true })
    await $.command.register({ name: 'heads', description: 'Hydra: watch the Heads work, live (opens without interrupting Claude)', immediate: true })
    await $.command.register({
      name: 'hydra',
      description: 'Turn on Hydra: Claude leads, Heads (Command Code, CodeBuddy, Codex, Antigravity, WorkBuddy or OpenCode agents) implement',
      argumentHint: '[task] [effort=<level>] [head=<model>] [engine=<name>] | rampage | chimera | calm | off | status | help | accounts',
    })
    await $.tool.register(HEAD_TOOL_DEF)
    await $.tool.register(HUNT_TOOL_DEF)
    await $.tool.register(CONTROL_TOOL_DEF)
    $.ui.status(undefined)
    // A reload or restart ends every Head this module was running; say so instead of showing them running forever.
    const startNow = await $.clock.now()
    const stranded = (await readRuns($)).filter(run => (run.state === 'running' || run.state === 'queued') && run.cwd).map(run => run.cwd!)
    for (const cwd of new Set([...stranded, await $.session.root()])) await writeRules($, cwd).catch(() => undefined)
    await updateRuns($, list => stopRuns(list, 'all', 'ended by a reload or restart', startNow))
    void sweepStatusFiles($)
    void sweepBuddySettings($)
    void sweepAgyHomes($)
    void sweepCodexTemps($)
    void sweepOpenCodeFiles($)
    void sweepHunts($)
    const usage = await $.session.usage()
    await storeLead($, usage.rateLimits)
    void refreshHeads($)
    $.clock.every(REFRESH_MS, () => void refreshHeads($))
    // The views' clock: stamps the time once a second while some Head is live, and once more after the last one goes quiet.
    let wasLive = false
    $.clock.every(1_000, () => void (async () => {
      const now = await $.clock.now()
      const isAnyLive = (await readRuns($)).some(run => isLive(run, now))
      if (isAnyLive || wasLive) await updateTick($, () => now)
      wasLive = isAnyLive
    })())

    const started = await next(e)
    if (isAutoStart && !(await readMode($))?.isOn) void $.command.run({ command: 'hydra' }).catch(() => undefined)

    return started
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await storeLead($, e.rateLimits)

    return next(e)
  })

  on('command.run', { command: 'hydra' }, async ($, e) => {
    const { action, leadModel, headModel, effort, engine, engines, surge, task, unknown } = parseHydraArgs(e.args)
    const stored = await readMode($)
    const current = stored ?? { isOn: false, headModel: defaultHead, effort: defaultEffort, engine: defaultEngine }
    const currentEffort = stored ? effortModeOf(stored) : defaultEffort
    const currentEngine = engineOf(stored, defaultEngine)

    if (action === 'help') return { text: HYDRA_HELP }
    if (action === 'statusline') return { text: STATUSLINE_HELP }
    if (action === 'accounts') return { text: await runAccountsCommand($, parseAccountsArgs(task)) }
    if (action === 'engines') {
      const lines = ['🐉 Engines (what each is for; /hydra engine=auto lets Claude pick per Head):']
      for (const name of ENGINES) {
        const check = await preflight($, name)
        lines.push(`  ${check.problems.length === 0 ? '✓' : '✗'} ${name} (${ENGINE_LABEL[name]}) — ${ROUTES[name]}`, ...check.problems.map(problem => `      ${problem}`))
      }
      if (isAuto(stored) && current.isOn) lines.push(`Now: auto, pool ${poolOf(stored).join(', ')}.`)
      else if (current.isOn) lines.push(`Now: ${engineLabel(current, defaultEngine)}.`)
      return { text: lines.join('\n') }
    }
    if (action === 'status') {
      const model = await $.session.model()
      return { text: current.isOn ? `🐉 Hydra on · Lead ${model} · Head ${current.headModel} on ${engineLabel(current, defaultEngine)} · effort ${currentEffort}${stored?.surge ? ` · ${SURGE_LABEL[stored.surge]}` : ''}` : 'Hydra is off. Turn it on with /hydra.' }
    }
    if (action === 'off') {
      await updateMode($, () => ({ ...current, isOn: false, surge: undefined }))
      $.ui.invalidate('tool.describe')
      await refreshStatus($)
      return { text: 'Hydra off. Claude works alone again.' }
    }
    if (surge === 'calm') {
      if (!stored?.isOn) return { text: 'Hydra is off. Turn it on with /hydra.' }
      if (!stored.surge) return { text: 'Hydra is already calm.' }
      await updateMode($, () => ({ ...stored, surge: undefined }))
      await refreshStatus($)
      return { text: `🐉 ${SURGE_LABEL[stored.surge]} off. Plain Hydra again.` }
    }
    const nextSurge = surge ?? (stored?.isOn ? stored.surge : undefined)
    const surgeText = nextSurge ? ` · ${SURGE_LABEL[nextSurge]} until /hydra calm` : ''

    if (unknown) return { text: `Unknown option "${unknown}". A task needs a few words; /hydra help lists the options.` }
    if (effort !== undefined && !isEffortMode(effort)) return { text: `Unknown effort "${effort}". Use auto (the Lead picks low to max per Head) or one of: ${EFFORTS.join(', ')}.` }
    if (engine !== undefined && !isEngine(engine) && engine !== AUTO) return { text: `Unknown engine "${engine}". Use ${[...ENGINES, AUTO].join(', ')}.` }
    // A running session, or an engine the person chose, carries on; anything else is planned again, so engines set up since join.
    const keepsStored = !!stored && (stored.isOn || stored.pinned === true) && engine === undefined && engines === undefined
    const keepsAuto = isAuto(stored) && keepsStored
    // No engine named: use the configured one if it is ready, else whichever are (see onboardingPlan).
    const planned = engine === undefined && engines === undefined && !keepsAuto ? await planOnboarding($, keepsStored ? engineOf(stored, defaultEngine) : isAutoDefault ? AUTO : defaultEngine) : undefined
    if (planned?.plan.kind === 'setup') return { text: setupCard(planned.skipped) }
    const plannedPool = planned?.plan.kind === 'auto' ? planned.plan.pool : undefined
    const plannedEngine = planned?.plan.kind === 'fixed' ? planned.plan.engine : undefined
    if (engine === AUTO || engines !== undefined || keepsAuto || plannedPool) {
      const parsed = engines !== undefined ? parseEngineList(engines) : { engines: plannedPool ?? (keepsAuto ? poolOf(stored) : [...ENGINES]), bad: [] as string[] }
      if (parsed.bad.length > 0) return { text: `Unknown engine "${parsed.bad[0]}". Use ${ENGINES.join(', ')}.` }
      if (parsed.engines.length === 0) return { text: 'engines= needs at least one of: ' + ENGINES.join(', ') + '.' }
      const ready = await readyEngines($, parsed.engines)
      if (ready.pool.length === 0) return { text: ['🐉 Hydra can\'t start yet: none of those engines is ready.', ...ready.skipped.map(item => `  • ${ENGINE_LABEL[item.engine]}: ${item.problem}`), 'Then run /hydra again.'].join('\n') }
      if (!(await hasConsentAll($, ready.pool, true))) return { text: 'Hydra stays off. Run /hydra when you want Heads to work for Claude.' }
      const nextAuto = { isOn: true, headModel: headModel ?? (isModelFor('commandcode', current.headModel) ? current.headModel : defaultHead), effort: effort ?? currentEffort, engine: AUTO, engines: ready.pool, pinned: engines !== undefined || (keepsAuto && stored?.pinned === true), surge: nextSurge }
      await updateMode($, () => nextAuto)
      $.ui.invalidate('tool.describe')
      await refreshStatus($)
      const autoModel = await $.session.model()
      const autoHint = leadModel && !autoModel.toLowerCase().includes(leadModel) ? ` Run /model ${leadModel} to switch the Lead.` : ''
      const left = plannedPool ? '' : ready.skipped.map(item => `\n⚠ ${ENGINE_LABEL[item.engine]} left out: ${item.problem}`).join('')
      const autoEffort = nextAuto.effort === 'auto' ? 'effort auto (Lead picks low to max)' : `effort ${nextAuto.effort}`
      const autoText = `🐉 Hydra on · Lead ${autoModel} · Heads on ${engineLabel(nextAuto, defaultEngine)}, Claude picks the engine per Head · ${autoEffort}${surgeText}. /heads to watch, /hydra engines for what each is for, /hydra off to stop.${autoHint}${left}${ready.warnings.map(warning => `\n⚠ ${warning}`).join('')}${await takeWelcome($)}`
      if (task) {
        if (isWorkerRunning) pendingPrompts.push(task)
        else return { text: autoText, context: [task] }
      }
      return { text: autoText }
    }
    const nextEngine = (engine ?? plannedEngine ?? currentEngine) as Engine
    const next = { isOn: true, headModel: headModelFor(nextEngine, headModel, current.headModel, defaultHead), effort: effort ?? currentEffort, engine: nextEngine, pinned: engine !== undefined || (keepsStored && stored?.pinned === true && nextEngine === currentEngine), surge: nextSurge }
    const check = planned ? { problems: [] as string[], warnings: planned.warnings } : await preflight($, next.engine as Engine)
    if (check.problems.length > 0) return { text: preflightText(check) }
    if (!(await hasConsent($, next.headModel, true, next.engine as Engine))) return { text: 'Hydra stays off. Run /hydra when you want Heads to work for Claude.' }
    await updateMode($, () => next)
    $.ui.invalidate('tool.describe')
    await refreshStatus($)
    const model = await $.session.model()
    const switchHint = leadModel && !model.toLowerCase().includes(leadModel) ? ` Run /model ${leadModel} to switch the Lead.` : ''
    const changed = current.isOn && next.effort !== currentEffort ? ' Running Heads switch at their next round.' : ''
    const effortText = next.effort === 'auto' ? 'effort auto (Lead picks low to max)' : `effort ${next.effort}`
    const warnings = check.warnings.map(warning => `\n⚠ ${warning}`).join('')
    const only = planned?.plan.kind === 'fixed' && planned.plan.isFallback ? `\n${onlyReadyNote(nextEngine)}` : ''
    const text = `🐉 Hydra on · Lead ${model} · Head ${next.headModel} on ${ENGINE_LABEL[nextEngine]} · ${effortText}${surgeText}. /heads to watch, /hydra off to stop.${changed}${switchHint}${warnings}${only}${await takeWelcome($)}`

    // A command's `context` only rides along with the next prompt; submitting the task starts the Lead's turn now.
    if (task) {
      if (isWorkerRunning) pendingPrompts.push(task)
      else return { text, context: [task] }
    }

    return { text }
  })

  // A background Head's report reaches Claude as context, not as a long message preview: the person sees one line.
  on('prompt.submit', async ($, e, next) => {
    const origin = e.origin as { kind: string; name?: string }
    if (origin.kind === 'plugin' && origin.name === 'hydra' && !e.command && REPORT_HEAD.test(e.text)) return next({ ...e, text: reportNotice(e.text), context: [...(e.context ?? []), reportContext(e.text)] })
    if (origin.kind === 'plugin' && origin.name === 'hydra' && !e.command && REPORT_HUNT.test(e.text)) return next({ ...e, text: huntNotice(e.text), context: [...(e.context ?? []), huntContext(e.text)] })

    // A surge word the person typed turns that mode on for the one prompt; /hydra rampage|chimera sets it for the session.
    const sent = afterSubmit(surgeState, e.text, origin.kind)
    surgeState = sent.state
    const surge = isKeywordOn && !e.command ? sent.surge : undefined
    if (!surge) return next(e)
    const stored = await readMode($)
    if (!stored) {
      $.ui.toast(SURGE_OFF_HINT(surge))

      return next(e)
    }
    if (!stored.isOn) {
      await updateMode($, () => ({ ...stored, isOn: true }))
      $.ui.invalidate('tool.describe')
      await refreshStatus($)
    }
    if (stored.isOn && (stored.surge === surge || stored.surge === 'chimera')) return next(e)
    $.ui.toast(`🐉 ${SURGE_LABEL[surge]} for this prompt`)

    return next({ ...e, context: [...(e.context ?? []), SURGE_POLICY(surge, 'prompt')] })
  })

  on('prompt.edit', async ($, e, next) => {
    if (!isKeywordOn) return next(e)
    // Like the engine's own keywords: backspace right after the word, or Option+W, keeps the word and drops its effect.
    if (wantsDismissal(surgeState, { text: e.text, cursor: e.cursor }, e.key, e.inputText)) {
      surgeState = dismiss(e.text)
      $.ui.toast('🐉 Keyword off for this prompt')

      return { text: e.text, cursor: e.cursor }
    }
    const box = await next(e)
    surgeState = afterEdit(surgeState, { text: e.text, cursor: e.cursor }, { text: box.text, cursor: box.cursor })
    const painted = isSurgeLive(surgeState) ? surgeDecorations(box.text) : []

    return painted.length > 0 ? { ...box, decorations: [...(box.decorations ?? []), ...painted] } : box
  })

  // A recalled history entry or a fill reaches the box without a `prompt.edit`.
  on('prompt.change', async ($, e, next) => {
    surgeState = afterChange(surgeState, e.text, e.origin.kind)
    const painted = isKeywordOn && isSurgeLive(surgeState) ? surgeDecorations(e.text) : []
    if (painted.length > 0) void $.prompt.paint({ text: e.text, decorations: painted }).catch(() => undefined)

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const hydra = await readMode($)
    if (!hydra?.isOn) {
      // Hydra was on earlier this session (a stored mode, or Heads already ran): tell the Lead its tools refuse now, by the
      // same ids it read the policy under, so those section texts are replaced rather than left standing.
      const wasOn = hydra !== null || (await readRuns($)).length > 0
      if (!wasOn) return composed
      return { sections: [...composed.sections, ...offSections()] }
    }

    const policy = { id: 'hydra:policy', text: HYDRA_POLICY(hydra.headModel, effortModeOf(hydra), isAuto(hydra) ? AUTO : engineOf(hydra, defaultEngine), poolOf(hydra), { fallback: isFallbackOn, pinned: hydra.pinned === true }), scope: 'session' as const }
    const cooling = await coolingLines($, isAuto(hydra) && hydra.pinned ? poolOf(hydra) : ENGINES).catch(() => [])
    const limited = cooling.length > 0 ? [{ id: 'hydra:limits', text: `- Usage limits in force now (Hydra moves a Head off these on its own; route new work elsewhere): ${cooling.join('; ')}.`, scope: 'session' as const }] : []

    const surged = hydra.surge ? [{ id: 'hydra:surge', text: SURGE_POLICY(hydra.surge, 'session'), scope: 'session' as const }] : []
    const engineNoteText = await engineNoteFor($, hydra, defaultEngine).catch(() => '')
    const engines = engineNoteText ? [{ id: 'hydra:engines', text: engineNoteText, scope: 'session' as const }] : []

    return { sections: [...composed.sections, policy, ...limited, ...surged, ...engines] }
  })

  on('tool.describe', { tool: HEAD_TOOL }, async ($, e, next) => {
    const described = await next(e)

    return { ...described, isDeferred: !(await readMode($))?.isOn }
  })

  on('tool.call', { tool: HEAD_TOOL }, async ($, e, next) => {
    const hydra = await readMode($)
    if (!hydra?.isOn) return { deny: 'Hydra is off. The person turns it on with /hydra.' }
    const schemaFault = e.schema === undefined || e.schema === null ? undefined : schemaProblem(e.schema)
    if (schemaFault) return { deny: `\`schema\`: ${schemaFault}.` }
    const schema = e.schema === undefined || e.schema === null ? undefined : (e.schema as Schema)
    const { schema: _schema, ...asked } = e as Record<string, unknown>
    const prepared = await prepareHead($, hydra, asked, launch)
    if ('deny' in prepared) return { deny: prepared.deny }
    const { input, headModel, id, engine, routing } = prepared
    if (e.background === true) {
      if (!isWorkerRunning) return { deny: 'Hydra is still starting in this session. Try again in a moment, or run this Head without background.' }
      backgroundJobs.push({ input, headModel, id, engine, routing, schema: schema ?? prepared.schema })

      return { result: `Head ${id} ${prepared.continues ? `continues ${prepared.continues}` : 'started'} in the background on ${typeof input.model === 'string' && input.model ? input.model : headModel} (${ENGINE_LABEL[engine]}). Its report arrives as a message from the hydra plugin when it finishes.` }
    }
    if (!isWorkerRunning) {
      const { result } = await runStructured($, prepared, next.signal, schema ?? prepared.schema)

      return { result: result.text }
    }
    // Run on the worker's long-lived `$`, so a cancelled call stops the Head cleanly instead of stranding it as running.
    // The hook waits through `$` calls: a hook's own time is capped at 10 s, and a `$` call in flight does not count.
    const { box, reply } = createReplyBox<HeadResult>(next.signal)
    backgroundJobs.push({ input, headModel, id, engine, routing, schema: schema ?? prepared.schema, reply })
    const result = await waitForResult(box, next.signal, () => pauseOneSecond($))

    return { result: result?.text ?? `Head ${id} keeps running in the background after the call was interrupted; its report arrives as a message from the hydra plugin. Stop it with ${CONTROL_TOOL} if it is no longer wanted.` }
  }).catch(($, e, next) => ({ deny: `Hydra: the Head could not run (${next.error.message ?? next.error.kind}). Run /hydra to check the setup.` }))

  on('tool.describe', { tool: HUNT_TOOL }, async ($, e, next) => {
    const described = await next(e)

    return { ...described, isDeferred: !(await readMode($))?.isOn }
  })

  on('tool.call', { tool: HUNT_TOOL }, async ($, e, next) => {
    const hydra = await readMode($)
    if (!hydra?.isOn) return { deny: 'Hydra is off. The person turns it on with /hydra.' }
    const parsed = parseHunt(e as Record<string, unknown>, await $.session.root())
    if ('deny' in parsed) return { deny: parsed.deny }
    const { plan } = parsed
    if (huntControllers.has(plan.name)) return { deny: `A hunt named "${plan.name}" is still running. Wait for it, stop it with ${CONTROL_TOOL} (id: "${plan.name}"), or pick another name.` }
    if (!isWorkerRunning) return { deny: 'Hydra is still starting in this session. Try again in a moment.' }
    const vetted = await vetHunt($, hydra, plan, defaultEngine)
    if ('deny' in vetted) return { deny: vetted.deny }
    parsed.notes = [...(parsed.notes ?? []), ...vetted.notes]
    if (e.background === true) {
      huntJobs.push({ plan, launch })

      return { result: [`Hunt ${plan.name} started in the background with ${plan.heads.length} Head(s). Its merged result arrives as a message from the hydra plugin when every Head has ended.`, ...(parsed.notes ?? [])].join('\n') }
    }
    const { box, reply } = createReplyBox<string>(next.signal)
    huntJobs.push({ plan, launch, reply })
    const text = await waitForResult(box, next.signal, () => pauseOneSecond($))

    return { result: [text ?? `Hunt ${plan.name} keeps running in the background after the call was interrupted; its merged result arrives as a message from the hydra plugin. Stop it with ${CONTROL_TOOL} (id: "${plan.name}") if it is no longer wanted.`, ...(parsed.notes ?? [])].join('\n') }
  }).catch(($, e, next) => ({ deny: `Hydra: the hunt could not run (${next.error.message ?? next.error.kind}). Run /hydra to check the setup.` }))

  on('tool.describe', { tool: CONTROL_TOOL }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  on('tool.call', { tool: CONTROL_TOOL }, async ($, e) => runControl($, e, { defaultEngine, defaultHead, defaultEffort, isAutoDefault, onChanged: async () => { $.ui.invalidate('tool.describe'); await refreshStatus($) } })).catch(($, e, next) => ({ deny: `Hydra control failed (${next.error.message ?? next.error.kind}).` }))

  on('command.run', { command: 'heads' }, async $ => {
    await $.ui.open({ id: HEADS_PANE, title: 'Heads' })

    return { text: 'Heads pane opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    return (await bandView($, e)) ?? next(e)
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const row = await next(e)
    try {
      return await headCardView($, e, row)
    } catch {
      return row
    }
  })

  on('ui.render', { component: 'Pane', requestId: HEADS_PANE }, ($, e) => headsPaneView($, e, defaultEngine))

  on('command.run', { command: USAGE_COMMAND }, async $ => {
    await refreshHeads($)
    await $.ui.open({ id: PANE, title: 'Usage' })

    return { text: 'Usage pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => usagePaneView($, e, { defaultEngine, fiveHourUsd, weeklyUsd, plan }))
}
