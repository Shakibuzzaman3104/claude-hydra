/**
 * @author Shakib
 * @since 06/10/26
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HeadRun, HeadStep, HeadsUsage, HydraMode, LeadWindow } from '../types'

const PANE = 'hydra-usage'
const HEADS_PANE = 'hydra-heads'
const USAGE_COMMAND = 'hydra-usage'
const LIVE_AFTER_END_MS = 60_000
const RUN_HISTORY = 20
const STATUS_KEEP_MS = 7 * 86_400_000
const CONSENT_KEY = 'consent-v1'
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

/** Spells out how the Head model rounds the levels it lacks, for models whose levels are known. */
const headLevelsNote = (headModel: string) =>
  /deepseek-v4\.1/i.test(headModel) ? ` ${shortModel(headModel)} takes low, high and max: medium runs as high, xhigh as max.` : ''

const effortRule = (effort: EffortMode, headModel: string) =>
  effort === 'auto'
    ? `- You pick each Head's reasoning \`effort\`, \`low\` to \`max\`, by how hard the task is. Effort buys accuracy on coding but not linearly: \`high\` is the best value, \`max\` runs ~1.7x longer for a few points, \`low\` thinks about a quarter as much and fails most open-ended work.
  - \`low\`: mechanical edits you spell out (rename, move, apply a given pattern or template, strings, docs, boilerplate) that your build or tests will check.
  - \`medium\`: a small, well-specified change in one or two files that follows an existing pattern.
  - \`high\` (the default): a feature or fix that needs some judgement, several steps or new tests.
  - \`xhigh\`: multi-file work with design judgement, non-trivial logic, edge-case tests or matching a mockup.
  - \`max\`: a subtle bug, concurrency or state, an algorithm, a fragile cross-file change, or work you cannot check cheaply.
  - One level up when the task leaves real choices open or has no check you can run; one down when you give exact edits. A retry goes one level above the run that failed (low, then high, then max).
  - A level the Head model lacks is raised to its nearest one.${headLevelsNote(headModel)}`
    : `- The person fixed every Head's effort at ${effort} with /hydra effort=${effort}; your \`effort\` field is ignored until they set /hydra effort=auto.`

export const HYDRA_POLICY = (headModel: string, effort: EffortMode) => `# Hydra mode (on)
You are the Lead. Implementation goes to Heads: Command Code agents on ${headModel}, called through the ${HEAD_TOOL} tool.
${effortRule(effort, headModel)}
- Plan first: split the work into self-contained tasks. Each Head task states the goal, the exact files, the constraints and the acceptance check; a Head sees only the repo and your task text.
- Heads run with Command Code's --yolo (its headless mode cannot edit otherwise), locked down by Hydra's deny rules: they can edit only inside \`cwd\` (never .git or \`.env\` files), read folders you list in \`addDirs\`, and have no shell unless you pass \`shell: true\` (destructive git, rm -r/-f, sudo, network tools, builds and installs stay denied even then). Builds and tests are yours.
- A Head writes only inside \`cwd\`; a write anywhere else, a symlink pointing out of the project included, is denied. When the task must change a folder outside it (a symlinked package's real location, a sibling repo), pass that folder in \`writeDirs\`, and only that folder.
- If the project or an \`addDirs\` folder holds a \`.env\` file, Heads have no search tool: name the exact files in the task. A Head with \`shell: true\` can still read \`.env\` through a command that does not name it (\`grep -r\`), so avoid shell in projects with real secrets.
- Give every Head a short \`name\` that says what it works on (\`prefs-utils\`, \`login-tests\`): you and the person track, stop and discuss Heads by that name. Without one, Hydra makes one from the task.
- Independent tasks on disjoint files go out as parallel ${HEAD_TOOL} calls with \`background: true\`: each returns at once and its report arrives later as a message from the hydra plugin. Dependent tasks run in sequence.
- Keep the judgement-heavy part yourself: architecture, tricky bugs, anything under ~20 lines.
- Never trust a Head's report. Read the diff and run the build/tests yourself, then fix it or send the Head back with precise feedback. A report lists the files the Head edited and every call that was denied.
- You manage the Heads yourself with ${CONTROL_TOOL}: \`list\` shows every Head (one marked NO LIVE PROCESS is stale), \`stop\` ends a stuck, wrong or stale Head (\`id\`, or all), \`clear\` drops finished ones from the views. Stop a Head yourself instead of asking the person to.
- End with what each Head did, what you verified, and the Heads' total cost.`

const ACTIONS = ['off', 'status', 'help', 'statusline'] as const

/** A lone word or an `x=`/`--x` option nobody knows is a typo, never a task. */
export const parseHydraArgs = (args: string) => {
  const words = args.trim().split(/\s+/).filter(Boolean)
  let action: 'on' | (typeof ACTIONS)[number] = 'on'
  let leadModel: string | undefined
  let headModel: string | undefined
  let effort: string | undefined
  const rest: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    const lower = word.toLowerCase()
    if (i === 0 && (ACTIONS as readonly string[]).includes(lower)) action = lower as (typeof ACTIONS)[number]
    else if (rest.length === 0 && !leadModel && (LEADS as readonly string[]).includes(lower)) leadModel = lower
    else if (rest.length === 0 && lower.startsWith('head=')) headModel = word.slice(5)
    else if (rest.length === 0 && lower === '--head' && words[i + 1]) headModel = words[++i]
    else if (rest.length === 0 && lower.startsWith('effort=')) effort = lower.slice(7)
    else if (rest.length === 0 && lower === '--effort' && words[i + 1]) effort = words[++i]!.toLowerCase()
    else rest.push(word)
  }
  const first = rest[0] ?? ''
  const unknown = rest.length === 1 || /^[\w-]+=/.test(first) || first.startsWith('--') ? first : undefined
  return { action, leadModel, headModel, effort, task: unknown ? '' : rest.join(' '), unknown }
}

export const HYDRA_HELP = `🐉 Hydra: Claude leads, Command Code Heads implement.
  /hydra                 turn Hydra on
  /hydra <task>          turn it on and hand Claude the task
  /hydra off             turn it off
  /hydra status          show what is set
  /hydra effort=<level>  auto (Claude picks per Head) or off, low, medium, high, xhigh, max
  /hydra head=<model>    the Command Code model Heads run on
  /hydra statusline      show Hydra in your status line
  /heads                 watch the Heads work, live
  /${USAGE_COMMAND}           Claude and Command Code usage`

export const STATUSLINE_HELP = `Hydra writes its line to ~/.claude/hydra/status/<session id>.txt while it is on. To show it, add this before the final printf of your status line script, where $input is the JSON Claude Code passes and $out your line:

session_id=$(printf '%s' "$input" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[A-Za-z0-9-]*"' | head -1 | sed -E 's/.*"([A-Za-z0-9-]*)"$/\\1/')
hydra_file="$HOME/.claude/hydra/status/$session_id.txt"
if [ -n "$session_id" ] && [ -s "$hydra_file" ]; then
  printf '%s\\n%s' "$out" "$(head -1 "$hydra_file")"
else
  printf '%s' "$out"
fi

Then add "refreshInterval": 2 to the statusLine block of ~/.claude/settings.json, so the line appears and clears within 2 seconds of /hydra and /hydra off instead of at your next message.

A full script is in the repo's examples/statusline.sh. Without it, the band above the prompt and /heads show the same.`

export const EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const HEAD_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const EFFORT_MODES = ['auto', ...EFFORTS] as const
export const DEFAULT_EFFORT = 'high'

export type EffortMode = (typeof EFFORT_MODES)[number]

export const isEffort = (value: unknown): value is string => typeof value === 'string' && (EFFORTS as readonly string[]).includes(value)
export const isHeadEffort = (value: unknown): value is (typeof HEAD_EFFORTS)[number] => typeof value === 'string' && (HEAD_EFFORTS as readonly string[]).includes(value)
export const isEffortMode = (value: unknown): value is EffortMode => typeof value === 'string' && (EFFORT_MODES as readonly string[]).includes(value)

/** The session's effort mode; anything else stored there reads as auto. */
export const effortModeOf = (hydra: HydraMode | null) => (isEffortMode(hydra?.effort) ? hydra.effort : 'auto')

/** The person's fixed level wins, any level; under auto the Lead's pick (low to max) does, and high when it gave none. */
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
    parts.push(`Heads 5h ${spentOf(usage.fiveHour.usd, limits.fiveHourUsd)}`, `7d ${spentOf(usage.weekly.usd, limits.weeklyUsd)}`)
  }
  return parts.join(' | ')
}

/** Spend against a limit, or the spend alone while the person has set no limit (0). */
export const spentOf = (usd: number, limit: number) => (limit > 0 ? `$${usd.toFixed(2)}/$${limit}` : `$${usd.toFixed(2)}`)

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

/** Deletes other sessions' status files untouched for a week. */
async function sweepStatusFiles($: EngineInterface) {
  const home = await $.env.get('HOME')
  if (!home) return
  const folder = `${home}/.claude/hydra/status`
  const now = await $.clock.now()
  const own = `${await $.session.id()}.txt`
  const entries = await $.fs.list(folder).catch(() => [])
  const old = entries.filter(entry => entry.kind === 'file' && entry.name.endsWith('.txt') && entry.name !== own && now - entry.mtimeMs > STATUS_KEEP_MS)
  if (old.length > 0) await $.process.run(['/bin/rm', '-f', ...old.map(entry => `${folder}/${entry.name}`)]).catch(() => undefined)
}

export type Preflight = { problems: string[]; warnings: string[] }

let isPreflightPassed = false

/** What stops Heads from running on this machine, each with what to run about it. */
async function preflight($: EngineInterface): Promise<Preflight> {
  if (isPreflightPassed) return { problems: [], warnings: [] }
  const works = (argv: string[]) => $.process.run(argv, { timeoutMs: 15_000 }).then(ran => ran.exitCode === 0, () => false)
  if (!(await works(['uname', '-s']))) return { problems: ['Hydra runs on macOS and Linux only for now. On Windows, run Claude Code under WSL.'], warnings: [] }
  const problems: string[] = []
  if (!(await works(['/usr/bin/env', 'commandcode', '--version']))) {
    problems.push('The Command Code CLI is not installed. Run `npm i -g command-code`, then `commandcode` once in a terminal to sign in.')
  }
  if (!(await works(['/usr/bin/env', 'python3', '--version']))) {
    problems.push('python3 is missing; Hydra reads Head transcripts with it. Install it (on macOS: `xcode-select --install`).')
  }
  if (!(await works(['git', '--version']))) problems.push('git is missing. Install it (on macOS: `xcode-select --install`).')
  const home = await $.env.get('HOME')
  const isSignedIn = home ? await $.fs.exists(`${home}/.commandcode/auth.json`).catch(() => false) : false
  const warnings = isSignedIn || problems.length > 0 ? [] : ['Command Code looks signed out: run `commandcode` once in a terminal to sign in, or Heads will fail.']
  isPreflightPassed = problems.length === 0
  return { problems, warnings }
}

export const preflightText = (check: Preflight) =>
  [`🐉 Hydra can't start yet:`, ...check.problems.map(problem => `  • ${problem}`), 'Then run /hydra again.'].join('\n')

export const CONSENT_QUESTION = (headModel: string) =>
  `Hydra hands each Head's task, and every file the Head reads, to ${headModel} through Command Code, and Heads edit this project unattended (Command Code's --yolo, locked down by Hydra: nothing outside the project, no .git or .env, no shell unless Claude asks). Turn Hydra on?`

const CONSENT_YES = 'Turn Hydra on'

/** Asks once, the first time Hydra turns on; the answer is kept across sessions. */
async function hasConsent($: EngineInterface, headModel: string, mayAsk: boolean) {
  if ((await $.store.get(CONSENT_KEY)) === true) return true
  if (!mayAsk) return false
  const answer = await $.ui.ask(CONSENT_QUESTION(headModel), { options: [CONSENT_YES, 'Not now'], header: 'Hydra' }).catch(() => undefined)
  if (answer !== CONSENT_YES) return false
  await $.store.set(CONSENT_KEY, true)
  return true
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

/** The last few lines of a Head's final report, without the done mark, for /heads. */
export const summaryOf = (text: string) =>
  text.replace(DONE_MARK, '').split('\n').map(line => line.trim()).filter(Boolean).slice(-6).map(line => line.slice(0, 200)).join('\n') || undefined

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
type GuardHook = { matcher: string; hooks: { type: 'command'; command: string; timeout: number }[] }
type HeadNeeds = { addDirs: readonly string[]; shell: boolean; writeDirs?: readonly string[] }
/** A running Head the rules file is kept for: `key` is `<session id>/<head id>`, `until` when it must have ended. */
export type HeadEntry = HeadNeeds & { key: string; until: number }
type HeadSettings = { managedBy?: string; hydraHeads?: HeadEntry[]; permissions?: Permissions; hooks?: { PreToolUse: GuardHook[] } }

const union = (a: readonly string[] = [], b: readonly string[] = []) => [...new Set([...a, ...b])]

/**
 * Hydra's rules for Heads run under --yolo: deny rules are the only thing yolo honours, so every write outside the
 * project is denied path by path, and shell is denied outright unless a running Head in this project asked for it.
 */
/** The folders outside the project that the running Heads may write to, from every Head's `writeDirs`. */
export const writeDirsOf = (heads: readonly HeadNeeds[]) => heads.reduce<string[]>((dirs, head) => union(dirs, head.writeDirs ?? []), [])

/** What stays protected inside a folder a Head may write to: its history, its Command Code settings and its secrets. */
export const writeDirDeny = (dir: string) => [
  `Edit(/${dir}/.git/**)`, `Edit(/${dir}/.commandcode/**)`,
  `Edit(/${dir}/**/.env)`, `Edit(/${dir}/**/.env.*)`, `Read(/${dir}/**/.env)`, `Read(/${dir}/**/.env.*)`,
]

export const headSettings = (heads: readonly HeadNeeds[], outsideDeny: readonly string[], hasEnvFile = false, guard?: string): HeadSettings => {
  const shell = heads.some(head => head.shell)
  const writeDirs = writeDirsOf(heads)
  return {
    managedBy: OWNER,
    permissions: {
      deny: [
        ...outsideDeny, ...PROJECT_DENY, ...writeDirs.flatMap(writeDirDeny),
        ...(shell ? DANGEROUS_SHELL : ['Shell']), ...(hasEnvFile ? [SEARCH_DENY] : []),
      ],
      additionalDirectories: heads.reduce<string[]>((dirs, head) => union(dirs, [...head.addDirs, ...(head.writeDirs ?? [])]), []),
    },
    ...(guard ? { hooks: { PreToolUse: [{ matcher: 'write|edit', hooks: [{ type: 'command' as const, command: guard, timeout: 10 }] }] } } : {}),
  }
}

const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

/**
 * The write guard Command Code runs before every write and edit: it denies a path whose real location is outside
 * `cwd` and the `writeDirs`, which deny rules cannot express for a new folder (write_file creates missing parents).
 */
export const guardCommand = (pluginRoot: string, cwd: string, writeDirs: readonly string[] = []) =>
  [`/usr/bin/env python3 -I ${shellQuote(`${pluginRoot}/bin/head-guard.py`)}`, ...[cwd, ...writeDirs].map(shellQuote)].join(' ')

const isWithin = (path: string, root: string) => path === root || path.startsWith(`${root.replace(/\/$/, '')}/`)

/** Each folder above one of `roots` (and not inside any), with the names that lead down to a root from it. */
export const waysDown = (roots: readonly string[]) => {
  const ways = new Map<string, Set<string>>()
  for (const root of roots) {
    let base = ''
    for (const part of root.split('/').filter(Boolean)) {
      if (roots.some(other => base && isWithin(base, other))) break
      ways.set(base, (ways.get(base) ?? new Set()).add(part))
      base += `/${part}`
    }
  }
  return ways
}

/**
 * Deny rules for every folder above the project and the `writeDirs`: each entry but the ways down, and any new
 * file directly in it. A new subfolder of an ancestor can't be named by a rule; the write guard denies those.
 */
export const ancestorDenyRules = (roots: readonly string[], entriesOf: (dir: string) => readonly string[]) => {
  const rules: string[] = []
  for (const [base, names] of waysDown(roots)) {
    rules.push(`Edit(/${base}/*)`)
    for (const name of entriesOf(base || '/')) {
      if (names.has(name)) continue
      const path = `${base}/${name}`.slice(1)
      rules.push(`Edit(//${path})`, `Edit(//${path}/**)`)
    }
  }
  return rules
}

async function outsideDenyRules($: EngineInterface, roots: readonly string[]) {
  const listings = new Map<string, string[]>()
  for (const base of waysDown(roots).keys()) listings.set(base || '/', (await $.fs.list(base || '/')).map(entry => entry.name))
  return ancestorDenyRules(roots, dir => listings.get(dir) ?? [])
}

/**
 * The real folders a Head asked to write to outside `cwd`, or why one is refused: it must exist, and must not be
 * `/`, the home folder, a folder above the project or one inside it.
 */
async function resolveWriteDirs($: EngineInterface, cwd: string, dirs: readonly string[]): Promise<{ dirs: string[] } | { refusal: string }> {
  const home = (await $.env.get('HOME')) ?? ''
  const realCwd = (await $.fs.stat(cwd, { resolve: true }).catch(() => undefined))?.realPath ?? cwd
  const resolved: string[] = []
  for (const dir of dirs) {
    if (!dir.startsWith('/')) return { refusal: `writeDirs needs absolute folders; "${dir}" is not one.` }
    const stat = await $.fs.stat(dir, { resolve: true }).catch(() => undefined)
    const real = stat?.realPath
    if (!stat || stat.kind !== 'dir' || !real) return { refusal: `writeDirs: ${dir} is not an existing folder.` }
    if (real === '/' || real === home || isWithin(realCwd, real)) return { refusal: `writeDirs: ${dir} is too broad: it holds the project or your home folder. Name the folder the task changes.` }
    if (isWithin(real, realCwd)) return { refusal: `writeDirs: ${dir} is inside the project, which a Head can write to already.` }
    resolved.push(real)
  }
  return { dirs: union(resolved) }
}

/** This session's running Heads plus other sessions' still in time; this session's own come from `mine` alone. */
export const mergeHeads = (inFile: readonly HeadEntry[], mine: readonly HeadEntry[], sessionId: string, now: number) => [
  ...inFile.filter(entry => !entry.key.startsWith(`${sessionId}/`) && entry.until > now),
  ...mine,
]

const projects = new Map<string, Map<string, HeadEntry>>()
const searchOff = new Map<string, string>()
const UNTIL_SLACK_MS = 5 * 60_000

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

export const RULES_INVALID = `${RULES_FILE} is not valid JSON. Fix or delete it, then run the Head again.`
export const RULES_TAKEN = `${RULES_FILE} holds your own Command Code rules, and Hydra needs that file to lock Heads down. Move your rules to .commandcode/settings.json (Command Code reads both), then run the Head again.`

/**
 * Writes the project's rules for the Heads running in it, from this session and any other, and deletes the file
 * once none is left, so the person's own Command Code runs never inherit them. Returns why it refused, if it did.
 */
async function writeRules($: EngineInterface, cwd: string): Promise<string | undefined> {
  const path = rulesPath(cwd)
  let inFile: HeadEntry[] = []
  if (await $.fs.exists(path)) {
    let existing: HeadSettings
    try {
      existing = JSON.parse(await $.fs.read(path)) as HeadSettings
    } catch {
      return RULES_INVALID
    }
    if (existing.managedBy !== OWNER) return RULES_TAKEN
    inFile = Array.isArray(existing.hydraHeads) ? existing.hydraHeads : []
  }
  const heads = mergeHeads(inFile, [...(projects.get(cwd)?.values() ?? [])], await $.session.id(), await $.clock.now())
  if (heads.length === 0) {
    searchOff.delete(cwd)
    if (await $.fs.exists(path)) await $.process.run(['/bin/rm', '-f', path])
    await $.process.run(['/bin/rmdir', `${cwd.replace(/\/$/, '')}/.commandcode`]).catch(() => undefined)
    return undefined
  }
  const writeDirs = writeDirsOf(heads)
  const envFile = await findEnvFile($, [cwd, ...heads.reduce<string[]>((dirs, head) => union(dirs, head.addDirs), []), ...writeDirs])
  if (envFile) searchOff.set(cwd, envFile)
  else searchOff.delete(cwd)
  const outsideDeny = await outsideDenyRules($, [cwd, ...writeDirs])
  const settings = { ...headSettings(heads, outsideDeny, Boolean(envFile), guardCommand($.plugin.root, cwd, writeDirs)), hydraHeads: heads }
  await $.fs.write(path, JSON.stringify(settings, null, 2) + '\n')
  const exclude = await $.process.run(['git', '-C', cwd, 'rev-parse', '--git-path', 'info/exclude']).catch(() => null)
  if (exclude?.exitCode === 0) {
    const file = exclude.stdout.trim()
    const excludePath = file.startsWith('/') ? file : `${cwd.replace(/\/$/, '')}/${file}`
    const current = (await $.fs.exists(excludePath)) ? await $.fs.read(excludePath) : ''
    if (!current.split('\n').includes(RULES_FILE)) await $.fs.write(excludePath, `${current.replace(/\n?$/, '\n')}${RULES_FILE}\n`)
  }
  return undefined
}

/**
 * Command Code 1.65 anchors a path rule at `/` or the project, so no rule can name `D:/…`: on a Windows path the
 * outside-the-project deny list cannot be written and a --yolo Head could write anywhere (verified with a live Head).
 */
export const windowsPathRefusal = (cwd: string) =>
  /^[A-Za-z]:|^\\\\|\\/.test(cwd)
    ? `${cwd} is a Windows path, and Command Code cannot deny writes to one (its rules cannot name a drive), so Hydra cannot lock a Head into it. Run Claude Code under WSL instead.`
    : undefined

async function joinProject($: EngineInterface, cwd: string, id: string, needs: HeadNeeds, minutes: number) {
  const unsupported = windowsPathRefusal(cwd)
  if (unsupported) return unsupported
  const heads = projects.get(cwd) ?? new Map<string, HeadEntry>()
  const until = (await $.clock.now()) + minutes * 60_000 + UNTIL_SLACK_MS
  heads.set(id, { ...needs, key: `${await $.session.id()}/${id}`, until })
  projects.set(cwd, heads)
  const refusal = await writeRules($, cwd).catch(error => `Hydra could not write ${RULES_FILE} (${String(error).slice(0, 160)}). Check that the project folder is writable, then run the Head again.`)
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

/** Files written outside the project and outside every folder the Head was let write to. */
export const outsideFiles = (cwd: string, files: readonly string[], writeDirs: readonly string[] = []) =>
  files.filter(file => file.startsWith('/') && ![cwd, ...writeDirs].some(root => isWithin(file, root)))

export const formatReport = (head: {
  id: string; model: string; effort?: string; cwd: string; sessionId?: string; finished: boolean; rounds: number; turns: number;
  usd: number | null; files: string[]; denied: SessionReport['denied']; finalText: string; exit: string; rulesNote?: string; errors?: string
  writeDirs?: readonly string[]
}) => {
  const lines = [
    `head ${head.id} · ${head.model}${head.effort ? ` · effort ${head.effort}` : ''} · ${head.finished ? 'finished' : 'NOT finished'} · exit ${head.exit} · ${head.rounds} round(s) · ${head.turns} turns · $${(head.usd ?? 0).toFixed(4)}`,
    `session ${head.sessionId ?? 'none'} (commandcode --resume ${head.sessionId ?? '<id>'}) · cwd ${head.cwd}`,
  ]
  if (head.rulesNote) lines.push(`rules: ${head.rulesNote}`)
  if (head.writeDirs && head.writeDirs.length > 0) lines.push(`may also write: ${head.writeDirs.join(', ')}`)
  const outside = outsideFiles(head.cwd, head.files, head.writeDirs)
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
  const writeDirs = strings(input.writeDirs)
  const shell = input.shell === true || strings(input.allowShell).length > 0
  const minutes = Number(input.maxMinutes ?? DEFAULT_MINUTES)
  const effort = isHeadEffort(input.effort) ? input.effort : undefined

  const queued: HeadRun = { id, task: task.slice(0, 200), model, state: 'queued', turns: 0, maxTurns, activity: 'waiting for a slot', cwd }
  await update($, runs, list => [...list, queued].slice(-RUN_HISTORY))
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
    return await runHeadInside($, { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort }, signal, limits, id)
  } finally {
    gate.leave()
  }
}

async function runHeadInside(
  $: EngineInterface,
  head: { task: string; cwd: string; model: string; maxTurns: number; addDirs: string[]; writeDirs: string[]; shell: boolean; minutes: number; effort?: string },
  outer: AbortSignal,
  limits: HeadLimits,
  id: string,
) {
  const { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort } = head
  const refusal = await joinProject($, cwd, id, { addDirs, writeDirs, shell }, minutes)
  if (refusal) {
    await setRun($, id, { state: 'failed', endedAt: await $.clock.now(), activity: refusal })
    await refreshStatus($, limits)
    return {
      text: formatReport({
        id, model, cwd, finished: false, rounds: 0, turns: 0, usd: 0, files: [], denied: [], finalText: '',
        exit: 'not started', rulesNote: `${refusal} The Head runs with --yolo, so it never starts without Hydra's rules.`,
      }),
      isDone: false,
    }
  }
  const envFile = searchOff.get(cwd)
  const rulesNote = envFile ? `search tool denied because ${relativeTo(cwd, envFile)} is in reach` : undefined
  try {
    return await runLockedHead($, { task, cwd, model, maxTurns, addDirs: union(addDirs, writeDirs), writeDirs, minutes, rulesNote, effort }, outer, limits, id)
  } finally {
    await leaveProject($, cwd, id)
  }
}

async function runLockedHead(
  $: EngineInterface,
  head: { task: string; cwd: string; model: string; maxTurns: number; addDirs: string[]; writeDirs: string[]; minutes: number; rulesNote?: string; effort?: string },
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
    files: report.files.map(file => relativeTo(cwd, file)), summary: summaryOf(round.finalText),
    activity: isDone ? undefined : timedOut ? `timed out after ${minutes} min` : stopped ?? 'stopped before HEAD DONE',
  })
  void refreshHeads($, limits)

  const text = formatReport({
    id, model, effort: round.effort, cwd, sessionId, finished, rounds, turns, usd: report.usd, files: report.files, denied: report.denied,
    finalText: round.finalText, exit: timedOut ? `timed out after ${minutes} min` : stopped ?? String(round.code ?? round.signal), errors: round.errors,
    rulesNote, writeDirs: head.writeDirs,
  })
  return { text, isDone }
}

export const register: Register = (on, options) => {
  const fiveHourUsd = Number(options.headsFiveHourUsd ?? 0) || 0
  const weeklyUsd = Number(options.headsWeeklyUsd ?? 0) || 0
  const plan = String(options.headsPlan ?? '')
  const defaultHead = String(options.headModel ?? 'deepseek/deepseek-v4.1-flash')
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
    await $.command.register({ name: USAGE_COMMAND, description: 'Hydra: Claude and Command Code usage limits', immediate: true })
    await $.command.register({ name: 'heads', description: 'Hydra: watch the Heads work, live (opens without interrupting Claude)', immediate: true })
    await $.command.register({
      name: 'hydra',
      description: 'Turn on Hydra: Claude leads, Command Code heads implement',
      argumentHint: '[task] [effort=<level>] [head=<model>] | off | status | help',
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
          writeDirs: { type: 'array', items: { type: 'string' }, description: 'Absolute folders outside cwd the Head may also write to, such as the real location of a symlinked package. Only folders the task must change: never /, the home folder or a folder above the project. Their .git, .commandcode and .env files stay protected.' },
          shell: { type: 'boolean', description: 'Give the Head a shell (off by default). Dangerous commands stay denied: destructive git, rm -r/-f, sudo, network tools, builds and installs.' },
          name: { type: 'string', description: 'Short name to track this Head by, saying what it works on (e.g. prefs-utils, login-tests); lowercase letters, digits and dashes, up to 20. Defaults to one made from the task; made unique with -2, -3.' },
          effort: { type: 'string', enum: [...HEAD_EFFORTS], description: 'Reasoning effort for this Head, low to max, picked by task complexity (default high). Ignored while the person has fixed a level with /hydra effort=<level>.' },
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
    const stranded = (await read($, runs)).filter(run => (run.state === 'running' || run.state === 'queued') && run.cwd).map(run => run.cwd!)
    for (const cwd of new Set([...stranded, await $.session.root()])) await writeRules($, cwd).catch(() => undefined)
    await update($, runs, list => stopRuns(list, 'all', 'ended by a reload or restart', startNow))
    void sweepStatusFiles($)
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
    const { action, leadModel, headModel, effort, task, unknown } = parseHydraArgs(e.args)
    const stored = await read($, mode)
    const current = stored ?? { isOn: false, headModel: defaultHead, effort: defaultEffort }
    const currentEffort = stored ? effortModeOf(stored) : defaultEffort

    if (action === 'help') return { text: HYDRA_HELP }
    if (action === 'statusline') return { text: STATUSLINE_HELP }
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

    if (unknown) return { text: `Unknown option "${unknown}". A task needs a few words; /hydra help lists the options.` }
    if (effort !== undefined && !isEffortMode(effort)) return { text: `Unknown effort "${effort}". Use auto (the Lead picks low to max per Head) or one of: ${EFFORTS.join(', ')}.` }
    const next = { isOn: true, headModel: headModel ?? current.headModel, effort: effort ?? currentEffort }
    const check = await preflight($)
    if (check.problems.length > 0) return { text: preflightText(check) }
    if (!(await hasConsent($, next.headModel, true))) return { text: 'Hydra stays off. Run /hydra when you want Heads to work for Claude.' }
    await update($, mode, () => next)
    $.ui.invalidate('tool.describe')
    await refreshStatus($, limits)
    const model = await $.session.model()
    const switchHint = leadModel && !model.toLowerCase().includes(leadModel) ? ` Run /model ${leadModel} to switch the Lead.` : ''
    const changed = current.isOn && next.effort !== currentEffort ? ' Running Heads switch at their next round.' : ''
    const effortText = next.effort === 'auto' ? 'effort auto (Lead picks low to max)' : `effort ${next.effort}`
    const warnings = check.warnings.map(warning => `\n⚠ ${warning}`).join('')
    const text = `🐉 Hydra on · Lead ${model} · Head ${next.headModel} · ${effortText}. /heads to watch, /hydra off to stop.${changed}${switchHint}${warnings}`

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
    if (e.effort !== undefined && !isHeadEffort(e.effort)) return { deny: 'effort must be low, medium, high, xhigh or max.' }
    const cwd = typeof e.cwd === 'string' && e.cwd ? e.cwd : await $.session.root()
    const writable = await resolveWriteDirs($, cwd, strings(e.writeDirs))
    if ('refusal' in writable) return { deny: writable.refusal }
    const input = { ...e, writeDirs: writable.dirs }
    const taken = new Set([...usedNames, ...(await read($, runs)).map(run => run.id)])
    const id = headName(e.name, String(e.task ?? ''), taken)
    usedNames.add(id)
    if (e.background === true) {
      if (!isWorkerRunning) return { deny: 'Hydra is still starting in this session. Try again in a moment, or run this Head without background.' }
      backgroundJobs.push({ input, headModel: hydra.headModel, id })

      return { result: `Head ${id} started in the background on ${hydra.headModel}. Its report arrives as a message from the hydra plugin when it finishes.` }
    }
    if (!isWorkerRunning) {
      const { text } = await runHead($, input, hydra.headModel, next.signal, limits, id)

      return { result: text }
    }
    // Run on the worker's long-lived `$`, so a cancelled call stops the Head cleanly instead of stranding it as running.
    // The hook waits through `$` calls: a hook's own time is capped at 10 s, and a `$` call in flight does not count.
    const { box, reply } = createReplyBox<HeadResult>(next.signal)
    backgroundJobs.push({ input, headModel: hydra.headModel, id, reply })
    const result = await waitForResult(box, next.signal, () => $.process.run(['/bin/sleep', '1'], { timeoutMs: 5_000 }).then(() => undefined))

    return { result: result?.text ?? `Head ${id} keeps running in the background after the call was interrupted; its report arrives as a message from the hydra plugin. Stop it with ${CONTROL_TOOL} if it is no longer wanted.` }
  }).catch(($, e, next) => ({ deny: `Hydra: the Head could not run (${next.error.message ?? next.error.kind}). Run /hydra to check the setup.` }))

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
      if (action === 'on') {
        const check = await preflight($)
        if (check.problems.length > 0) return { deny: preflightText(check) }
        if (!(await hasConsent($, current.headModel, false))) return { deny: 'The person turns Hydra on with /hydra the first time: it asks them to agree to sending code to the Head model.' }
      }
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
  }).catch(($, e, next) => ({ deny: `Hydra control failed (${next.error.message ?? next.error.kind}).` }))

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
    const at = chosen ? list.indexOf(chosen) : -1
    const pickAt = (index: number) => {
      const target = list[Math.max(0, Math.min(list.length - 1, index))]
      if (target) void update($, selected, () => target.id)
    }
    const barWidth = Math.max(10, Math.min(30, e.props.bodyColumns - 24))

    return (
      <Box flexDirection="column">
        <Text bold>🐉 Hydra · {hydra?.isOn ? `${shortModel(hydra.headModel)} · effort ${effortModeOf(hydra)}` : 'off'}</Text>
        <Text dimColor>{list.length > 0 ? `${headsSummary(list)} · 1-9 or j/k to pick a Head, s to stop it` : 'No Heads in this session yet. Claude starts them once Hydra is on (/hydra).'}</Text>
        {list.length > 1 && (
          <Box>
            <Button key="next-head" plain hotkey="j" label="next" onPress={() => pickAt(at + 1)} />
            <Text> </Text>
            <Button key="prev-head" plain hotkey="k" label="previous" onPress={() => pickAt(at - 1)} />
          </Box>
        )}
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
            {chosen.files && chosen.files.length > 0 && (
              <Box marginTop={1}>
                <Text wrap="wrap">edited ({chosen.files.length}): {chosen.files.join(', ')}</Text>
              </Box>
            )}
            {chosen.summary && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Report</Text>
                <Text dimColor wrap="wrap">{chosen.summary}</Text>
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
  })

  on('command.run', { command: USAGE_COMMAND }, async $ => {
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

    const spend = (label: string, usd: number, limit: number, resetsAt: string | null) =>
      limit > 0 ? (
        row(`${label} limit · $${limit.toFixed(2)}`, percentOf(usd, limit), `$${usd.toFixed(2)} ${resetsIn(resetsAt, now)}`)
      ) : (
        <Box key={label} justifyContent="space-between">
          <Text>{label}</Text>
          <Text dimColor>${usd.toFixed(2)} spent</Text>
        </Box>
      )

    return (
      <Box flexDirection="column">
        <Text bold color="#D97757">✳ Lead · Claude</Text>
        {windows.length === 0 && <Text dimColor>No reading yet: limits arrive with the first reply on a subscription.</Text>}
        {windows.map(w => row(leadLabel(w.kind), w.percentUsed, resetsIn(w.resetsAt, now)))}

        <Text bold>⌘ Heads · Command Code</Text>
        <Text dimColor>{plan ? `Plan · ${plan} · ` : ''}estimated from local session costs</Text>
        {!usage && <Text dimColor>Reading ~/.commandcode…</Text>}
        {usage?.error && <Text color="red">{usage.error}</Text>}
        {usage && !usage.error && spend('5-hour', usage.fiveHour.usd, fiveHourUsd, usage.fiveHour.resetsAt)}
        {usage && !usage.error && spend('Weekly', usage.weekly.usd, weeklyUsd, usage.weekly.resetsAt)}
        {usage && !usage.error && (fiveHourUsd <= 0 || weeklyUsd <= 0) && (
          <Box marginBottom={1}>
            <Text dimColor wrap="wrap">Set your Command Code plan's limits in /config (the Hydra rows) to see how close you are.</Text>
          </Box>
        )}

        <Text bold>🐉 Hydra · {hydra?.isOn ? `on · Head ${hydra.headModel} · effort ${effortModeOf(hydra)}` : 'off'}</Text>
        {recent.length > 0 && <Text dimColor>{headsSummary(recent)} · /heads to watch them</Text>}
      </Box>
    )
  })
}
