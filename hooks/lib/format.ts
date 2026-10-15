/**
 * @author Shakib
 * @since 15/10/26
 */
import type { HeadRun, HeadStep, HeadsUsage, HydraMode } from '../../types'
import { effortModeOf } from './effort'
import { DEFAULT_ENGINE, ENGINE_BIN, ENGINE_LABEL, isAuto, isEngine, poolOf } from './engines'
import type { Engine } from './engines'
import { isWithin } from './safety'

export const LIVE_AFTER_END_MS = 60_000

export const WARN_AT = 90

const LEAD_LABELS: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: 'Weekly · all models',
  seven_day_opus: 'Weekly · Opus',
  seven_day_sonnet: 'Weekly · Sonnet',
  seven_day_fable: 'Weekly · Fable',
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

export const colorOf = (percent: number) => (percent >= WARN_AT ? 'red' : percent >= 75 ? 'yellow' : 'blue')

export const percentOf = (usd: number, limit: number) => (limit > 0 ? Math.round((usd / limit) * 1000) / 10 : 0)

export const shortModel = (model: string) => model.split('/').pop() ?? model

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

export const glyphColor = (run: HeadRun) => (run.state === 'running' ? 'cyan' : run.state === 'done' ? 'green' : run.state === 'failed' ? 'red' : undefined)

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
  run.state === 'done' ? `done${run.costUsd !== undefined ? ` · $${run.costUsd.toFixed(4)}` : run.tokens ? ` · ${run.tokens}` : ''}` : run.activity ?? run.state

export type HeadLimits = { fiveHourUsd: number; weeklyUsd: number }

export const CODEBUDDY_NO_SPEND = 'CodeBuddy counts credits, not dollars, so Hydra shows tokens per Head instead of spend.'
export const CODEX_NO_SPEND = 'Codex runs on your ChatGPT plan, not dollars, so Hydra shows tokens per Head instead of spend.'
export const AGY_NO_SPEND = 'Antigravity runs on your Google account quota, not dollars, so Hydra shows tokens per Head instead of spend.'
export const AUTO_NO_SPEND = 'Heads run on engines that count credits, plan usage or quota, not dollars, so Hydra shows tokens per Head instead of spend.'
export const isNoSpend = (error: string | undefined) => error === CODEBUDDY_NO_SPEND || error === CODEX_NO_SPEND || error === AGY_NO_SPEND || error === AUTO_NO_SPEND

/** Shown only while Hydra is on: the Head model and effort, and what Heads spent against their 5-hour and weekly limits. */
export const statusLine = (hydra: HydraMode | null, usage: HeadsUsage | null, limits: HeadLimits) => {
  if (!hydra?.isOn) return undefined
  const parts = [isAuto(hydra)
    ? `🐉 Auto ${poolOf(hydra).join('+')} · ${effortModeOf(hydra)}`
    : `🐉 ${isEngine(hydra.engine) && hydra.engine !== 'commandcode' ? `${ENGINE_LABEL[hydra.engine]} ` : ''}${shortModel(hydra.headModel)} · ${effortModeOf(hydra)}`]
  if (usage && !usage.error) {
    parts.push(`Heads 5h ${spentOf(usage.fiveHour.usd, limits.fiveHourUsd)}`, `7d ${spentOf(usage.weekly.usd, limits.weeklyUsd)}`)
  }
  return parts.join(' | ')
}

/** Spend against a limit, or the spend alone while the person has set no limit (0). */
export const spentOf = (usd: number, limit: number) => (limit > 0 ? `$${usd.toFixed(2)}/$${limit}` : `$${usd.toFixed(2)}`)

/** The events of Command Code's JSON stream the live view reads. */
export type StreamEvent = { type: string; toolCallId?: string; toolName?: string; input?: Record<string, unknown>; isError?: boolean }

export const EDIT_TOOLS = new Set(['edit_file', 'write_file'])
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
        edits: (run.edits ?? 0) + (isOk && !event.isError && EDIT_TOOLS.has(event.toolName ?? '') ? 1 : 0),
        denials: (run.denials ?? 0) + (isOk ? 0 : 1),
      }
    }
    case 'turn_end':
      return { turns: run.turns + 1 }
    default:
      return {}
  }
}

export type SessionReport = { usd: number | null; files: string[]; denied: { tool: string; target: string; text: string }[]; toolCalls: number }

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

/** 91530 and 421 as `91.5k in / 421 out`. */
export const tokensText = (inputTokens: number, outputTokens: number) => {
  const short = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  return `${short(inputTokens)} in / ${short(outputTokens)} out`
}

export const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [])

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
  writeDirs?: readonly string[]; engine?: Engine; tokens?: string
}) => {
  const lines = [
    `head ${head.id} · ${head.model}${head.effort ? ` · effort ${head.effort}` : ''} · ${head.finished ? 'finished' : 'NOT finished'} · exit ${head.exit} · ${head.rounds} round(s) · ${head.turns} turns · ${head.tokens ?? `$${(head.usd ?? 0).toFixed(4)}`}`,
    `session ${head.sessionId ?? 'none'} (${ENGINE_BIN[head.engine ?? DEFAULT_ENGINE]} --resume ${head.sessionId ?? '<id>'}) · cwd ${head.cwd}`,
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
