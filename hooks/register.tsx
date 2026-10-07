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
- Independent tasks on disjoint files go out as parallel ${HEAD_TOOL} calls; dependent ones in sequence.
- Keep the judgement-heavy part yourself: architecture, tricky bugs, anything under ~20 lines.
- Never trust a Head's report. Read the diff and run the build/tests yourself, then fix it or send the Head back with precise feedback.
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
) => {
  const parts: string[] = []
  const short = (kind: string) => (kind === 'five_hour' ? '5h' : kind === 'seven_day' ? 'wk' : kind.replace('seven_day_', 'wk·'))
  if (hydra?.isOn) parts.push(`🐉 Hydra · ${shortModel(hydra.headModel)}${running > 0 ? ` · ${running} running` : ''}`)
  if (windows.length > 0) parts.push(`Lead ${windows.map(w => `${short(w.kind)} ${Math.round(w.percentUsed)}%`).join(' ')}`)
  if (usage && !usage.error) parts.push(`Heads 5h $${usage.fiveHour.usd.toFixed(2)}/$${fiveHourUsd}`)
  return parts.length > 0 ? parts.join(' │ ') : undefined
}

async function refreshStatus($: EngineInterface, fiveHourUsd: number) {
  const running = (await read($, runs)).filter(run => run.state === 'running').length
  $.ui.status(statusLine(await read($, lead), await read($, heads), fiveHourUsd, await read($, mode), running))
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

async function sessionCost($: EngineInterface, sessionId: string) {
  try {
    const ran = await $.process.run(['/usr/bin/env', 'python3', '-I', `${$.plugin.root}/bin/cc-usage.py`, '--session', sessionId])
    return (JSON.parse(ran.stdout) as { usd: number | null }).usd ?? undefined
  } catch {
    return undefined
  }
}

async function runHead($: EngineInterface, input: Record<string, unknown>, headModel: string, signal: AbortSignal, fiveHourUsd: number) {
  const task = String(input.task ?? '').trim()
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : await $.session.root()
  const model = typeof input.model === 'string' && input.model ? input.model : headModel
  const maxTurns = Number(input.maxTurns ?? 60)
  const id = String(input.tool_use_id ?? (await $.clock.now()))

  await update($, runs, list => [...list, { id, task: task.slice(0, 80), model, state: 'running' as const, turns: 0 }].slice(-12))
  await refreshStatus($, fiveHourUsd)

  const child = $.process.spawn({
    argv: ['/usr/bin/env', 'commandcode', '-p', task, '-m', model, '--max-turns', String(maxTurns),
      '--output-format', 'json', '--skip-onboarding', '--permission-mode', 'auto-accept'],
    cwd,
  })
  let pending = ''
  let errors = ''
  let turns = 0
  let result: Record<string, unknown> | null = null
  const take = async (line: string) => {
    if (!line.trim().startsWith('{')) return
    try {
      const row = JSON.parse(line) as { type?: string; event?: { type?: string } }
      if (row.type === 'result') result = row as Record<string, unknown>
      if (row.event?.type === 'turn_end') {
        turns++
        await setRun($, id, { turns })
        $.ui.status(`🐉 Head ${shortModel(model)} · turn ${turns} · ${task.slice(0, 40)}`)
      }
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
  const sessionId = typeof final?.sessionId === 'string' ? final.sessionId : undefined
  const costUsd = sessionId ? await sessionCost($, sessionId) : undefined
  const isDone = exit.code === 0 && final?.subtype === 'success'
  await setRun($, id, { state: isDone ? 'done' : 'failed', turns, costUsd })
  void refreshHeads($, fiveHourUsd)

  const changes = await $.process.run(['git', '-C', cwd, 'status', '--short']).catch(() => null)
  const lines = [
    `head: ${model}  exit=${exit.code ?? exit.signal}  status=${String(final?.subtype ?? 'no-result')}  turns=${turns}  cost=$${(costUsd ?? 0).toFixed(4)}`,
    `session: ${sessionId ?? 'none'} (resume with: commandcode --resume ${sessionId ?? '<id>'})  cwd: ${cwd}`,
    '--- head report ---',
    String(final?.finalText ?? '(no final report)').trim().slice(-8000),
  ]
  if (changes && changes.exitCode === 0) lines.push('--- git status ---', changes.stdout.trim() || '(clean)')
  if (!isDone && errors.trim()) lines.push('--- stderr ---', errors.trim())

  return { text: lines.join('\n'), isDone }
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
      description: 'Hydra: run one Command Code Head (a cheaper coding agent) headlessly on a self-contained implementation task and return its report, cost and git status. Usable only while the person has Hydra on.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Self-contained spec: goal, exact files, constraints, acceptance check' },
          cwd: { type: 'string', description: 'Repo directory to work in; defaults to the session root' },
          model: { type: 'string', description: 'Command Code model id; defaults to the Hydra head model' },
          maxTurns: { type: 'number', description: 'Turn cap for the Head (default 60)' },
        },
        required: ['task'],
      },
    })
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

    if (leadModel) await $.command.run({ command: 'model', args: leadModel })
    const next = { isOn: true, headModel: headModel ?? current.headModel }
    await update($, mode, () => next)
    $.ui.invalidate('tool.describe')
    await refreshStatus($, fiveHourUsd)
    if (task) void $.prompt.submit({ text: task, asUser: true })

    return { text: `🐉 Hydra on · Lead ${await $.session.model()} · Head ${next.headModel}. /hydra off to stop.` }
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
    const { text } = await runHead($, e, hydra.headModel, next.signal, fiveHourUsd)

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
