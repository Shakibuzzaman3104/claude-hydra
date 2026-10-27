/**
 * @author Shakib
 * @since 06/10/26
 */
import type { Register } from 'claude-code'

import { sweepAgyHomes } from './engines/agy'
import { sweepBuddySettings } from './engines/codebuddy'
import { sweepCodexTemps } from './engines/codex'
import { writeRules } from './engines/commandcode'
import { runHead } from './engines/index'
import { sweepOpenCodeFiles } from './engines/opencode'
import { coolingLines, isStrategy, parseAccountsArgs, runAccountsCommand, setAccountStrategy } from './lib/accounts'
import { EFFORTS, EFFORT_MODES, HEAD_EFFORTS, effortModeOf, isEffortMode, isHeadEffort } from './lib/effort'
import type { EffortMode } from './lib/effort'
import { AUTO, DEFAULT_ENGINE, ENGINES, ENGINE_LABEL, engineLabel, engineOf, headModelFor, isAuto, isEngine, isModelFor, parseEngineList, poolOf, resolveHeadEngine } from './lib/engines'
import type { Engine } from './lib/engines'
import { REPORT_HEAD, headName, isLive, listRuns, reportContext, reportNotice, stopRuns, strings } from './lib/format'
import { planOnboarding, setupCard, takeWelcome, onlyReadyNote } from './lib/onboarding'
import { HYDRA_HELP, HYDRA_POLICY, NO_CHECK_CONSENT, NO_CONSENT, ROUTES, STATUSLINE_HELP, parseHydraArgs } from './lib/policy'
import { backgroundJobs, controllers, createReplyBox, hasCheckConsent, hasConsent, hasConsentAll, needsEngineCheck, pendingPrompts, preflight, preflightText, readyEngines, refreshHeads, refreshStatus, resolveWriteDirs, setConfiguredEngine, stopHeadsNow, storeLead, sweepStatusFiles, usedNames, waitForResult } from './lib/runtime'
import type { HeadResult } from './lib/runtime'
import { setExtraHomeRead } from './lib/safety'
import { readMode, readRuns, updateMode, updateRuns, updateTick } from './lib/state'
import { bandView, headsPaneView, usagePaneView } from './lib/views'

export * from './lib/accounts'
export * from './lib/checks'
export * from './lib/effort'
export * from './lib/engines'
export * from './lib/format'
export * from './lib/onboarding'
export * from './lib/policy'
export * from './lib/runtime'
export * from './lib/safety'
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

const PANE = 'hydra-usage'
const HEADS_PANE = 'hydra-heads'

const REFRESH_MS = 120_000

let isWorkerRunning = false

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
  setConfiguredEngine(defaultEngine)
  setAccountStrategy(isStrategy(options.accountStrategy) ? options.accountStrategy : 'fill')
  setExtraHomeRead([String(options.headReadDirs ?? '')])
  const limits = { fiveHourUsd, weeklyUsd }

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
          void runHead($, job.input, job.headModel, controller.signal, limits, job.id, job.engine, job.routing)
            .catch(async error => {
              const reason = `failed before it reported: ${String(error).slice(0, 300)}`
              const now = await $.clock.now()
              await updateRuns($, list => stopRuns(list, [job.id], reason, now))
              await refreshStatus($, limits)
              return { text: `Hydra Head ${job.id} ${reason}`, isDone: false }
            })
            .then(async result => {
              if (!job.reply?.(result)) await $.prompt.submit({ text: `Hydra Head ${job.id} finished.\n${result.text}` })
            })
            .finally(() => controllers.delete(job.id))
        }
      })()
    }
    await $.command.register({ name: USAGE_COMMAND, description: 'Hydra: Claude and Head usage limits', immediate: true })
    await $.command.register({ name: 'heads', description: 'Hydra: watch the Heads work, live (opens without interrupting Claude)', immediate: true })
    await $.command.register({
      name: 'hydra',
      description: 'Turn on Hydra: Claude leads, Heads (Command Code, CodeBuddy, Codex, Antigravity, WorkBuddy or OpenCode agents) implement',
      argumentHint: '[task] [effort=<level>] [head=<model>] [engine=<name>] | off | status | help | accounts',
    })
    await $.tool.register({
      name: 'head',
      description: 'Hydra: run one Head (a cheaper coding agent on Command Code, CodeBuddy, Codex, Antigravity, WorkBuddy or OpenCode, per the person\'s engine setting) headlessly on a self-contained implementation task. Returns its report, cost, the files it edited and any denied calls; with background: true it returns at once and the report arrives as a message. Usable only while the person has Hydra on.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Self-contained spec: goal, exact files, constraints, acceptance check' },
          cwd: { type: 'string', description: 'Repo directory to work in; defaults to the session root' },
          engine: { type: 'string', enum: [...ENGINES], description: 'The engine this Head runs on. Required in auto mode; in a fixed-engine session it defaults to that engine, and naming another ready one sends just this Head there. Pick by the task: see the routing guide in the Hydra policy. If the engine is at its usage limit or signed out, Hydra moves the Head to another model or engine on its own, and the report says where it ran.' },
          model: { type: 'string', description: 'Head model id (CodeBuddy, WorkBuddy and Codex ids have no provider prefix; OpenCode takes provider/model); defaults to the Hydra head model. On Codex: gpt-6.1-terra (default) for coding, including hard or multi-file work, gpt-6.1-sol for work that is not code, gpt-6-luna for mechanical or small tasks. On CodeBuddy and WorkBuddy: deepseek-v4.1-flash, glm-5.3, kimi-k3, minimax-m3.1-flash, gpt-5.6-terra and the others `codebuddy --help` lists; each model has its own usage limit. On Antigravity: gemini-3.8-flash (default, bulk), gemini-4-argon (research and search) or claude-sonnet-5-5 (normal work), claude-opus-5-5 (hard work), gpt-oss-120b (simple edits, retiring 2 November 2026); Claude + GPT-OSS, Gemini and Argon draw on separate usage limits. On OpenCode: opencode/deepseek-v4.1-flash-free (free) or any provider/model the person set up.' },
          maxTurns: { type: 'number', description: 'Turn cap for the Head (default 60)' },
          addDirs: { type: 'array', items: { type: 'string' }, description: 'Absolute folders outside cwd the Head must read (mockups, briefs, other repos)' },
          writeDirs: { type: 'array', items: { type: 'string' }, description: 'Absolute folders outside cwd the Head may also write to, such as the real location of a symlinked package. Only folders the task must change: never /, the home folder or a folder above the project. Their .git, .commandcode and .env files stay protected.' },
          shell: { type: 'boolean', description: 'Give the Head a shell (off by default). Dangerous commands stay denied: destructive git, rm -r/-f, sudo, network tools, builds and installs. OpenCode Heads never get one.' },
          name: { type: 'string', description: 'Short name to track this Head by, saying what it works on (e.g. prefs-utils, login-tests); lowercase letters, digits and dashes, up to 20. Defaults to one made from the task; made unique with -2, -3.' },
          effort: { type: 'string', enum: [...HEAD_EFFORTS], description: 'Reasoning effort for this Head (default low). Use low when you will check the result, one level up on each retry after a failed check, max first only for subtle work you cannot check. Ignored while the person has fixed a level with /hydra effort=<level>.' },
          maxMinutes: { type: 'number', description: 'Wall-clock limit before the Head is stopped (default 40)' },
          check: { type: 'string', description: 'Acceptance check: a shell command Hydra runs in cwd once the Head finishes (e.g. ./gradlew testDebugUnitTest --tests LoginViewModelTest). It runs as the person, outside the Head\'s lockdown. On a failure the Head is sent back with the output, one effort level up, at most twice. Scope it to what this Head changes: Heads running in the same cwd share the files. The person is asked once before the first check runs.' },
          checkMinutes: { type: 'number', description: 'Time limit for one run of the check, in minutes (default and maximum 10)' },
          background: { type: 'boolean', description: 'Return at once; the report arrives later as a message. Use for parallel fan-out.' },
        },
        required: ['task'],
      },
    })
    await $.tool.register({
      name: 'control',
      description: 'Hydra control for the Lead: list the Heads (with their state, turns, time and what they are doing), stop a stuck or wrong Head by id or all of them, clear finished ones from the views, or turn Hydra on/off and set the Head effort, model or engine.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'stop', 'clear', 'on', 'off', 'effort'], description: 'What to do (default list)' },
          id: { type: 'string', description: 'For stop: the Head name (e.g. prefs-utils), or all; default all' },
          effort: { type: 'string', enum: [...EFFORT_MODES], description: 'For on/effort: auto or a fixed level' },
          headModel: { type: 'string', description: 'For on/effort: the model the Heads run on' },
          engine: { type: 'string', enum: [...ENGINES, AUTO], description: 'For on/effort: the CLI Heads run on: commandcode, codebuddy, codex, agy, workbuddy or opencode (beta), or auto to let you pick one per Head' },
          engines: { type: 'array', items: { type: 'string', enum: [...ENGINES] }, description: 'For on/effort with engine auto: the engines you may use (default: all that are ready)' },
        },
      },
    })
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
    const usage = await $.session.usage()
    await storeLead($, usage.rateLimits, limits)
    void refreshHeads($, limits)
    $.clock.every(REFRESH_MS, () => void refreshHeads($, limits))
    // The views' clock: stamps the time once a second while some Head is live, and once more after the last one goes quiet.
    let wasLive = false
    $.clock.every(1_000, () => void (async () => {
      const now = await $.clock.now()
      const isAnyLive = (await readRuns($)).some(run => isLive(run, now))
      if (isAnyLive || wasLive) await updateTick($, () => now)
      wasLive = isAnyLive
    })())

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await storeLead($, e.rateLimits, limits)

    return next(e)
  })

  on('command.run', { command: 'hydra' }, async ($, e) => {
    const { action, leadModel, headModel, effort, engine, engines, task, unknown } = parseHydraArgs(e.args)
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
      return { text: current.isOn ? `🐉 Hydra on · Lead ${model} · Head ${current.headModel} on ${engineLabel(current, defaultEngine)} · effort ${currentEffort}` : 'Hydra is off. Turn it on with /hydra.' }
    }
    if (action === 'off') {
      await updateMode($, () => ({ ...current, isOn: false }))
      $.ui.invalidate('tool.describe')
      await refreshStatus($, limits)
      return { text: 'Hydra off. Claude works alone again.' }
    }

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
      const nextAuto = { isOn: true, headModel: headModel ?? (isModelFor('commandcode', current.headModel) ? current.headModel : defaultHead), effort: effort ?? currentEffort, engine: AUTO, engines: ready.pool, pinned: engines !== undefined || (keepsAuto && stored?.pinned === true) }
      await updateMode($, () => nextAuto)
      $.ui.invalidate('tool.describe')
      await refreshStatus($, limits)
      const autoModel = await $.session.model()
      const autoHint = leadModel && !autoModel.toLowerCase().includes(leadModel) ? ` Run /model ${leadModel} to switch the Lead.` : ''
      const left = plannedPool ? '' : ready.skipped.map(item => `\n⚠ ${ENGINE_LABEL[item.engine]} left out: ${item.problem}`).join('')
      const autoEffort = nextAuto.effort === 'auto' ? 'effort auto (Lead picks low to max)' : `effort ${nextAuto.effort}`
      const autoText = `🐉 Hydra on · Lead ${autoModel} · Heads on ${engineLabel(nextAuto, defaultEngine)}, Claude picks the engine per Head · ${autoEffort}. /heads to watch, /hydra engines for what each is for, /hydra off to stop.${autoHint}${left}${ready.warnings.map(warning => `\n⚠ ${warning}`).join('')}${await takeWelcome($)}`
      if (task) {
        if (isWorkerRunning) pendingPrompts.push(task)
        else return { text: autoText, context: [task] }
      }
      return { text: autoText }
    }
    const nextEngine = (engine ?? plannedEngine ?? currentEngine) as Engine
    const next = { isOn: true, headModel: headModelFor(nextEngine, headModel, current.headModel, defaultHead), effort: effort ?? currentEffort, engine: nextEngine, pinned: engine !== undefined || (keepsStored && stored?.pinned === true && nextEngine === currentEngine) }
    const check = planned ? { problems: [] as string[], warnings: planned.warnings } : await preflight($, next.engine as Engine)
    if (check.problems.length > 0) return { text: preflightText(check) }
    if (!(await hasConsent($, next.headModel, true, next.engine as Engine))) return { text: 'Hydra stays off. Run /hydra when you want Heads to work for Claude.' }
    await updateMode($, () => next)
    $.ui.invalidate('tool.describe')
    await refreshStatus($, limits)
    const model = await $.session.model()
    const switchHint = leadModel && !model.toLowerCase().includes(leadModel) ? ` Run /model ${leadModel} to switch the Lead.` : ''
    const changed = current.isOn && next.effort !== currentEffort ? ' Running Heads switch at their next round.' : ''
    const effortText = next.effort === 'auto' ? 'effort auto (Lead picks low to max)' : `effort ${next.effort}`
    const warnings = check.warnings.map(warning => `\n⚠ ${warning}`).join('')
    const only = planned?.plan.kind === 'fixed' && planned.plan.isFallback ? `\n${onlyReadyNote(nextEngine)}` : ''
    const text = `🐉 Hydra on · Lead ${model} · Head ${next.headModel} on ${ENGINE_LABEL[nextEngine]} · ${effortText}. /heads to watch, /hydra off to stop.${changed}${switchHint}${warnings}${only}${await takeWelcome($)}`

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
    if (origin.kind !== 'plugin' || origin.name !== 'hydra' || e.command || !REPORT_HEAD.test(e.text)) return next(e)

    return next({ ...e, text: reportNotice(e.text), context: [...(e.context ?? []), reportContext(e.text)] })
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const hydra = await readMode($)
    if (!hydra?.isOn) return composed

    const policy = { id: 'hydra:policy', text: HYDRA_POLICY(hydra.headModel, effortModeOf(hydra), isAuto(hydra) ? AUTO : engineOf(hydra, defaultEngine), poolOf(hydra), { fallback: isFallbackOn, pinned: hydra.pinned === true }), scope: 'session' as const }
    const cooling = await coolingLines($, isAuto(hydra) && hydra.pinned ? poolOf(hydra) : ENGINES).catch(() => [])
    const limited = cooling.length > 0 ? [{ id: 'hydra:limits', text: `- Usage limits in force now (Hydra moves a Head off these on its own; route new work elsewhere): ${cooling.join('; ')}.`, scope: 'session' as const }] : []

    return { sections: [...composed.sections, policy, ...limited] }
  })

  on('tool.describe', { tool: HEAD_TOOL }, async ($, e, next) => {
    const described = await next(e)

    return { ...described, isDeferred: !(await readMode($))?.isOn }
  })

  on('tool.call', { tool: HEAD_TOOL }, async ($, e, next) => {
    const hydra = await readMode($)
    if (!hydra?.isOn) return { deny: 'Hydra is off. The person turns it on with /hydra.' }
    if (!String(e.task ?? '').trim()) return { deny: 'A Head needs a task.' }
    if (e.effort !== undefined && !isHeadEffort(e.effort)) return { deny: 'effort must be low, medium, high, xhigh or max.' }
    const cwd = typeof e.cwd === 'string' && e.cwd ? e.cwd : await $.session.root()
    const writable = await resolveWriteDirs($, cwd, strings(e.writeDirs))
    if ('refusal' in writable) return { deny: writable.refusal }
    const routed = resolveHeadEngine(hydra, e.engine, defaultEngine)
    if ('deny' in routed) return { deny: routed.deny }
    const engine = routed.engine
    if (routed.isNew) {
      const ready = await preflight($, engine)
      if (ready.problems.length > 0) return { deny: `${ENGINE_LABEL[engine]} is not ready here: ${ready.problems[0]} Pick another engine.` }
    }
    if (!(await hasConsent($, hydra.headModel, false, engine))) return { deny: NO_CONSENT }
    if (routed.isNew && isAuto(hydra)) await updateMode($, mode => (mode ? { ...mode, engines: [...poolOf(mode), engine] } : mode))
    const check = typeof e.check === 'string' ? e.check.trim() : ''
    if (check && !(await hasCheckConsent($, check))) return { deny: NO_CHECK_CONSENT }
    const headModel = headModelFor(engine, undefined, hydra.headModel, defaultHead)
    const asked = typeof e.model === 'string' && e.model ? e.model : undefined
    const input = { ...e, writeDirs: writable.dirs, ...(asked && !isModelFor(engine, asked) ? { model: undefined } : {}) }
    const routing = { headModel: hydra.headModel, configured: defaultHead, model: asked, pool: isAuto(hydra) && hydra.pinned ? poolOf(hydra) : undefined, fallback: isFallbackOn }
    const taken = new Set([...usedNames, ...(await readRuns($)).map(run => run.id)])
    const id = headName(e.name, String(e.task ?? ''), taken)
    usedNames.add(id)
    if (e.background === true) {
      if (!isWorkerRunning) return { deny: 'Hydra is still starting in this session. Try again in a moment, or run this Head without background.' }
      backgroundJobs.push({ input, headModel, id, engine, routing })

      return { result: `Head ${id} started in the background on ${headModel} (${ENGINE_LABEL[engine]}). Its report arrives as a message from the hydra plugin when it finishes.` }
    }
    if (!isWorkerRunning) {
      const { text } = await runHead($, input, headModel, next.signal, limits, id, engine, routing)

      return { result: text }
    }
    // Run on the worker's long-lived `$`, so a cancelled call stops the Head cleanly instead of stranding it as running.
    // The hook waits through `$` calls: a hook's own time is capped at 10 s, and a `$` call in flight does not count.
    const { box, reply } = createReplyBox<HeadResult>(next.signal)
    backgroundJobs.push({ input, headModel, id, engine, routing, reply })
    const result = await waitForResult(box, next.signal, () => $.process.run(['/bin/sleep', '1'], { timeoutMs: 5_000 }).then(() => undefined))

    return { result: result?.text ?? `Head ${id} keeps running in the background after the call was interrupted; its report arrives as a message from the hydra plugin. Stop it with ${CONTROL_TOOL} if it is no longer wanted.` }
  }).catch(($, e, next) => ({ deny: `Hydra: the Head could not run (${next.error.message ?? next.error.kind}). Run /hydra to check the setup.` }))

  on('tool.describe', { tool: CONTROL_TOOL }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  on('tool.call', { tool: CONTROL_TOOL }, async ($, e) => {
    const action = String(e.action ?? 'list')
    const now = await $.clock.now()
    const ids = typeof e.id === 'string' && e.id && e.id !== 'all' ? [e.id] : ('all' as const)
    if (action === 'list') {
      const hydra = await readMode($)
      const head = hydra?.isOn ? `Hydra on · Head ${hydra.headModel} on ${engineLabel(hydra, defaultEngine)} · effort ${effortModeOf(hydra)}` : 'Hydra off'

      return { result: `${head}\n${listRuns(await readRuns($), now, id => controllers.has(id))}` }
    }
    if (action === 'stop') {
      const list = await readRuns($)
      const targets = list.filter(run => (run.state === 'running' || run.state === 'queued') && (ids === 'all' || ids.includes(run.id)))
      if (targets.length === 0) return { result: `No running or queued Head${ids === 'all' ? '' : ` ${ids[0]}`}.` }
      const ghosts = await stopHeadsNow($, targets.map(run => run.id), 'stopped by the Lead', limits)

      return { result: `Stopping ${targets.map(run => run.id).join(', ')}.${ghosts.length > 0 ? ` ${ghosts.join(', ')} had no live process and were marked failed.` : ''}` }
    }
    if (action === 'clear') {
      await updateRuns($, list => list.filter(run => run.state === 'running' || run.state === 'queued'))

      return { result: 'Cleared finished and failed Heads from the views.' }
    }
    const stored = await readMode($)
    const current = stored ?? { isOn: false, headModel: defaultHead, effort: defaultEffort, engine: defaultEngine }
    if (action === 'off') {
      await updateMode($, () => ({ ...current, isOn: false }))
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
      await updateMode($, () => ({ isOn: action === 'on' ? true : current.isOn, headModel, effort: effort ?? effortModeOf(stored), engine: AUTO, engines: pool, pinned: listed === undefined && stored?.pinned === true }))
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
      await updateMode($, () => ({ isOn: action === 'on' ? true : current.isOn, headModel, effort: effort ?? effortModeOf(stored), engine, pinned: e.engine === undefined && stored?.pinned === true }))
    } else {
      return { deny: `Unknown action "${action}". Use list, stop, clear, on, off or effort.` }
    }
    $.ui.invalidate('tool.describe')
    await refreshStatus($, limits)
    const hydra = await readMode($)

    return { result: hydra?.isOn ? `Hydra on · Head ${hydra.headModel} on ${engineLabel(hydra, defaultEngine)} · effort ${effortModeOf(hydra)}` : 'Hydra off.' }
  }).catch(($, e, next) => ({ deny: `Hydra control failed (${next.error.message ?? next.error.kind}).` }))

  on('command.run', { command: 'heads' }, async $ => {
    await $.ui.open({ id: HEADS_PANE, title: 'Heads' })

    return { text: 'Heads pane opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    return (await bandView($, e)) ?? next(e)
  })

  on('ui.render', { component: 'Pane', requestId: HEADS_PANE }, ($, e) => headsPaneView($, e, defaultEngine, limits))

  on('command.run', { command: USAGE_COMMAND }, async $ => {
    await refreshHeads($, limits)
    await $.ui.open({ id: PANE, title: 'Usage' })

    return { text: 'Usage pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => usagePaneView($, e, { defaultEngine, fiveHourUsd, weeklyUsd, plan }))
}
