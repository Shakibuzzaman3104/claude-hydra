/**
 * @author Shakib
 * @since 06/10/26
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HeadRun, HeadsUsage, HydraMode, LeadWindow } from '../types'

const PANE = 'hydra-usage'
const HEAD_TOOL = 'mcp__hydra__head'
const REFRESH_MS = 120_000
const WARN_AT = 90
const LEADS = ['fable', 'opus', 'sonnet'] as const

const lead = atom({ plugin: 'hydra', key: 'lead' } as const, [])
const heads = atom({ plugin: 'hydra', key: 'heads' } as const, null)
const warned = atom({ plugin: 'hydra', key: 'warned' } as const, [])
const mode = atom({ plugin: 'hydra', key: 'mode' } as const, null)
const runs = atom({ plugin: 'hydra', key: 'runs' } as const, [])

const LEAD_LABELS: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: 'Weekly · all models',
  seven_day_opus: 'Weekly · Opus',
  seven_day_sonnet: 'Weekly · Sonnet',
  seven_day_fable: 'Weekly · Fable',
}

export const HYDRA_POLICY = (headModel: string) => `# Hydra mode (on)
You are the Lead. Implementation goes to Heads: Command Code agents on ${headModel}, called through the ${HEAD_TOOL} tool.
- Plan first: split the work into self-contained tasks. Each Head task states the goal, the exact files, the constraints and the acceptance check; a Head sees only the repo and your task text.
- Heads edit files inside \`cwd\` and nothing else. Folders outside it they must read (mockups, briefs, other repos) go in \`addDirs\`. They can run only read-only shell commands plus the patterns you list in \`allowShell\` (e.g. "xcrun swiftc -parse *"); everything else is denied, never prompted.
- Independent tasks on disjoint files go out as parallel ${HEAD_TOOL} calls with \`background: true\`: each returns at once and its report arrives later as a message from the hydra plugin. Dependent tasks run in sequence.
- Keep the judgement-heavy part yourself: architecture, tricky bugs, anything under ~20 lines.
- Never trust a Head's report. Read the diff and run the build/tests yourself, then fix it or send the Head back with precise feedback. A report lists the files the Head edited and every call that was denied.
- End with what each Head did, what you verified, and the Heads' total cost.`

export const parseHydraArgs = (args: string) => {
  const words = args.trim().split(/\s+/).filter(Boolean)
  let action: 'on' | 'off' | 'status' = 'on'
  let leadModel: string | undefined
  let headModel: string | undefined
  const rest: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    const lower = word.toLowerCase()
    if (i === 0 && (lower === 'off' || lower === 'status')) action = lower
    else if (rest.length === 0 && !leadModel && (LEADS as readonly string[]).includes(lower)) leadModel = lower
    else if (rest.length === 0 && lower.startsWith('head=')) headModel = word.slice(5)
    else if (rest.length === 0 && lower === '--head' && words[i + 1]) headModel = words[++i]
    else rest.push(word)
  }
  return { action, leadModel, headModel, task: rest.join(' ') }
}

export const leadLabel = (kind: string) =>
  LEAD_LABELS[kind] ?? kind.replace(/^seven_day_?/, 'Weekly · ').replace(/_/g, ' ')

export const resetsIn = (iso: string | null | undefined, now: number) => {
  if (!iso) return ''
  const minutes = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days > 0) return `Resets in ${days} d ${hours} hr`
  return hours > 0 ? `Resets in ${hours} hr ${rest} min` : `Resets in ${rest} min`
}

export const barOf = (percent: number, width: number) => {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const colorOf = (percent: number) => (percent >= WARN_AT ? 'red' : percent >= 75 ? 'yellow' : 'blue')

const percentOf = (usd: number, limit: number) => (limit > 0 ? Math.round((usd / limit) * 1000) / 10 : 0)

const shortModel = (model: string) => model.split('/').pop() ?? model

export const statusLine = (
  windows: LeadWindow[],
  usage: HeadsUsage | null,
  fiveHourUsd: number,
  hydra: HydraMode | null = null,
  running = 0,
  turns = 0,
) => {
  const parts: string[] = []
  const short = (kind: string) => (kind === 'five_hour' ? '5h' : kind === 'seven_day' ? 'wk' : kind.replace('seven_day_', 'wk·'))
  if (hydra?.isOn) parts.push(`🐉 Hydra · ${shortModel(hydra.headModel)}${running > 0 ? ` · ${running} running · ${turns} turns` : ''}`)
  if (windows.length > 0) parts.push(`Lead ${windows.map(w => `${short(w.kind)} ${Math.round(w.percentUsed)}%`).join(' ')}`)
  if (usage && !usage.error) parts.push(`Heads 5h $${usage.fiveHour.usd.toFixed(2)}/$${fiveHourUsd}`)
  return parts.length > 0 ? parts.join(' │ ') : undefined
}

async function refreshStatus($: EngineInterface, fiveHourUsd: number) {
  const live = (await read($, runs)).filter(run => run.state === 'running')
  const turns = live.reduce((sum, run) => sum + run.turns, 0)
  $.ui.status(statusLine(await read($, lead), await read($, heads), fiveHourUsd, await read($, mode), live.length, turns))
}

async function refreshHeads($: EngineInterface, fiveHourUsd: number) {
  try {
    const ran = await $.process.run(['/usr/bin/env', 'python3', '-I', `${$.plugin.root}/bin/cc-usage.py`], { timeoutMs: 20_000 })
    const usage = JSON.parse(ran.stdout) as HeadsUsage
    await update($, heads, () => usage)
  } catch (error) {
    const measuredAt = await $.clock.now()
    await update($, heads, () => ({
      fiveHour: { usd: 0, resetsAt: null },
      weekly: { usd: 0, resetsAt: null },
      measuredAt,
      error: String(error).slice(0, 120),
    }))
  }
  await refreshStatus($, fiveHourUsd)
}

async function storeLead($: EngineInterface, windows: readonly LeadWindow[], fiveHourUsd: number) {
  await update($, lead, () => windows.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt })))
  for (const w of windows) {
    const mark = `${w.kind}@${w.resetsAt ?? ''}`
    if (w.percentUsed < WARN_AT || (await read($, warned)).includes(mark)) continue
    await update($, warned, list => [...list, mark].slice(-20))
    $.ui.toast(`Claude ${leadLabel(w.kind)} at ${Math.round(w.percentUsed)}% · ${resetsIn(w.resetsAt, await $.clock.now())}`)
  }
  await refreshStatus($, fiveHourUsd)
}

async function setRun($: EngineInterface, id: string, change: Partial<HeadRun>) {
  await update($, runs, list => list.map(run => (run.id === id ? { ...run, ...change } : run)))
}

type SessionReport = { usd: number | null; files: string[]; denied: { tool: string; target: string; text: string }[]; toolCalls: number }

async function sessionReport($: EngineInterface, sessionId: string): Promise<SessionReport> {
  try {
    const ran = await $.process.run(['/usr/bin/env', 'python3', '-I', `${$.plugin.root}/bin/cc-usage.py`, '--report', sessionId])
    return JSON.parse(ran.stdout) as SessionReport
  } catch {
    return { usd: null, files: [], denied: [], toolCalls: 0 }
  }
}

export const DONE_MARK = 'HEAD DONE'
const MAX_ROUNDS = 8
const MAX_PARALLEL = 6
const DEFAULT_MINUTES = 40
const START_RETRIES = 2
const RULES_FILE = '.commandcode/settings.local.json'
const OWNER = 'hydra'

export const HEAD_RULES = `

Rules for this run: never answer with text alone until the whole task is finished. Every reply before then must make a tool call. A denied tool call stays denied: do not retry it, work around it or name it as a blocker. When everything is done, end your final message with a short report and the line ${DONE_MARK}.`

export const continuePrompt = (denied: string[]) =>
  [
    'Continue the task from where you stopped. Do not describe what you will do next: make the tool calls.',
    denied.length > 0 ? `These calls were denied and will stay denied, so do not retry them: ${denied.join('; ')}.` : '',
    `When every item is done, end with your report and the line ${DONE_MARK}.`,
  ].filter(Boolean).join(' ')

export const isFinished = (text: string) => text.includes(DONE_MARK)

/** 0 is a clean stop, 8 a turn-cap hit, 9 an empty model reply: all three can pick up where they left off. */
export const isResumable = (code: number | null) => code === 0 || code === 8 || code === 9

export const DEFAULT_DENY = [
  'Edit(/.git/**)',
  'Edit(/.commandcode/**)',
  'Shell(git commit*)',
  'Shell(git push*)',
  'Shell(git reset*)',
  'Shell(git checkout*)',
  'Shell(git switch*)',
  'Shell(git restore*)',
  'Shell(git stash*)',
  'Shell(git clean*)',
  'Shell(git rebase*)',
  'Shell(git merge*)',
  'Shell(rm -r*)',
  'Shell(rm -f*)',
  'Shell(sudo*)',
]

type Permissions = { allow?: string[]; deny?: string[]; additionalDirectories?: string[] }
type HeadSettings = { managedBy?: string; permissions?: Permissions }

const union = (a: readonly string[] = [], b: readonly string[] = []) => [...new Set([...a, ...b])]

/** Hydra's own rules for a headless run: edits inside the project, the listed shell patterns, the extra read folders. */
export const headSettings = (existing: HeadSettings | null, addDirs: readonly string[], allowShell: readonly string[]): HeadSettings => {
  const before = existing?.permissions ?? {}
  return {
    managedBy: OWNER,
    permissions: {
      allow: union(before.allow, ['Edit(/**)', ...allowShell.map(pattern => `Shell(${pattern})`)]),
      deny: union(before.deny, DEFAULT_DENY),
      additionalDirectories: union(before.additionalDirectories, addDirs),
    },
  }
}

/** Writes the rules into the project's personal settings file, never into one the person wrote themselves. */
async function prepareRules($: EngineInterface, cwd: string, addDirs: readonly string[], allowShell: readonly string[]) {
  const path = `${cwd.replace(/\/$/, '')}/${RULES_FILE}`
  let existing: HeadSettings | null = null
  if (await $.fs.exists(path)) {
    try {
      existing = JSON.parse(await $.fs.read(path)) as HeadSettings
    } catch {
      return `${RULES_FILE} could not be read, so Hydra's rules were not applied; edits will be denied`
    }
    if (existing.managedBy !== OWNER) return `${RULES_FILE} belongs to the person, so Hydra's rules were not applied; edits may be denied`
  }
  await $.fs.write(path, JSON.stringify(headSettings(existing, addDirs, allowShell), null, 2) + '\n')
  const exclude = await $.process.run(['git', '-C', cwd, 'rev-parse', '--git-path', 'info/exclude']).catch(() => null)
  if (exclude?.exitCode === 0) {
    const file = exclude.stdout.trim()
    const excludePath = file.startsWith('/') ? file : `${cwd.replace(/\/$/, '')}/${file}`
    const current = (await $.fs.exists(excludePath)) ? await $.fs.read(excludePath) : ''
    if (!current.split('\n').includes(RULES_FILE)) await $.fs.write(excludePath, `${current.replace(/\n?$/, '\n')}${RULES_FILE}\n`)
  }
  return undefined
}

/** A FIFO gate so a fan-out never starts more Heads at once than the provider and the machine take. */
export const createGate = (limit: number) => {
  let active = 0
  const waiting: (() => void)[] = []
  return {
    get active() { return active },
    get waiting() { return waiting.length },
    async enter() {
      if (active < limit) {
        active++
        return
      }
      await new Promise<void>(resolve => waiting.push(resolve))
    },
    leave() {
      const nextInLine = waiting.shift()
      if (nextInLine) nextInLine()
      else active = Math.max(0, active - 1)
    },
  }
}

const gate = createGate(MAX_PARALLEL)

type Round = { finalText: string; sessionId?: string; subtype?: string; code: number | null; signal?: string; errors: string }

async function runRound(
  $: EngineInterface,
  argv: { prompt: string; model: string; maxTurns: number; resume?: string; cwd: string; addDirs: readonly string[] },
  signal: AbortSignal,
  onTurn: () => Promise<void>,
): Promise<Round> {
  const args = ['/usr/bin/env', 'commandcode', '-p', argv.prompt, '-m', argv.model, '--max-turns', String(argv.maxTurns),
    '--output-format', 'json', '--skip-onboarding', '--permission-mode', 'dont-ask', '--trust']
  for (const dir of argv.addDirs) args.push('--add-dir', dir)
  if (argv.resume) args.push('--resume', argv.resume)
  const child = $.process.spawn({ argv: args, cwd: argv.cwd })
  let pending = ''
  let errors = ''
  let result: Record<string, unknown> | null = null
  const take = async (line: string) => {
    if (!line.trim().startsWith('{')) return
    try {
      const row = JSON.parse(line) as { type?: string; event?: { type?: string } }
      if (row.type === 'result') result = row as Record<string, unknown>
      if (row.event?.type === 'turn_end') await onTurn()
    } catch {
      // A partial or non-JSON line from the CLI; the final result line is what counts.
    }
  }
  for await (const { stream, text } of child) {
    if (signal.aborted) break
    if (stream === 'stderr') {
      errors = (errors + text).slice(-2000)
      continue
    }
    const lines = (pending + text).split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) await take(line)
  }
  await take(pending)
  const exit = signal.aborted ? { code: null, signal: 'aborted' } : await child.result.catch(() => ({ code: null, signal: 'lost' }))
  const final = result as Record<string, unknown> | null
  return {
    finalText: String(final?.finalText ?? ''),
    sessionId: typeof final?.sessionId === 'string' ? final.sessionId : undefined,
    subtype: typeof final?.subtype === 'string' ? final.subtype : undefined,
    code: exit.code ?? null,
    signal: 'signal' in exit ? String(exit.signal ?? '') : undefined,
    errors,
  }
}

const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [])

export const relativeTo = (cwd: string, path: string) => {
  const root = cwd.replace(/\/$/, '') + '/'
  return path.startsWith(root) ? path.slice(root.length) : path
}

export const formatReport = (head: {
  id: string; model: string; cwd: string; sessionId?: string; finished: boolean; rounds: number; turns: number;
  usd: number | null; files: string[]; denied: SessionReport['denied']; finalText: string; exit: string; rulesNote?: string; errors?: string
}) => {
  const lines = [
    `head ${head.id} · ${head.model} · ${head.finished ? 'finished' : 'NOT finished'} · exit ${head.exit} · ${head.rounds} round(s) · ${head.turns} turns · $${(head.usd ?? 0).toFixed(4)}`,
    `session ${head.sessionId ?? 'none'} (commandcode --resume ${head.sessionId ?? '<id>'}) · cwd ${head.cwd}`,
  ]
  if (head.rulesNote) lines.push(`rules: ${head.rulesNote}`)
  lines.push(head.files.length > 0 ? `edited (${head.files.length}): ${head.files.map(file => relativeTo(head.cwd, file)).join(', ')}` : 'edited: nothing')
  if (head.denied.length > 0) {
    lines.push(`denied (${head.denied.length}):`, ...head.denied.map(d => `  - ${d.tool} ${relativeTo(head.cwd, d.target)}: ${d.text.slice(0, 140)}`))
  }
  lines.push('--- head report ---', (head.finalText || '(no final report)').trim().slice(-8000))
  if (!head.finished && head.errors?.trim()) lines.push('--- stderr ---', head.errors.trim())
  return lines.join('\n')
}

async function runHead($: EngineInterface, input: Record<string, unknown>, headModel: string, signal: AbortSignal, fiveHourUsd: number, id: string) {
  const task = String(input.task ?? '').trim()
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : await $.session.root()
  const model = typeof input.model === 'string' && input.model ? input.model : headModel
  const maxTurns = Number(input.maxTurns ?? 60)
  const addDirs = strings(input.addDirs)
  const allowShell = strings(input.allowShell)
  const minutes = Number(input.maxMinutes ?? DEFAULT_MINUTES)

  await update($, runs, list => [...list, { id, task: task.slice(0, 80), model, state: 'running' as const, turns: 0 }].slice(-12))
  await refreshStatus($, fiveHourUsd)
  await gate.enter()
  try {
    return await runHeadInside($, { task, cwd, model, maxTurns, addDirs, allowShell, minutes }, signal, fiveHourUsd, id)
  } finally {
    gate.leave()
  }
}

async function runHeadInside(
  $: EngineInterface,
  head: { task: string; cwd: string; model: string; maxTurns: number; addDirs: string[]; allowShell: string[]; minutes: number },
  outer: AbortSignal,
  fiveHourUsd: number,
  id: string,
) {
  const { task, cwd, model, maxTurns, addDirs, allowShell, minutes } = head
  const controller = new AbortController()
  outer.addEventListener('abort', () => controller.abort(), { once: true })
  let timedOut = false
  const timerStop = new AbortController()
  void $.clock.sleep(minutes * 60_000, { signal: timerStop.signal }).then(
    () => {
      timedOut = true
      controller.abort()
    },
    () => undefined,
  )
  const signal = controller.signal

  const rulesNote = await prepareRules($, cwd, addDirs, allowShell).catch(error => `rules not written: ${String(error).slice(0, 120)}`)

  let turns = 0
  const onTurn = async () => {
    turns++
    await setRun($, id, { turns })
    await refreshStatus($, fiveHourUsd)
  }

  let round = await runRound($, { prompt: task + HEAD_RULES, model, maxTurns, cwd, addDirs }, signal, onTurn)
  for (let attempt = 1; !round.sessionId && !signal.aborted && attempt <= START_RETRIES; attempt++) {
    await $.clock.sleep(attempt * 5_000, { signal }).catch(() => undefined)
    round = await runRound($, { prompt: task + HEAD_RULES, model, maxTurns, cwd, addDirs }, signal, onTurn)
  }
  const sessionId = round.sessionId
  let rounds = 1
  while (!signal.aborted && sessionId && isResumable(round.code) && !isFinished(round.finalText) && rounds < MAX_ROUNDS && turns < maxTurns) {
    const so_far = await sessionReport($, sessionId)
    const denied = so_far.denied.map(d => `${d.tool} ${relativeTo(cwd, d.target)}`)
    round = await runRound($, { prompt: continuePrompt(denied), model, maxTurns: maxTurns - turns, resume: sessionId, cwd, addDirs }, signal, onTurn)
    rounds++
  }

  timerStop.abort()
  const report = sessionId ? await sessionReport($, sessionId) : { usd: null, files: [], denied: [], toolCalls: 0 }
  const finished = isFinished(round.finalText)
  const isDone = round.code === 0 && round.subtype === 'success' && finished
  await setRun($, id, { state: isDone ? 'done' : 'failed', turns, costUsd: report.usd ?? undefined })
  void refreshHeads($, fiveHourUsd)

  const text = formatReport({
    id, model, cwd, sessionId, finished, rounds, turns, usd: report.usd, files: report.files, denied: report.denied,
    finalText: round.finalText, exit: timedOut ? `timed out after ${minutes} min` : String(round.code ?? round.signal), rulesNote, errors: round.errors,
  })
  return { text, isDone }
}

export const register: Register = (on, options) => {
  const fiveHourUsd = Number(options.headsFiveHourUsd ?? 14)
  const weeklyUsd = Number(options.headsWeeklyUsd ?? 35)
  const plan = String(options.headsPlan ?? 'GOAT')
  const defaultHead = String(options.headModel ?? 'deepseek/deepseek-v4.1-flash')

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'limits', description: 'Show Claude and Command Code usage limits' })
    await $.command.register({
      name: 'hydra',
      description: 'Turn on Hydra: Claude leads, Command Code heads implement',
      argumentHint: '[fable|opus|sonnet] [head=<model>] [task] | off | status',
    })
    await $.tool.register({
      name: 'head',
      description: 'Hydra: run one Command Code Head (a cheaper coding agent) headlessly on a self-contained implementation task. Returns its report, cost, the files it edited and any denied calls; with background: true it returns at once and the report arrives as a message. Usable only while the person has Hydra on.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Self-contained spec: goal, exact files, constraints, acceptance check' },
          cwd: { type: 'string', description: 'Repo directory to work in; defaults to the session root' },
          model: { type: 'string', description: 'Command Code model id; defaults to the Hydra head model' },
          maxTurns: { type: 'number', description: 'Turn cap for the Head (default 60)' },
          addDirs: { type: 'array', items: { type: 'string' }, description: 'Absolute folders outside cwd the Head must read (mockups, briefs, other repos)' },
          allowShell: { type: 'array', items: { type: 'string' }, description: 'Shell command patterns the Head may run beyond read-only ones, e.g. "xcrun swiftc -parse *"' },
          maxMinutes: { type: 'number', description: 'Wall-clock limit before the Head is stopped (default 40)' },
          background: { type: 'boolean', description: 'Return at once; the report arrives later as a message. Use for parallel fan-out.' },
        },
        required: ['task'],
      },
    })
    // A reload or restart ends every Head this module was running; say so instead of showing them running forever.
    await update($, runs, list => list.map(run => (run.state === 'running' ? { ...run, state: 'failed' as const } : run)))
    const usage = await $.session.usage()
    await storeLead($, usage.rateLimits, fiveHourUsd)
    void refreshHeads($, fiveHourUsd)
    $.clock.every(REFRESH_MS, () => void refreshHeads($, fiveHourUsd))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await storeLead($, e.rateLimits, fiveHourUsd)

    return next(e)
  })

  on('command.run', { command: 'hydra' }, async ($, e) => {
    const { action, leadModel, headModel, task } = parseHydraArgs(e.args)
    const current = (await read($, mode)) ?? { isOn: false, headModel: defaultHead }

    if (action === 'status') {
      const model = await $.session.model()
      return { text: current.isOn ? `🐉 Hydra on · Lead ${model} · Head ${current.headModel}` : 'Hydra is off. Turn it on with /hydra.' }
    }
    if (action === 'off') {
      await update($, mode, () => ({ ...current, isOn: false }))
      $.ui.invalidate('tool.describe')
      await refreshStatus($, fiveHourUsd)
      return { text: 'Hydra off. Claude works alone again.' }
    }

    const next = { isOn: true, headModel: headModel ?? current.headModel }
    await update($, mode, () => next)
    $.ui.invalidate('tool.describe')
    await refreshStatus($, fiveHourUsd)
    const model = await $.session.model()
    const switchHint = leadModel && !model.toLowerCase().includes(leadModel) ? ` Run /model ${leadModel} to switch the Lead.` : ''
    const text = `🐉 Hydra on · Lead ${model} · Head ${next.headModel}. /hydra off to stop.${switchHint}`

    return task ? { text, context: [task] } : { text }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const hydra = await read($, mode)
    if (!hydra?.isOn) return composed

    return { sections: [...composed.sections, { id: 'hydra:policy', text: HYDRA_POLICY(hydra.headModel), scope: 'session' as const }] }
  })

  on('tool.describe', { tool: HEAD_TOOL }, async ($, e, next) => {
    const described = await next(e)

    return { ...described, isDeferred: !(await read($, mode))?.isOn }
  })

  on('tool.call', { tool: HEAD_TOOL }, async ($, e, next) => {
    const hydra = await read($, mode)
    if (!hydra?.isOn) return { deny: 'Hydra is off. The person turns it on with /hydra.' }
    if (!String(e.task ?? '').trim()) return { deny: 'A Head needs a task.' }
    const id = `h${String(e.tool_use_id ?? (await $.clock.now())).slice(-6)}`
    if (e.background === true) {
      const controller = new AbortController()
      void runHead($, e, hydra.headModel, controller.signal, fiveHourUsd, id)
        .then(({ text }) => $.prompt.submit({ text: `Hydra Head ${id} finished.\n${text}` }))
        .catch(error => $.prompt.submit({ text: `Hydra Head ${id} failed before it reported: ${String(error).slice(0, 300)}` }))

      return { result: `Head ${id} started in the background on ${hydra.headModel}. Its report arrives as a message from the hydra plugin when it finishes.` }
    }
    const { text } = await runHead($, e, hydra.headModel, next.signal, fiveHourUsd, id)

    return { result: text }
  }).catch(() => ({ deny: 'hydra: the Head run failed before it reported.' }))

  on('command.run', { command: 'limits' }, async $ => {
    await refreshHeads($, fiveHourUsd)
    await $.ui.open({ id: PANE, title: 'Usage' })

    return { text: 'Usage pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const width = Math.max(10, Math.min(40, (e.viewport?.columns ?? 50) - 6))
    const windows = await read($, lead)
    const usage = await read($, heads)
    const hydra = await read($, mode)
    const recent = (await read($, runs)).slice(-5)

    const row = (label: string, percent: number, detail: string) => (
      <Box flexDirection="column" marginBottom={1}>
        <Box justifyContent="space-between">
          <Text>{label}</Text>
          <Text dimColor>
            {detail} {Math.round(percent)}%
          </Text>
        </Box>
        <Text color={colorOf(percent)}>{barOf(percent, width)}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Text bold color="#D97757">✳ Lead · Claude</Text>
        {windows.length === 0 && <Text dimColor>No reading yet: limits arrive with the first reply on a subscription.</Text>}
        {windows.map(w => row(leadLabel(w.kind), w.percentUsed, resetsIn(w.resetsAt, now)))}

        <Text bold>⌘ Heads · Command Code</Text>
        <Text dimColor>Plan · {plan} · estimated from local session costs</Text>
        {!usage && <Text dimColor>Reading ~/.commandcode…</Text>}
        {usage?.error && <Text color="red">{usage.error}</Text>}
        {usage && !usage.error && row(`5-hour limit · $${fiveHourUsd.toFixed(2)}`, percentOf(usage.fiveHour.usd, fiveHourUsd), `$${usage.fiveHour.usd.toFixed(2)} ${resetsIn(usage.fiveHour.resetsAt, now)}`)}
        {usage && !usage.error && row(`Weekly · $${weeklyUsd.toFixed(2)}`, percentOf(usage.weekly.usd, weeklyUsd), `$${usage.weekly.usd.toFixed(2)} ${resetsIn(usage.weekly.resetsAt, now)}`)}

        <Text bold>🐉 Hydra · {hydra?.isOn ? `on · Head ${hydra.headModel}` : 'off'}</Text>
        {recent.map(run => (
          <Text dimColor={run.state !== 'running'} color={run.state === 'failed' ? 'red' : undefined}>
            {run.state} · {shortModel(run.model)} · {run.turns} turns{run.costUsd !== undefined ? ` · $${run.costUsd.toFixed(3)}` : ''} · {run.task}
          </Text>
        ))}
      </Box>
    )
  })
}
