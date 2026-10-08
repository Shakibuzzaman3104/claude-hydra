/**
 * @author Shakib
 * @since 06/10/26
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HeadRun, HeadStep, HeadsUsage, HydraMode, LeadWindow } from '../types'

const PANE = 'hydra-usage'
const HEADS_PANE = 'hydra-heads'
const LIVE_AFTER_END_MS = 60_000
const HEAD_TOOL = 'mcp__hydra__head'
const CONTROL_TOOL = 'mcp__hydra__control'
const REFRESH_MS = 120_000
const WARN_AT = 90
const LEADS = ['fable', 'opus', 'sonnet'] as const

const lead = atom({ plugin: 'hydra', key: 'lead' } as const, [])
const heads = atom({ plugin: 'hydra', key: 'heads' } as const, null)
const warned = atom({ plugin: 'hydra', key: 'warned' } as const, [])
const mode = atom({ plugin: 'hydra', key: 'mode' } as const, null)
const runs = atom({ plugin: 'hydra', key: 'runs' } as const, [])
const selected = atom({ plugin: 'hydra', key: 'selected' } as const, null)
const tick = atom({ plugin: 'hydra', key: 'tick' } as const, 0)

const LEAD_LABELS: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: 'Weekly · all models',
  seven_day_opus: 'Weekly · Opus',
  seven_day_sonnet: 'Weekly · Sonnet',
  seven_day_fable: 'Weekly · Fable',
}

const effortRule = (effort: EffortMode) =>
  effort === 'auto'
    ? `- You pick each Head's reasoning effort with \`effort\`, never lower than high: \`high\` (the default) for a well-specified implementation; \`xhigh\` for multi-file work with some design judgement, non-trivial logic, edge-case tests or matching a mockup; \`max\` for a subtle bug, concurrency or state, an algorithm, a fragile cross-file change, or a retry after a Head got it wrong. A model without xhigh (DeepSeek V4.1 Flash) runs it as max.`
    : `- The person fixed every Head's effort at ${effort} with /hydra effort=${effort}; your \`effort\` field is ignored until they set /hydra effort=auto.`

export const HYDRA_POLICY = (headModel: string, effort: EffortMode) => `# Hydra mode (on)
You are the Lead. Implementation goes to Heads: Command Code agents on ${headModel}, called through the ${HEAD_TOOL} tool.
${effortRule(effort)}
- Plan first: split the work into self-contained tasks. Each Head task states the goal, the exact files, the constraints and the acceptance check; a Head sees only the repo and your task text.
- Heads run with Command Code's --yolo (its headless mode cannot edit otherwise), locked down by Hydra's deny rules: they can edit only inside \`cwd\` (never .git or \`.env\` files), read folders you list in \`addDirs\`, and have no shell unless you pass \`shell: true\` (destructive git, rm -r/-f, sudo, network tools, builds and installs stay denied even then). Builds and tests are yours.
- If the project or an \`addDirs\` folder holds a \`.env\` file, Heads have no search tool: name the exact files in the task. A Head with \`shell: true\` can still read \`.env\` through a command that does not name it (\`grep -r\`), so avoid shell in projects with real secrets.
- Give every Head a short \`name\` that says what it works on (\`prefs-utils\`, \`login-tests\`): you and the person track, stop and discuss Heads by that name. Without one, Hydra makes one from the task.
- Independent tasks on disjoint files go out as parallel ${HEAD_TOOL} calls with \`background: true\`: each returns at once and its report arrives later as a message from the hydra plugin. Dependent tasks run in sequence.
- Keep the judgement-heavy part yourself: architecture, tricky bugs, anything under ~20 lines.
- Never trust a Head's report. Read the diff and run the build/tests yourself, then fix it or send the Head back with precise feedback. A report lists the files the Head edited and every call that was denied.
- You manage the Heads yourself with ${CONTROL_TOOL}: \`list\` shows every Head (one marked NO LIVE PROCESS is stale), \`stop\` ends a stuck, wrong or stale Head (\`id\`, or all), \`clear\` drops finished ones from the views. Stop a Head yourself instead of asking the person to.
- End with what each Head did, what you verified, and the Heads' total cost.`

export const parseHydraArgs = (args: string) => {
  const words = args.trim().split(/\s+/).filter(Boolean)
  let action: 'on' | 'off' | 'status' = 'on'
  let leadModel: string | undefined
  let headModel: string | undefined
  let effort: string | undefined
  const rest: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    const lower = word.toLowerCase()
    if (i === 0 && (lower === 'off' || lower === 'status')) action = lower
    else if (rest.length === 0 && !leadModel && (LEADS as readonly string[]).includes(lower)) leadModel = lower
    else if (rest.length === 0 && lower.startsWith('head=')) headModel = word.slice(5)
    else if (rest.length === 0 && lower === '--head' && words[i + 1]) headModel = words[++i]
    else if (rest.length === 0 && lower.startsWith('effort=')) effort = lower.slice(7)
    else if (rest.length === 0 && lower === '--effort' && words[i + 1]) effort = words[++i]!.toLowerCase()
    else rest.push(word)
  }
  return { action, leadModel, headModel, effort, task: rest.join(' ') }
}

export const EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const HEAD_EFFORTS = ['high', 'xhigh', 'max'] as const
export const EFFORT_MODES = ['auto', ...EFFORTS] as const
export const DEFAULT_EFFORT = 'high'

export type EffortMode = (typeof EFFORT_MODES)[number]

export const isEffort = (value: unknown): value is string => typeof value === 'string' && (EFFORTS as readonly string[]).includes(value)
export const isHeadEffort = (value: unknown): value is (typeof HEAD_EFFORTS)[number] => typeof value === 'string' && (HEAD_EFFORTS as readonly string[]).includes(value)
export const isEffortMode = (value: unknown): value is EffortMode => typeof value === 'string' && (EFFORT_MODES as readonly string[]).includes(value)

/** The session's effort mode; anything else stored there reads as auto. */
export const effortModeOf = (hydra: HydraMode | null) => (isEffortMode(hydra?.effort) ? hydra.effort : 'auto')

/** The person's fixed level wins, any level; under auto the Lead's pick (high, xhigh or max) does, and high when it gave none. */
export const headEffort = (mode: EffortMode, leadPick: string | undefined) => (mode !== 'auto' ? mode : isHeadEffort(leadPick) ? leadPick : DEFAULT_EFFORT)

/** The model's levels from Command Code's refusal: `Unknown effort "medium". Supported: off, low, high, max.` */
export const supportedEfforts = (errors: string) => {
  const list = /Supported:\s*([a-z, ]+)/i.exec(errors)?.[1]
  return list ? list.split(',').map(level => level.trim()).filter(isEffort) : []
}

/** The nearest level the model takes, rounding up so a Head never thinks less than asked. */
export const nearestEffort = (wanted: string, supported: readonly string[]) => {
  const rank = (level: string) => (EFFORTS as readonly string[]).indexOf(level)
  const sorted = [...supported].sort((a, b) => rank(a) - rank(b))
  return sorted.find(level => rank(level) >= rank(wanted)) ?? sorted.at(-1)
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

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

export const clockOf = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const two = (n: number) => String(n).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return hours > 0 ? `${hours}:${two(minutes)}:${two(total % 60)}` : `${minutes}:${two(total % 60)}`
}

export const elapsedOf = (run: HeadRun, now: number) => (run.startedAt ? clockOf((run.endedAt ?? now) - run.startedAt) : '–')

export const glyphOf = (run: HeadRun, frame: number) =>
  run.state === 'running' ? SPINNER[frame % SPINNER.length]! : run.state === 'queued' ? '◌' : run.state === 'done' ? '✓' : '✗'

const glyphColor = (run: HeadRun) => (run.state === 'running' ? 'cyan' : run.state === 'done' ? 'green' : run.state === 'failed' ? 'red' : undefined)

/** Running and queued Heads, and any that ended in the last minute, so the band shows how they finished. */
export const isLive = (run: HeadRun, now: number) =>
  run.state === 'running' || run.state === 'queued' || (run.endedAt !== undefined && now - run.endedAt < LIVE_AFTER_END_MS)

export const headsSummary = (list: readonly HeadRun[]) =>
  (['running', 'queued', 'done', 'failed'] as const)
    .map(state => [state, list.filter(run => run.state === state).length] as const)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${state}`)
    .join(' · ')

/** What a Head is doing now, or how it ended. */
export const nowLine = (run: HeadRun) =>
  run.state === 'done' ? `done${run.costUsd !== undefined ? ` · $${run.costUsd.toFixed(4)}` : ''}` : run.activity ?? run.state

export type HeadLimits = { fiveHourUsd: number; weeklyUsd: number }

/** Shown only while Hydra is on: the Head model and effort, and what Heads spent against their 5-hour and weekly limits. */
export const statusLine = (hydra: HydraMode | null, usage: HeadsUsage | null, limits: HeadLimits) => {
  if (!hydra?.isOn) return undefined
  const parts = [`🐉 ${shortModel(hydra.headModel)} · ${effortModeOf(hydra)}`]
  if (usage && !usage.error) {
    parts.push(`Heads 5h $${usage.fiveHour.usd.toFixed(2)}/$${limits.fiveHourUsd}`, `7d $${usage.weekly.usd.toFixed(2)}/$${limits.weeklyUsd}`)
  }
  return parts.join(' | ')
}

/** Where the person's status line command finds this session's Hydra line; empty while Hydra is off. */
export const statusFile = (home: string, sessionId: string) => `${home}/.claude/hydra/status/${sessionId}.txt`

let lastStatus: string | undefined

/**
 * Hydra's line goes to a per-session file that ~/.claude/statusline.sh prints, not to `$.ui.status`, which the
 * engine draws with a `⚠ hydra:` prefix.
 */
async function refreshStatus($: EngineInterface, limits: HeadLimits) {
  const line = statusLine(await read($, mode), await read($, heads), limits) ?? ''
  if (line === lastStatus) return
  const home = await $.env.get('HOME')
  if (!home) return
  await $.fs.write(statusFile(home, await $.session.id()), line ? `${line}\n` : '')
  lastStatus = line
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

async function setRun($: EngineInterface, id: string, change: Partial<HeadRun> | ((run: HeadRun) => Partial<HeadRun>)) {
  await update($, runs, list => list.map(run => (run.id === id ? { ...run, ...(typeof change === 'function' ? change(run) : change) } : run)))
}

/** The events of Command Code's JSON stream the live view reads. */
export type StreamEvent = { type: string; toolCallId?: string; toolName?: string; input?: Record<string, unknown> }

const WATCHED = new Set(['turn_end', 'thinking_start', 'tool_queued', 'tool_running', 'tool_completed', 'tool_denied'])
const EDIT_TOOLS = new Set(['edit_file', 'write_file'])
const MAX_STEPS = 8

/** A short line for a tool call: `edit c.txt`, `search "TODO"`, `$ ls`. */
export const describeTool = (name: string, input: Record<string, unknown> = {}, cwd = '') => {
  const path = String(input.file_path ?? input.path ?? '')
  const at = !path || path === cwd || path === `${cwd}/` ? '.' : relativeTo(cwd, path)
  const verbs: Record<string, string> = { read_file: 'read', edit_file: 'edit', write_file: 'write', read_directory: 'list' }
  if (verbs[name]) return `${verbs[name]} ${at}`
  if (name === 'grep') return `search "${String(input.pattern ?? '')}"`
  if (name === 'glob') return `find ${String(input.pattern ?? '')}`
  if (name === 'shell_command') return `$ ${String(input.command ?? '')}`
  return name.replace(/_/g, ' ')
}

/** Folds one stream event into a Head's live record; `labels` keeps each queued call's line for its later events. */
export const applyEvent = (run: HeadRun, event: StreamEvent, labels: Map<string, string>, cwd: string): Partial<HeadRun> => {
  const label = () => labels.get(event.toolCallId ?? '') ?? describeTool(event.toolName ?? 'tool')
  switch (event.type) {
    case 'thinking_start':
      return { activity: 'thinking' }
    case 'tool_queued':
      labels.set(event.toolCallId ?? '', describeTool(event.toolName ?? 'tool', event.input, cwd))
      return {}
    case 'tool_running':
      return { activity: label() }
    case 'tool_completed':
    case 'tool_denied': {
      const isOk = event.type === 'tool_completed'
      const step: HeadStep = { isOk, text: label() }
      return {
        steps: [...(run.steps ?? []), step].slice(-MAX_STEPS),
        edits: (run.edits ?? 0) + (isOk && EDIT_TOOLS.has(event.toolName ?? '') ? 1 : 0),
        denials: (run.denials ?? 0) + (isOk ? 0 : 1),
      }
    }
    case 'turn_end':
      return { turns: run.turns + 1 }
    default:
      return {}
  }
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
    // Entries that do not exist yet: a new file directly in an ancestor folder (the home folder, say) must be denied too.
    rules.push(`Edit(/${base}/*)`)
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
type HeadResult = { text: string; isDone: boolean }
/** `reply` hands a foreground call its result; it answers false once that call is gone, and the report goes out as a message. */
type Job = { input: Record<string, unknown>; headModel: string; id: string; reply?: (result: HeadResult) => boolean }

/**
 * The foreground call's end of a worker-run Head. An interrupted call (the person typed, opened a pane, pressed Esc)
 * lets go of the Head instead of killing it: `reply` then answers false and the worker sends the report as a message.
 */
export const createReplyBox = <T,>(signal: AbortSignal) => {
  const box: { result?: T } = {}
  return {
    box,
    reply: (result: T) => {
      if (signal.aborted) return false
      box.result = result
      return true
    },
  }
}

/** Each live Head's stop switch, by id. */
const controllers = new Map<string, AbortController>()

export const stopReason = (signal: AbortSignal) => (typeof signal.reason === 'string' && signal.reason ? signal.reason : 'stopped')

/**
 * Marks running and queued Heads in `ids` (all of them when `ids` is 'all') as failed with `reason`.
 * Used for Heads that have no live process behind them any more, so the views stop counting.
 */
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'one', 'file', 'files', 'convert', 'add', 'fix', 'make', 'update', 'implement', 'write', 'task', 'goal', 'repo', 'android', 'kotlin', 'java'])
const NAME_MAX = 20

/** Lowercase kebab, letters and digits only, at most 20 characters, cut at a dash. */
export const slugOf = (text: string) => {
  const slug = text
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length <= NAME_MAX) return slug
  const cut = slug.slice(0, NAME_MAX)
  return (cut.includes('-') ? cut.slice(0, cut.lastIndexOf('-')) : cut).replace(/-+$/, '')
}

/** A name from the task: the first source file it names, else its first few meaningful words. */
export const nameFromTask = (task: string) => {
  const file = /([A-Za-z][\w-]*)\.(?:kt|kts|java|ts|tsx|js|jsx|swift|go|py|dart|xml|gradle)\b/.exec(task)?.[1]
  if (file) return slugOf(file)
  const words = (task.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []).filter(word => word.length > 2 && !STOP_WORDS.has(word))
  return slugOf(words.slice(0, 3).join('-')) || 'head'
}

/** The Lead's name, or one from the task, made unique among names already taken this session (`-2`, `-3`…). */
export const headName = (requested: unknown, task: string, taken: ReadonlySet<string>) => {
  const base = (typeof requested === 'string' && slugOf(requested)) || nameFromTask(task)
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const candidate = `${base.slice(0, NAME_MAX - suffix.length).replace(/-+$/, '')}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Waits for a worker-run Head's result by repeatedly awaiting `pause`, which must be a `$` call (a host `sleep`):
 * the engine stops a hook's own clock while a `$` call is in flight, so the wait costs no budget. Ends early on abort.
 */
export const waitForResult = async <T,>(box: { result?: T }, signal: AbortSignal, pause: () => Promise<void>): Promise<T | undefined> => {
  while (box.result === undefined && !signal.aborted) await pause().catch(() => undefined)
  return box.result
}

/** Stops live Heads by id; ones with no process behind them are marked failed at once. Returns those. */
async function stopHeadsNow($: EngineInterface, ids: readonly string[], reason: string, limits: HeadLimits) {
  for (const id of ids) controllers.get(id)?.abort(reason)
  const ghosts = ids.filter(id => !controllers.has(id))
  const now = await $.clock.now()
  if (ghosts.length > 0) await update($, runs, current => stopRuns(current, ghosts, `${reason} (no live process)`, now))
  await refreshStatus($, limits)
  return ghosts
}

/** Names handed out in this module's life, so parallel calls never get the same one before their runs are recorded. */
const usedNames = new Set<string>()

export const stopRuns = (list: readonly HeadRun[], ids: readonly string[] | 'all', reason: string, now: number) =>
  list.map(run =>
    (run.state === 'running' || run.state === 'queued') && (ids === 'all' || ids.includes(run.id))
      ? { ...run, state: 'failed' as const, endedAt: now, activity: reason }
      : run,
  )

/** One line per Head for the Lead: id, state, turns, elapsed, what it is doing, the task's start. */
export const listRuns = (list: readonly HeadRun[], now: number, isLiveProcess: (id: string) => boolean) =>
  list.length === 0
    ? 'No Heads in this session.'
    : list
        .map(run => {
          const ghost = (run.state === 'running' || run.state === 'queued') && !isLiveProcess(run.id) ? ' · NO LIVE PROCESS' : ''
          return `${run.id} · ${run.state}${ghost} · ${run.turns}/${run.maxTurns ?? '?'} turns · ${elapsedOf(run, now)} · ${nowLine(run)} · ${run.task.slice(0, 80)}`
        })
        .join('\n')

export const createQueue = <T,>() => {
  const jobs: T[] = []
  let wake: (() => void) | undefined
  return {
    get size() { return jobs.length },
    push(job: T) {
      jobs.push(job)
      const resume = wake
      wake = undefined
      resume?.()
    },
    async next(): Promise<T> {
      while (jobs.length === 0) await new Promise<void>(resolve => (wake = resolve))
      return jobs.shift()!
    },
  }
}

export const createJobQueue = () => createQueue<Job>()

const backgroundJobs = createJobQueue()

/** Prompts a command hands to the session to submit: a command's own `$` may lapse before the session is idle. */
const pendingPrompts = createQueue<string>()
let isWorkerRunning = false

type Round = { finalText: string; sessionId?: string; subtype?: string; code: number | null; signal?: string; errors: string }

async function runRound(
  $: EngineInterface,
  argv: { prompt: string; model: string; effort?: string; maxTurns: number; resume?: string; cwd: string; addDirs: readonly string[] },
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => Promise<void>,
): Promise<Round> {
  const args = ['/usr/bin/env', 'commandcode', '-p', argv.prompt, '-m', argv.model, '--max-turns', String(argv.maxTurns),
    '--output-format', 'json', '--skip-onboarding', '--yolo', '--trust']
  for (const dir of argv.addDirs) args.push('--add-dir', dir)
  if (argv.effort) args.push('--effort', argv.effort)
  if (argv.resume) args.push('--resume', argv.resume)
  const child = $.process.spawn({ argv: args, cwd: argv.cwd })
  let pending = ''
  let errors = ''
  let result: Record<string, unknown> | null = null
  const take = async (line: string) => {
    if (!line.trim().startsWith('{')) return
    try {
      const row = JSON.parse(line) as { type?: string; event?: StreamEvent }
      if (row.type === 'result') result = row as Record<string, unknown>
      if (row.event && WATCHED.has(row.event.type)) await onEvent(row.event)
    } catch {
      // A partial or non-JSON line from the CLI; the final result line is what counts.
    }
  }
  // Raced against the abort, so a silent child (a model thinking, a hung CLI) cannot hold a stopped Head open.
  const aborted = new Promise<'aborted'>(resolve => {
    if (signal.aborted) resolve('aborted')
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true })
  })
  for (;;) {
    const step = await Promise.race([child.next(), aborted])
    if (step === 'aborted') {
      void child.return({ code: null, signal: 'aborted' }).catch(() => undefined)
      break
    }
    if (step.done) break
    const { stream, text } = step.value
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

/** Runs a round at `effort`; if the model refuses that level, reruns once at its nearest supported one. */
async function runRoundAt(
  $: EngineInterface,
  argv: Parameters<typeof runRound>[1],
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => Promise<void>,
): Promise<Round & { effort?: string }> {
  const round = await runRound($, argv, signal, onEvent)
  if (round.sessionId || !argv.effort || signal.aborted) return { ...round, effort: argv.effort }
  if (/no reasoning effort/i.test(round.errors)) return { ...(await runRound($, { ...argv, effort: undefined }, signal, onEvent)), effort: undefined }
  const effort = /Unknown effort/i.test(round.errors) ? nearestEffort(argv.effort, supportedEfforts(round.errors)) : undefined
  if (!effort || effort === argv.effort) return { ...round, effort: argv.effort }
  return { ...(await runRound($, { ...argv, effort }, signal, onEvent)), effort }
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
  id: string; model: string; effort?: string; cwd: string; sessionId?: string; finished: boolean; rounds: number; turns: number;
  usd: number | null; files: string[]; denied: SessionReport['denied']; finalText: string; exit: string; rulesNote?: string; errors?: string
}) => {
  const lines = [
    `head ${head.id} · ${head.model}${head.effort ? ` · effort ${head.effort}` : ''} · ${head.finished ? 'finished' : 'NOT finished'} · exit ${head.exit} · ${head.rounds} round(s) · ${head.turns} turns · $${(head.usd ?? 0).toFixed(4)}`,
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
  const effort = isHeadEffort(input.effort) ? input.effort : undefined

  const queued: HeadRun = { id, task: task.slice(0, 200), model, state: 'queued', turns: 0, maxTurns, activity: 'waiting for a slot' }
  await update($, runs, list => [...list, queued].slice(-12))
  await refreshStatus($, limits)
  await gate.enter()
  if (signal.aborted) {
    gate.leave()
    await setRun($, id, { state: 'failed', endedAt: await $.clock.now(), activity: stopReason(signal) })
    await refreshStatus($, limits)
    return {
      text: formatReport({ id, model, cwd, finished: false, rounds: 0, turns: 0, usd: 0, files: [], denied: [], finalText: '', exit: stopReason(signal) }),
      isDone: false,
    }
  }
  const startedAt = await $.clock.now()
  await setRun($, id, { state: 'running', startedAt, activity: 'starting' })
  await update($, tick, () => startedAt)
  try {
    return await runHeadInside($, { task, cwd, model, maxTurns, addDirs, shell, minutes, effort }, signal, limits, id)
  } finally {
    gate.leave()
  }
}

async function runHeadInside(
  $: EngineInterface,
  head: { task: string; cwd: string; model: string; maxTurns: number; addDirs: string[]; shell: boolean; minutes: number; effort?: string },
  outer: AbortSignal,
  limits: HeadLimits,
  id: string,
) {
  const { task, cwd, model, maxTurns, addDirs, shell, minutes, effort } = head
  const refusal = await joinProject($, cwd, id, { addDirs, shell })
  if (refusal) {
    await setRun($, id, { state: 'failed', endedAt: await $.clock.now(), activity: refusal })
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
    return await runLockedHead($, { task, cwd, model, maxTurns, addDirs, minutes, rulesNote, effort }, outer, limits, id)
  } finally {
    await leaveProject($, cwd, id)
  }
}

async function runLockedHead(
  $: EngineInterface,
  head: { task: string; cwd: string; model: string; maxTurns: number; addDirs: string[]; minutes: number; rulesNote?: string; effort?: string },
  outer: AbortSignal,
  limits: HeadLimits,
  id: string,
) {
  const { task, cwd, model, maxTurns, addDirs, minutes, rulesNote } = head
  // Read each round, so a /hydra effort change reaches a running Head at its next round.
  const effortNow = async () => headEffort(effortModeOf(await read($, mode)), head.effort)
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
  const labels = new Map<string, string>()
  const onEvent = async (event: StreamEvent) => {
    if (event.type === 'turn_end') turns++
    await setRun($, id, run => applyEvent(run, event, labels, cwd))
  }
  const roundAt = async (argv: Omit<Parameters<typeof runRound>[1], 'effort'>) => {
    const effort = await effortNow()
    await setRun($, id, { effort })
    const ran = await runRoundAt($, { ...argv, effort }, signal, onEvent)
    if (ran.effort !== effort) await setRun($, id, { effort: ran.effort })
    return ran
  }

  const startedAt = await $.clock.now()
  let round = await roundAt({ prompt: task + HEAD_RULES, model, maxTurns, cwd, addDirs })
  for (let attempt = 1; !round.sessionId && !signal.aborted && attempt <= START_RETRIES; attempt++) {
    await $.clock.sleep(attempt * 5_000, { signal }).catch(() => undefined)
    round = await roundAt({ prompt: task + HEAD_RULES, model, maxTurns, cwd, addDirs })
  }
  const sessionId = round.sessionId ?? (await findSession($, startedAt, task))
  let rounds = 1
  while (!signal.aborted && sessionId && isResumable(round.code) && !isFinished(round.finalText) && rounds < MAX_ROUNDS && turns < maxTurns) {
    const so_far = await sessionReport($, sessionId)
    const denied = so_far.denied.map(d => `${d.tool} ${relativeTo(cwd, d.target)}`)
    await setRun($, id, { activity: `resuming (round ${rounds + 1})` })
    round = await roundAt({ prompt: continuePrompt(denied), model, maxTurns: maxTurns - turns, resume: sessionId, cwd, addDirs })
    rounds++
  }

  timerStop.abort()
  const report = sessionId ? await sessionReport($, sessionId) : { usd: null, files: [], denied: [], toolCalls: 0 }
  const finished = isFinished(round.finalText)
  const isDone = round.code === 0 && round.subtype === 'success' && finished
  const stopped = outer.aborted ? stopReason(outer) : undefined
  await setRun($, id, {
    state: isDone ? 'done' : 'failed', turns, costUsd: report.usd ?? undefined, endedAt: await $.clock.now(),
    activity: isDone ? undefined : timedOut ? `timed out after ${minutes} min` : stopped ?? 'stopped before HEAD DONE',
  })
  void refreshHeads($, limits)

  const text = formatReport({
    id, model, effort: round.effort, cwd, sessionId, finished, rounds, turns, usd: report.usd, files: report.files, denied: report.denied,
    finalText: round.finalText, exit: timedOut ? `timed out after ${minutes} min` : stopped ?? String(round.code ?? round.signal), errors: round.errors,
    rulesNote,
  })
  return { text, isDone }
}

export const register: Register = (on, options) => {
  const fiveHourUsd = Number(options.headsFiveHourUsd ?? 14)
  const weeklyUsd = Number(options.headsWeeklyUsd ?? 35)
  const plan = String(options.headsPlan ?? 'GOAT')
  const defaultHead = String(options.headModel ?? 'deepseek/deepseek-v4.1-flash-fast')
  const defaultEffort: EffortMode = isEffortMode(options.headEffort) ? options.headEffort : 'auto'
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
          void runHead($, job.input, job.headModel, controller.signal, limits, job.id)
            .catch(async error => {
              const reason = `failed before it reported: ${String(error).slice(0, 300)}`
              const now = await $.clock.now()
              await update($, runs, list => stopRuns(list, [job.id], reason, now))
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
    await $.command.register({ name: 'limits', description: 'Show Claude and Command Code usage limits', immediate: true })
    await $.command.register({ name: 'heads', description: 'Hydra: watch the Heads work, live (opens without interrupting Claude)', immediate: true })
    await $.command.register({
      name: 'hydra',
      description: 'Turn on Hydra: Claude leads, Command Code heads implement',
      argumentHint: '[fable|opus|sonnet] [head=<model>] [effort=<level>] [task] | off | status',
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
          name: { type: 'string', description: 'Short name to track this Head by, saying what it works on (e.g. prefs-utils, login-tests); lowercase letters, digits and dashes, up to 20. Defaults to one made from the task; made unique with -2, -3.' },
          effort: { type: 'string', enum: [...HEAD_EFFORTS], description: 'Reasoning effort for this Head: high (default), xhigh or max. Ignored while the person has fixed a level with /hydra effort=<level>.' },
          maxMinutes: { type: 'number', description: 'Wall-clock limit before the Head is stopped (default 40)' },
          background: { type: 'boolean', description: 'Return at once; the report arrives later as a message. Use for parallel fan-out.' },
        },
        required: ['task'],
      },
    })
    await $.tool.register({
      name: 'control',
      description: 'Hydra control for the Lead: list the Heads (with their state, turns, time and what they are doing), stop a stuck or wrong Head by id or all of them, clear finished ones from the views, or turn Hydra on/off and set the Head effort or model.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'stop', 'clear', 'on', 'off', 'effort'], description: 'What to do (default list)' },
          id: { type: 'string', description: 'For stop: the Head name (e.g. prefs-utils), or all; default all' },
          effort: { type: 'string', enum: [...EFFORT_MODES], description: 'For on/effort: auto or a fixed level' },
          headModel: { type: 'string', description: 'For on/effort: the Command Code model the Heads run on' },
        },
      },
    })
    $.ui.status(undefined)
    // A reload or restart ends every Head this module was running; say so instead of showing them running forever.
    const startNow = await $.clock.now()
    await update($, runs, list => stopRuns(list, 'all', 'ended by a reload or restart', startNow))
    const usage = await $.session.usage()
    await storeLead($, usage.rateLimits, limits)
    void refreshHeads($, limits)
    $.clock.every(REFRESH_MS, () => void refreshHeads($, limits))
    // The views' clock: stamps the time once a second while some Head is live, and once more after the last one goes quiet.
    let wasLive = false
    $.clock.every(1_000, () => void (async () => {
      const now = await $.clock.now()
      const isAnyLive = (await read($, runs)).some(run => isLive(run, now))
      if (isAnyLive || wasLive) await update($, tick, () => now)
      wasLive = isAnyLive
    })())

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await storeLead($, e.rateLimits, limits)

    return next(e)
  })

  on('command.run', { command: 'hydra' }, async ($, e) => {
    const { action, leadModel, headModel, effort, task } = parseHydraArgs(e.args)
    const stored = await read($, mode)
    const current = stored ?? { isOn: false, headModel: defaultHead, effort: defaultEffort }
    const currentEffort = stored ? effortModeOf(stored) : defaultEffort

    if (action === 'status') {
      const model = await $.session.model()
      return { text: current.isOn ? `🐉 Hydra on · Lead ${model} · Head ${current.headModel} · effort ${currentEffort}` : 'Hydra is off. Turn it on with /hydra.' }
    }
    if (action === 'off') {
      await update($, mode, () => ({ ...current, isOn: false }))
      $.ui.invalidate('tool.describe')
      await refreshStatus($, limits)
      return { text: 'Hydra off. Claude works alone again.' }
    }

    if (effort !== undefined && !isEffortMode(effort)) return { text: `Unknown effort "${effort}". Use auto (the Lead picks high, xhigh or max per Head) or one of: ${EFFORTS.join(', ')}.` }
    const next = { isOn: true, headModel: headModel ?? current.headModel, effort: effort ?? currentEffort }
    await update($, mode, () => next)
    $.ui.invalidate('tool.describe')
    await refreshStatus($, limits)
    const model = await $.session.model()
    const switchHint = leadModel && !model.toLowerCase().includes(leadModel) ? ` Run /model ${leadModel} to switch the Lead.` : ''
    const changed = current.isOn && next.effort !== currentEffort ? ' Running Heads switch at their next round.' : ''
    const effortText = next.effort === 'auto' ? 'effort auto (Lead picks high, xhigh or max)' : `effort ${next.effort}`
    const text = `🐉 Hydra on · Lead ${model} · Head ${next.headModel} · ${effortText}. /hydra off to stop.${changed}${switchHint}`

    // A command's `context` only rides along with the next prompt; submitting the task starts the Lead's turn now.
    if (task) {
      if (isWorkerRunning) pendingPrompts.push(task)
      else return { text, context: [task] }
    }

    return { text }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const hydra = await read($, mode)
    if (!hydra?.isOn) return composed

    return { sections: [...composed.sections, { id: 'hydra:policy', text: HYDRA_POLICY(hydra.headModel, effortModeOf(hydra)), scope: 'session' as const }] }
  })

  on('tool.describe', { tool: HEAD_TOOL }, async ($, e, next) => {
    const described = await next(e)

    return { ...described, isDeferred: !(await read($, mode))?.isOn }
  })

  on('tool.call', { tool: HEAD_TOOL }, async ($, e, next) => {
    const hydra = await read($, mode)
    if (!hydra?.isOn) return { deny: 'Hydra is off. The person turns it on with /hydra.' }
    if (!String(e.task ?? '').trim()) return { deny: 'A Head needs a task.' }
    if (e.effort !== undefined && !isHeadEffort(e.effort)) return { deny: 'effort must be high, xhigh or max; Heads never run lower than high.' }
    const taken = new Set([...usedNames, ...(await read($, runs)).map(run => run.id)])
    const id = headName(e.name, String(e.task ?? ''), taken)
    usedNames.add(id)
    if (e.background === true) {
      if (!isWorkerRunning) return { deny: 'Hydra has no background worker in this session yet; run this Head without background.' }
      backgroundJobs.push({ input: { ...e }, headModel: hydra.headModel, id })

      return { result: `Head ${id} started in the background on ${hydra.headModel}. Its report arrives as a message from the hydra plugin when it finishes.` }
    }
    if (!isWorkerRunning) {
      const { text } = await runHead($, e, hydra.headModel, next.signal, limits, id)

      return { result: text }
    }
    // Run on the worker's long-lived `$`, so a cancelled call stops the Head cleanly instead of stranding it as running.
    // The hook waits through `$` calls: a hook's own time is capped at 10 s, and a `$` call in flight does not count.
    const { box, reply } = createReplyBox<HeadResult>(next.signal)
    backgroundJobs.push({ input: { ...e }, headModel: hydra.headModel, id, reply })
    const result = await waitForResult(box, next.signal, () => $.process.run(['/bin/sleep', '1'], { timeoutMs: 5_000 }).then(() => undefined))

    return { result: result?.text ?? `Head ${id} keeps running in the background after the call was interrupted; its report arrives as a message from the hydra plugin. Stop it with ${CONTROL_TOOL} if it is no longer wanted.` }
  }).catch(() => ({ deny: 'hydra: the Head run failed before it reported.' }))

  on('tool.describe', { tool: CONTROL_TOOL }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  on('tool.call', { tool: CONTROL_TOOL }, async ($, e) => {
    const action = String(e.action ?? 'list')
    const now = await $.clock.now()
    const ids = typeof e.id === 'string' && e.id && e.id !== 'all' ? [e.id] : ('all' as const)
    if (action === 'list') {
      const hydra = await read($, mode)
      const head = hydra?.isOn ? `Hydra on · Head ${hydra.headModel} · effort ${effortModeOf(hydra)}` : 'Hydra off'

      return { result: `${head}\n${listRuns(await read($, runs), now, id => controllers.has(id))}` }
    }
    if (action === 'stop') {
      const list = await read($, runs)
      const targets = list.filter(run => (run.state === 'running' || run.state === 'queued') && (ids === 'all' || ids.includes(run.id)))
      if (targets.length === 0) return { result: `No running or queued Head${ids === 'all' ? '' : ` ${ids[0]}`}.` }
      const ghosts = await stopHeadsNow($, targets.map(run => run.id), 'stopped by the Lead', limits)

      return { result: `Stopping ${targets.map(run => run.id).join(', ')}.${ghosts.length > 0 ? ` ${ghosts.join(', ')} had no live process and were marked failed.` : ''}` }
    }
    if (action === 'clear') {
      await update($, runs, list => list.filter(run => run.state === 'running' || run.state === 'queued'))

      return { result: 'Cleared finished and failed Heads from the views.' }
    }
    const stored = await read($, mode)
    const current = stored ?? { isOn: false, headModel: defaultHead, effort: defaultEffort }
    if (action === 'off') {
      await update($, mode, () => ({ ...current, isOn: false }))
    } else if (action === 'on' || action === 'effort') {
      const effort = typeof e.effort === 'string' ? e.effort : undefined
      if (effort !== undefined && !isEffortMode(effort)) return { deny: `effort must be auto or one of: ${EFFORTS.join(', ')}.` }
      const headModel = typeof e.headModel === 'string' && e.headModel ? e.headModel : current.headModel
      await update($, mode, () => ({ isOn: action === 'on' ? true : current.isOn, headModel, effort: effort ?? effortModeOf(stored) }))
    } else {
      return { deny: `Unknown action "${action}". Use list, stop, clear, on, off or effort.` }
    }
    $.ui.invalidate('tool.describe')
    await refreshStatus($, limits)
    const hydra = await read($, mode)

    return { result: hydra?.isOn ? `Hydra on · Head ${hydra.headModel} · effort ${effortModeOf(hydra)}` : 'Hydra off.' }
  })

  on('command.run', { command: 'heads' }, async $ => {
    await $.ui.open({ id: HEADS_PANE, title: 'Heads' })

    return { text: 'Heads pane opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const now = await read($, tick)
    const frame = Math.floor(now / 1000)
    const live = (await read($, runs)).filter(run => isLive(run, now))
    if (live.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>🐉 Hydra </Text>
          <Text dimColor>{headsSummary(live)} · /heads for detail</Text>
        </Box>
        {live.map(run => (
          <Box key={run.id}>
            <Text color={glyphColor(run)}>{glyphOf(run, frame)} </Text>
            <Text bold>{run.id} </Text>
            <Text dimColor>{(run.effort ?? '').padEnd(5)} </Text>
            <Text color={glyphColor(run)}>{barOf(run.maxTurns ? (run.turns / run.maxTurns) * 100 : 0, 8)}</Text>
            <Text dimColor> {String(run.turns).padStart(2)}/{run.maxTurns ?? '?'} {elapsedOf(run, now).padStart(5)} </Text>
            <Text wrap="truncate-end" dimColor={run.state !== 'running'}>{nowLine(run)}</Text>
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: HEADS_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await read($, tick)
    const frame = Math.floor(now / 1000)
    const hydra = await read($, mode)
    const list = [...(await read($, runs))].reverse()
    const pick = await read($, selected)
    const chosen = list.find(run => run.id === pick) ?? list.find(run => run.state === 'running') ?? list[0]
    const barWidth = Math.max(10, Math.min(30, e.props.bodyColumns - 24))

    return (
      <Box flexDirection="column">
        <Text bold>🐉 Hydra · {hydra?.isOn ? `${shortModel(hydra.headModel)} · effort ${effortModeOf(hydra)}` : 'off'}</Text>
        <Text dimColor>{list.length > 0 ? `${headsSummary(list)} · press a number to inspect, s to stop it` : 'No Heads in this session yet.'}</Text>
        <Box flexDirection="column" marginTop={1}>
          {list.map((run, index) => (
            <Box key={run.id}>
              <Button key={`pick-${run.id}`} plain hotkey={index < 9 ? String(index + 1) : undefined} label={run.id} onPress={() => update($, selected, () => run.id)} />
              <Text color={glyphColor(run)}> {glyphOf(run, frame)} </Text>
              <Text dimColor>{elapsedOf(run, now).padStart(5)} {String(run.turns).padStart(3)}t </Text>
              <Text wrap="truncate-end" bold={run.id === chosen?.id}>{run.task}</Text>
            </Box>
          ))}
        </Box>
        {chosen && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>
              {chosen.id} · {shortModel(chosen.model)}{chosen.effort ? ` · effort ${chosen.effort}` : ''} · {chosen.state} {elapsedOf(chosen, now)}
            </Text>
            <Text dimColor wrap="wrap">{chosen.task}</Text>
            {(chosen.state === 'running' || chosen.state === 'queued') && (
              <Box marginTop={1}>
                <Button key="stop-head" hotkey="s" label={`Stop ${chosen.id}`} onPress={() => stopHeadsNow($, [chosen.id], 'stopped from /heads', limits)} />
              </Box>
            )}
            <Box marginTop={1}>
              <Text>turn {chosen.turns}/{chosen.maxTurns ?? '?'} </Text>
              <Text color={glyphColor(chosen)}>{barOf(chosen.maxTurns ? (chosen.turns / chosen.maxTurns) * 100 : 0, barWidth)}</Text>
            </Box>
            <Text dimColor>
              {chosen.edits ?? 0} edits · {chosen.denials ?? 0} denied{chosen.costUsd !== undefined ? ` · $${chosen.costUsd.toFixed(4)}` : ''}
            </Text>
            <Box marginTop={1}>
              <Text color={glyphColor(chosen)}>{glyphOf(chosen, frame)} </Text>
              <Text wrap="truncate-end">{nowLine(chosen)}</Text>
            </Box>
            {(chosen.steps ?? []).map((step, index) => (
              <Box key={`step-${index}`}>
                <Text color={step.isOk ? 'green' : 'red'}>  {step.isOk ? '✓' : '✗'} </Text>
                <Text wrap="truncate-end" dimColor={step.isOk}>{step.text}{step.isOk ? '' : ' (denied)'}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })

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
    const recent = await read($, runs)

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

        <Text bold>🐉 Hydra · {hydra?.isOn ? `on · Head ${hydra.headModel} · effort ${effortModeOf(hydra)}` : 'off'}</Text>
        {recent.length > 0 && <Text dimColor>{headsSummary(recent)} · /heads to watch them</Text>}
      </Box>
    )
  })
}
