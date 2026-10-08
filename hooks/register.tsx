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
- Heads run with Command Code's --yolo (its headless mode cannot edit otherwise), locked down by Hydra's deny rules: they can edit only inside \`cwd\` (never .git or \`.env\` files), read folders you list in \`addDirs\`, and have no shell unless you pass \`shell: true\` (destructive git, rm -r/-f, sudo, network tools, builds and installs stay denied even then). Builds and tests are yours.
- If the project or an \`addDirs\` folder holds a \`.env\` file, Heads have no search tool: name the exact files in the task. A Head with \`shell: true\` can still read \`.env\` through a command that does not name it (\`grep -r\`), so avoid shell in projects with real secrets.
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

export type HeadLimits = { fiveHourUsd: number; weeklyUsd: number }

/** Shown only while Hydra is on: the Head model and what Heads spent against their 5-hour and weekly limits. */
export const statusLine = (hydra: HydraMode | null, usage: HeadsUsage | null, limits: HeadLimits) => {
  if (!hydra?.isOn) return undefined
  const parts = [`🐉 Hydra · ${shortModel(hydra.headModel)}`]
  if (usage && !usage.error) {
    parts.push(`5h $${usage.fiveHour.usd.toFixed(2)}/$${limits.fiveHourUsd}`, `7d $${usage.weekly.usd.toFixed(2)}/$${limits.weeklyUsd}`)
  }
  return parts.join(' │ ')
}

async function refreshStatus($: EngineInterface, limits: HeadLimits) {
  $.ui.status(statusLine(await read($, mode), await read($, heads), limits))
}

async function refreshHeads($: EngineInterface, limits: HeadLimits) {
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
  await refreshStatus($, limits)
}

async function storeLead($: EngineInterface, windows: readonly LeadWindow[], limits: HeadLimits) {
  await update($, lead, () => windows.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt })))
  for (const w of windows) {
    const mark = `${w.kind}@${w.resetsAt ?? ''}`
    if (w.percentUsed < WARN_AT || (await read($, warned)).includes(mark)) continue
    await update($, warned, list => [...list, mark].slice(-20))
    $.ui.toast(`Claude ${leadLabel(w.kind)} at ${Math.round(w.percentUsed)}% · ${resetsIn(w.resetsAt, await $.clock.now())}`)
  }
  await refreshStatus($, limits)
}

async function setRun($: EngineInterface, id: string, change: Partial<HeadRun>) {
  await update($, runs, list => list.map(run => (run.id === id ? { ...run, ...change } : run)))
}

type SessionReport = { usd: number | null; files: string[]; denied: { tool: string; target: string; text: string }[]; toolCalls: number }

/** The session a Head started, found from its transcript when the run ended before reporting it (a timeout, a kill). */
async function findSession($: EngineInterface, since: number, task: string): Promise<string | undefined> {
  try {
    const ran = await $.process.run(['/usr/bin/env', 'python3', '-I', `${$.plugin.root}/bin/cc-usage.py`, '--find', String(since - 5_000), task.slice(0, 100)])
    return (JSON.parse(ran.stdout) as { sessionId: string | null }).sessionId ?? undefined
  } catch {
    return undefined
  }
}

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

/** Shell commands a Head never runs, even when its task turns shell on. */
export const DANGEROUS_SHELL = [
  'Shell(git commit*)', 'Shell(git push*)', 'Shell(git reset*)', 'Shell(git checkout*)', 'Shell(git switch*)',
  'Shell(git restore*)', 'Shell(git stash*)', 'Shell(git clean*)', 'Shell(git rebase*)', 'Shell(git merge*)',
  'Shell(git branch -D*)', 'Shell(git tag*)', 'Shell(gh *)',
  'Shell(rm -r*)', 'Shell(rm -f*)', 'Shell(rm -R*)', 'Shell(sudo*)', 'Shell(su *)', 'Shell(chmod*)', 'Shell(chown*)',
  'Shell(curl*)', 'Shell(wget*)', 'Shell(ssh*)', 'Shell(scp*)', 'Shell(rsync*)', 'Shell(nc *)', 'Shell(open *)',
  'Shell(osascript*)', 'Shell(launchctl*)', 'Shell(defaults write*)', 'Shell(security *)', 'Shell(kill*)', 'Shell(pkill*)',
  'Shell(xcodebuild*)', 'Shell(swift build*)', 'Shell(swift test*)', 'Shell(npm publish*)', 'Shell(npm install*)',
  'Shell(pip install*)', 'Shell(brew *)',
]

/**
 * Inside the project a Head may edit anything except the repo's history, Hydra's own rules and secret files.
 * Shell rules match `.env` only as a path (after a space, `/` or `=`), so `process.env` still runs.
 */
export const PROJECT_DENY = [
  'Edit(/.git/**)', 'Edit(/.commandcode/**)',
  'Read(.env)', 'Read(.env.*)', 'Edit(.env)', 'Edit(.env.*)', 'Shell(* .env*)', 'Shell(*/.env*)', 'Shell(*=.env*)',
]

/** The grep tool ignores Read rules and has no path-scoped deny, so it is denied whole when a `.env` file is in reach. */
export const SEARCH_DENY = 'Grep'

type Permissions = { allow?: string[]; deny?: string[]; additionalDirectories?: string[] }
type HeadSettings = { managedBy?: string; permissions?: Permissions }
type HeadNeeds = { addDirs: readonly string[]; shell: boolean }

const union = (a: readonly string[] = [], b: readonly string[] = []) => [...new Set([...a, ...b])]

/**
 * Hydra's rules for Heads run under --yolo: deny rules are the only thing yolo honours, so every write outside the
 * project is denied path by path, and shell is denied outright unless a running Head in this project asked for it.
 */
export const headSettings = (heads: readonly HeadNeeds[], outsideDeny: readonly string[], hasEnvFile = false): HeadSettings => {
  const shell = heads.some(head => head.shell)
  return {
    managedBy: OWNER,
    permissions: {
      deny: [...outsideDeny, ...PROJECT_DENY, ...(shell ? DANGEROUS_SHELL : ['Shell']), ...(hasEnvFile ? [SEARCH_DENY] : [])],
      additionalDirectories: heads.reduce<string[]>((dirs, head) => union(dirs, head.addDirs), []),
    },
  }
}

/** Deny rules for every sibling of every folder on the way down to `cwd`, so nothing outside it can be written. */
async function outsideDenyRules($: EngineInterface, cwd: string) {
  const parts = cwd.split('/').filter(Boolean)
  const rules: string[] = []
  let base = ''
  for (const part of parts) {
    const entries = await $.fs.list(base || '/')
    for (const entry of entries) {
      if (entry.name === part) continue
      const path = `${base}/${entry.name}`.slice(1)
      rules.push(`Edit(//${path})`, `Edit(//${path}/**)`)
    }
    base += `/${part}`
  }
  return rules
}

const projects = new Map<string, Map<string, HeadNeeds>>()
const searchOff = new Map<string, string>()

/** The first `.env` file under `dirs`, or why the check failed; a failed check counts as found. */
async function findEnvFile($: EngineInterface, dirs: readonly string[]): Promise<string | undefined> {
  const found = await $.process.run([
    'find', ...dirs, '(', '-name', '.git', '-o', '-name', 'node_modules', ')', '-prune', '-o',
    '-type', 'f', '(', '-name', '.env', '-o', '-name', '.env.*', ')', '-print', '-quit',
  ]).catch(() => null)
  if (!found) return 'the .env check could not run'
  const first = found.stdout.split('\n')[0]?.trim()
  if (first) return first
  return found.exitCode === 0 ? undefined : 'the .env check could not read every folder'
}

const rulesPath = (cwd: string) => `${cwd.replace(/\/$/, '')}/${RULES_FILE}`

/** Writes the project's rules for the Heads now running in it. Returns why it refused, if it did; a Head must not run then. */
async function writeRules($: EngineInterface, cwd: string): Promise<string | undefined> {
  const path = rulesPath(cwd)
  if (await $.fs.exists(path)) {
    let existing: HeadSettings
    try {
      existing = JSON.parse(await $.fs.read(path)) as HeadSettings
    } catch {
      return `${RULES_FILE} exists but is not valid JSON`
    }
    if (existing.managedBy !== OWNER) return `${RULES_FILE} belongs to the person, so Hydra cannot lock this project down`
  }
  const heads = [...(projects.get(cwd)?.values() ?? [])]
  const envFile = await findEnvFile($, [cwd, ...heads.reduce<string[]>((dirs, head) => union(dirs, head.addDirs), [])])
  if (envFile) searchOff.set(cwd, envFile)
  else searchOff.delete(cwd)
  await $.fs.write(path, JSON.stringify(headSettings(heads, await outsideDenyRules($, cwd), Boolean(envFile)), null, 2) + '\n')
  const exclude = await $.process.run(['git', '-C', cwd, 'rev-parse', '--git-path', 'info/exclude']).catch(() => null)
  if (exclude?.exitCode === 0) {
    const file = exclude.stdout.trim()
    const excludePath = file.startsWith('/') ? file : `${cwd.replace(/\/$/, '')}/${file}`
    const current = (await $.fs.exists(excludePath)) ? await $.fs.read(excludePath) : ''
    if (!current.split('\n').includes(RULES_FILE)) await $.fs.write(excludePath, `${current.replace(/\n?$/, '\n')}${RULES_FILE}\n`)
  }
  return undefined
}

async function joinProject($: EngineInterface, cwd: string, id: string, needs: HeadNeeds) {
  const heads = projects.get(cwd) ?? new Map<string, HeadNeeds>()
  heads.set(id, needs)
  projects.set(cwd, heads)
  const refusal = await writeRules($, cwd).catch(error => `rules not written: ${String(error).slice(0, 160)}`)
  if (refusal) heads.delete(id)
  return refusal
}

async function leaveProject($: EngineInterface, cwd: string, id: string) {
  projects.get(cwd)?.delete(id)
  await writeRules($, cwd).catch(() => undefined)
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

/**
 * Background Heads run in a worker loop that `session.start` owns, on that hook's `$`: a `tool.call` hook's `$`
 * lapses once the call is long over, and a Head spawned under it dies with it. The tool call only queues the job.
 */
type Job = { input: Record<string, unknown>; headModel: string; id: string }

export const createJobQueue = () => {
  const jobs: Job[] = []
  let wake: (() => void) | undefined
  return {
    get size() { return jobs.length },
    push(job: Job) {
      jobs.push(job)
      const resume = wake
      wake = undefined
      resume?.()
    },
    async next(): Promise<Job> {
      while (jobs.length === 0) await new Promise<void>(resolve => (wake = resolve))
      return jobs.shift()!
    },
  }
}

const backgroundJobs = createJobQueue()
let isWorkerRunning = false

type Round = { finalText: string; sessionId?: string; subtype?: string; code: number | null; signal?: string; errors: string }

async function runRound(
  $: EngineInterface,
  argv: { prompt: string; model: string; maxTurns: number; resume?: string; cwd: string; addDirs: readonly string[] },
  signal: AbortSignal,
  onTurn: () => Promise<void>,
): Promise<Round> {
  const args = ['/usr/bin/env', 'commandcode', '-p', argv.prompt, '-m', argv.model, '--max-turns', String(argv.maxTurns),
    '--output-format', 'json', '--skip-onboarding', '--yolo', '--trust']
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

export const outsideFiles = (cwd: string, files: readonly string[]) => {
  const root = cwd.replace(/\/$/, '') + '/'
  return files.filter(file => file.startsWith('/') && !file.startsWith(root))
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
  const outside = outsideFiles(head.cwd, head.files)
  if (outside.length > 0) lines.push(`⚠ WROTE OUTSIDE THE PROJECT (${outside.length}): ${outside.join(', ')}`)
  lines.push(head.files.length > 0 ? `edited (${head.files.length}): ${head.files.map(file => relativeTo(head.cwd, file)).join(', ')}` : 'edited: nothing')
  if (head.denied.length > 0) {
    lines.push(`denied (${head.denied.length}):`, ...head.denied.map(d => `  - ${d.tool} ${relativeTo(head.cwd, d.target)}: ${d.text.slice(0, 140)}`))
  }
  lines.push('--- head report ---', (head.finalText || '(no final report)').trim().slice(-8000))
  if (!head.finished && head.errors?.trim()) lines.push('--- stderr ---', head.errors.trim())
  return lines.join('\n')
}

async function runHead($: EngineInterface, input: Record<string, unknown>, headModel: string, signal: AbortSignal, limits: HeadLimits, id: string) {
  const task = String(input.task ?? '').trim()
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : await $.session.root()
  const model = typeof input.model === 'string' && input.model ? input.model : headModel
  const maxTurns = Number(input.maxTurns ?? 60)
  const addDirs = strings(input.addDirs)
  const shell = input.shell === true || strings(input.allowShell).length > 0
  const minutes = Number(input.maxMinutes ?? DEFAULT_MINUTES)

  await update($, runs, list => [...list, { id, task: task.slice(0, 80), model, state: 'running' as const, turns: 0 }].slice(-12))
  await refreshStatus($, limits)
  await gate.enter()
  try {
    return await runHeadInside($, { task, cwd, model, maxTurns, addDirs, shell, minutes }, signal, limits, id)
  } finally {
    gate.leave()
  }
}

async function runHeadInside(
  $: EngineInterface,
  head: { task: string; cwd: string; model: string; maxTurns: number; addDirs: string[]; shell: boolean; minutes: number },
  outer: AbortSignal,
  limits: HeadLimits,
  id: string,
) {
  const { task, cwd, model, maxTurns, addDirs, shell, minutes } = head
  const refusal = await joinProject($, cwd, id, { addDirs, shell })
  if (refusal) {
    await setRun($, id, { state: 'failed' })
    await refreshStatus($, limits)
    return {
      text: formatReport({
        id, model, cwd, finished: false, rounds: 0, turns: 0, usd: 0, files: [], denied: [], finalText: '',
        exit: 'not started', rulesNote: `${refusal}. The Head runs with --yolo, so it never starts without Hydra's rules.`,
      }),
      isDone: false,
    }
  }
  const envFile = searchOff.get(cwd)
  const rulesNote = envFile ? `search tool denied because ${relativeTo(cwd, envFile)} is in reach` : undefined
  try {
    return await runLockedHead($, { task, cwd, model, maxTurns, addDirs, minutes, rulesNote }, outer, limits, id)
  } finally {
    await leaveProject($, cwd, id)
  }
}

async function runLockedHead(
  $: EngineInterface,
  head: { task: string; cwd: string; model: string; maxTurns: number; addDirs: string[]; minutes: number; rulesNote?: string },
  outer: AbortSignal,
  limits: HeadLimits,
  id: string,
) {
  const { task, cwd, model, maxTurns, addDirs, minutes, rulesNote } = head
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

  let turns = 0
  const onTurn = async () => {
    turns++
    await setRun($, id, { turns })
    await refreshStatus($, limits)
  }

  const startedAt = await $.clock.now()
  let round = await runRound($, { prompt: task + HEAD_RULES, model, maxTurns, cwd, addDirs }, signal, onTurn)
  for (let attempt = 1; !round.sessionId && !signal.aborted && attempt <= START_RETRIES; attempt++) {
    await $.clock.sleep(attempt * 5_000, { signal }).catch(() => undefined)
    round = await runRound($, { prompt: task + HEAD_RULES, model, maxTurns, cwd, addDirs }, signal, onTurn)
  }
  const sessionId = round.sessionId ?? (await findSession($, startedAt, task))
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
  void refreshHeads($, limits)

  const text = formatReport({
    id, model, cwd, sessionId, finished, rounds, turns, usd: report.usd, files: report.files, denied: report.denied,
    finalText: round.finalText, exit: timedOut ? `timed out after ${minutes} min` : String(round.code ?? round.signal), errors: round.errors,
    rulesNote,
  })
  return { text, isDone }
}

export const register: Register = (on, options) => {
  const fiveHourUsd = Number(options.headsFiveHourUsd ?? 14)
  const weeklyUsd = Number(options.headsWeeklyUsd ?? 35)
  const plan = String(options.headsPlan ?? 'GOAT')
  const defaultHead = String(options.headModel ?? 'deepseek/deepseek-v4.1-flash')
  const limits = { fiveHourUsd, weeklyUsd }

  on('session.start', async ($, e, next) => {
    if (!isWorkerRunning) {
      isWorkerRunning = true
      void (async () => {
        for (;;) {
          const job = await backgroundJobs.next()
          void runHead($, job.input, job.headModel, new AbortController().signal, limits, job.id)
            .then(({ text }) => $.prompt.submit({ text: `Hydra Head ${job.id} finished.\n${text}` }))
            .catch(error => $.prompt.submit({ text: `Hydra Head ${job.id} failed before it reported: ${String(error).slice(0, 300)}` }))
        }
      })()
    }
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
          shell: { type: 'boolean', description: 'Give the Head a shell (off by default). Dangerous commands stay denied: destructive git, rm -r/-f, sudo, network tools, builds and installs.' },
          maxMinutes: { type: 'number', description: 'Wall-clock limit before the Head is stopped (default 40)' },
          background: { type: 'boolean', description: 'Return at once; the report arrives later as a message. Use for parallel fan-out.' },
        },
        required: ['task'],
      },
    })
    // A reload or restart ends every Head this module was running; say so instead of showing them running forever.
    await update($, runs, list => list.map(run => (run.state === 'running' ? { ...run, state: 'failed' as const } : run)))
    const usage = await $.session.usage()
    await storeLead($, usage.rateLimits, limits)
    void refreshHeads($, limits)
    $.clock.every(REFRESH_MS, () => void refreshHeads($, limits))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await storeLead($, e.rateLimits, limits)

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
      await refreshStatus($, limits)
      return { text: 'Hydra off. Claude works alone again.' }
    }

    const next = { isOn: true, headModel: headModel ?? current.headModel }
    await update($, mode, () => next)
    $.ui.invalidate('tool.describe')
    await refreshStatus($, limits)
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
      if (!isWorkerRunning) return { deny: 'Hydra has no background worker in this session yet; run this Head without background.' }
      backgroundJobs.push({ input: { ...e }, headModel: hydra.headModel, id })

      return { result: `Head ${id} started in the background on ${hydra.headModel}. Its report arrives as a message from the hydra plugin when it finishes.` }
    }
    const { text } = await runHead($, e, hydra.headModel, next.signal, limits, id)

    return { result: text }
  }).catch(() => ({ deny: 'hydra: the Head run failed before it reported.' }))

  on('command.run', { command: 'limits' }, async $ => {
    await refreshHeads($, limits)
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
