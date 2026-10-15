/**
 * @author Shakib
 * @since 15/10/26
 */
import type { EngineInterface } from 'claude-code'

import { effortModeOf, headEffort } from '../lib/effort'
import { applyEvent, formatReport, relativeTo, tokensText } from '../lib/format'
import type { HeadLimits, SessionReport, StreamEvent } from '../lib/format'
import { HEAD_RULES, MAX_ROUNDS, START_RETRIES, changedFiles, continuePrompt, isFinished, isResumable, notStarted, pump, realPaths, refreshHeads, refreshStatus, setRun, stopReason, summaryOf } from '../lib/runtime'
import type { Round, RoundArgs } from '../lib/runtime'
import { SECRET_PATHS, homeReadDirs, homeRelative, isSecretPath, isWithin, trimSlash, union } from '../lib/safety'
import type { HeadNeeds } from '../lib/safety'
import { homeOf } from '../lib/platform'
import { readMode } from '../lib/state'

/** Codex item types as the tool names Command Code's stream uses, so one live view reads every engine. */
const CODEX_TOOLS: Record<string, string> = { command_execution: 'shell_command', file_change: 'edit_file', web_search: 'web_search' }

/** How a command fails when Codex's sandbox refuses it: the kernel's wording for a blocked read or write. */
const CODEX_DENIAL = /permission denied|read-only file system|operation not permitted|EACCES|EROFS|blocked by/i

type CodexItem = {
  id?: string; type?: string; text?: string; command?: string; exit_code?: number | null; status?: string
  aggregated_output?: string; changes?: { path?: string; kind?: string }[]; server?: string; tool?: string; query?: string
}
export type CodexRow = {
  type?: string
  thread_id?: string
  item?: CodexItem
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { message?: string }
  message?: string
}

/** What a Codex Head did, accumulated from its stream: tool calls (its turns), files named in patches, refused commands, tokens. */
export type CodexState = {
  calls: Map<string, { tool: string; input: Record<string, unknown> }>
  files: Set<string>
  denied: SessionReport['denied']
  turns: number
  inputTokens: number
  outputTokens: number
  finalText: string
  threadId?: string
  failure?: string
  /** The last stream-level `error` row: Codex also sends these for retries it recovers from, so it counts only when no turn completed. */
  lastError?: string
  isCompleted: boolean
}

export const newCodexState = (): CodexState => ({ calls: new Map(), files: new Set(), denied: [], turns: 0, inputTokens: 0, outputTokens: 0, finalText: '', isCompleted: false })

const codexToolOf = (item: CodexItem) =>
  item.type === 'mcp_tool_call' ? `${item.server ?? 'mcp'}.${item.tool ?? 'tool'}` : CODEX_TOOLS[item.type ?? '']

/**
 * Folds one line of `codex exec --json` into `state` and returns the live-view events it stands for. Codex does not number
 * model messages, so a turn is one finished tool call (a command, a patch, an MCP or search call).
 */
export const foldCodexRow = (row: CodexRow, state: CodexState): StreamEvent[] => {
  const events: StreamEvent[] = []
  if (row.type === 'thread.started' && typeof row.thread_id === 'string') state.threadId = row.thread_id
  else if (row.type === 'turn.completed') {
    state.isCompleted = true
    state.inputTokens += row.usage?.input_tokens ?? 0
    state.outputTokens += row.usage?.output_tokens ?? 0
  } else if (row.type === 'turn.failed') {
    state.failure = row.error?.message ?? row.message ?? 'Codex reported an error'
  } else if (row.type === 'error') {
    state.lastError = row.error?.message ?? row.message ?? 'Codex reported an error'
  } else if ((row.type === 'item.started' || row.type === 'item.completed') && row.item) {
    const item = row.item
    const isDone = row.type === 'item.completed'
    if (item.type === 'reasoning') events.push({ type: 'thinking_start' })
    else if (item.type === 'agent_message' && isDone && typeof item.text === 'string') state.finalText = item.text
    else {
      const tool = codexToolOf(item)
      const id = item.id
      if (tool && id) {
        if (!state.calls.has(id)) {
          const input: Record<string, unknown> = item.type === 'command_execution' ? { command: item.command ?? '' }
            : item.type === 'file_change' ? { file_path: item.changes?.[0]?.path ?? '' }
            : item.type === 'web_search' ? { pattern: item.query ?? '' } : {}
          state.calls.set(id, { tool, input })
          events.push({ type: 'tool_queued', toolCallId: id, toolName: tool, input }, { type: 'tool_running', toolCallId: id, toolName: tool })
        }
        if (isDone) {
          const call = state.calls.get(id)!
          const output = item.aggregated_output ?? ''
          const isError = item.type === 'command_execution' ? item.exit_code !== 0 && item.exit_code !== null && item.exit_code !== undefined : item.status === 'failed'
          const isDenied = isError && item.type === 'command_execution' && CODEX_DENIAL.test(output)
          if (isDenied) state.denied.push({ tool: call.tool, target: String(item.command ?? ''), text: output.replace(/\s+/g, ' ').trim() })
          else if (!isError && item.type === 'file_change') for (const change of item.changes ?? []) if (change.path) state.files.add(change.path)
          events.push({ type: isDenied ? 'tool_denied' : 'tool_completed', toolCallId: id, toolName: call.tool, isError }, { type: 'turn_end' })
          state.turns++
        }
      }
    }
  }
  return events
}

/** Codex takes low to max; Hydra's `off` is its `low`. */
export const codexEffort = (effort: string) => (effort === 'off' ? 'low' : effort)

const tomlString = (value: string) => JSON.stringify(value)

/**
 * The filesystem profile one Codex Head runs under, as the inline TOML table for `-c permissions.hydra.filesystem=…`.
 * The system is readable (compilers, `/usr`, `/opt`), but the person's home folder is not: inside it a Head reads only
 * the project, the folders it was given (`addDirs`, `writeDirs`) and the toolchain folders in `homeRead` (git's config,
 * node, cargo, gradle…), which `homeReadDirs` filters to the ones that exist. The project and each writeDir are writable
 * (Codex keeps `.git` read-only inside them), `.env` files are unreadable under every folder the Head may touch, and the
 * credential folders stay unreadable even when a grant covers them. `/tmp` and sibling folders are not writable, and the
 * shell has no network. More specific paths win, so the order of the entries does not matter.
 *
 * A project that is the home folder itself, or holds it, cannot have its home denied; `homeHeadRefusal` stops those first.
 */
export const codexFilesystem = (cwd: string, head: HeadNeeds, home = '', homeRead: readonly string[] = []) => {
  const homeDir = home ? trimSlash(home) : ''
  const isSecret = (dir: string) => {
    const rel = homeDir ? homeRelative(dir, homeDir) : undefined
    return rel !== undefined && isSecretPath(rel)
  }
  const writable = [cwd, ...(head.writeDirs ?? [])].map(trimSlash).filter(dir => dir === trimSlash(cwd) || !isSecret(dir))
  const readable = head.addDirs.map(trimSlash).filter(dir => !isSecret(dir) && !writable.some(root => isWithin(dir, root)))
  const roots = union(writable, readable)
  const isHomeClosed = homeDir !== '' && !writable.some(dir => isWithin(homeDir, dir))
  const entries: [string, string][] = [
    ['/', 'read'],
    ...(isHomeClosed ? [[homeDir, 'none'] as [string, string], ...homeRead.map((dir): [string, string] => [`${homeDir}/${dir}`, 'read'])] : []),
    ...readable.map((dir): [string, string] => [dir, 'read']),
    ...writable.map((dir): [string, string] => [dir, 'write']),
    ...roots.flatMap((dir): [string, string][] => [[`${dir}/**/.env`, 'none'], [`${dir}/**/.env.*`, 'none']]),
    ...(homeDir ? SECRET_PATHS.map((dir): [string, string] => [`${homeDir}/${dir}`, 'none']) : []),
  ]
  // Codex refuses a profile that names a path twice; where two entries meet, the stricter access stands.
  const rank: Record<string, number> = { read: 0, write: 1, none: 2 }
  const profile = new Map<string, string>()
  for (const [path, access] of entries) {
    const held = profile.get(path)
    if (held === undefined || rank[access]! > rank[held]!) profile.set(path, access)
  }
  return `{${[...profile].map(([path, access]) => `${tomlString(path)}=${tomlString(access)}`).join(',')},glob_scan_max_depth=6}`
}

/**
 * The Codex command line for one round. Hydra starts it with stdin closed (otherwise `codex exec` waits for more prompt text),
 * `--ignore-user-config` keeps the person's own Codex settings out of a Head, and `approval_policy="never"` means a refused
 * command simply fails. The first round starts a thread; later rounds `resume` it under the same profile.
 */
export const codexArgs = (a: RoundArgs & { filesystem: string }) => {
  const args = ['codex', 'exec', ...(a.resume ? ['resume'] : []),
    '--json', '-m', a.model, '--skip-git-repo-check', '--ignore-user-config',
    '-c', 'default_permissions="hydra"', '-c', `permissions.hydra.filesystem=${a.filesystem}`, '-c', 'approval_policy="never"']
  if (a.effort) args.push('-c', `model_reasoning_effort=${tomlString(codexEffort(a.effort))}`)
  args.push('--', ...(a.resume ? [a.resume] : []), a.prompt)
  return args
}

async function runRoundCodex(
  $: EngineInterface,
  argv: RoundArgs & { filesystem: string; state: CodexState },
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => Promise<void>,
): Promise<Round> {
  const { state } = argv
  state.finalText = ''
  state.failure = undefined
  state.isCompleted = false
  const turnsBefore = state.turns
  let isCapped = false
  const { errors, exit } = await pump($, codexArgs(argv), argv.cwd, signal, async line => {
    if (!line.trim().startsWith('{')) return false
    let row: CodexRow
    try {
      row = JSON.parse(line) as CodexRow
    } catch {
      return false // A partial or non-JSON line; the thread and turn rows are what count.
    }
    for (const event of foldCodexRow(row, state)) await onEvent(event)
    if (state.turns - turnsBefore > argv.maxTurns) isCapped = true
    return isCapped
  }, argv.env)
  return {
    finalText: state.finalText,
    sessionId: state.threadId,
    subtype: state.failure ? 'error' : isCapped ? 'error_max_turns' : state.isCompleted ? 'success' : state.lastError ? 'error' : undefined,
    code: isCapped ? 8 : exit.code,
    signal: exit.signal,
    errors: [state.failure ?? (state.isCompleted ? undefined : state.lastError), errors].filter(Boolean).join('\n').slice(-2000),
  }
}

type CodexHead = { task: string; cwd: string; model: string; maxTurns: number; addDirs: string[]; writeDirs: string[]; minutes: number; effort?: string; env?: Record<string, string> }

/** Empty folders Codex's sandbox leaves in a writable root as mount points for the paths it protects. */
const CODEX_MOUNT_POINTS = ['.agents', '.aws', '.codex']

/** The mount-point folders that do not exist yet in each root: after the Head, the empty ones among them are removed. */
async function missingMountPoints($: EngineInterface, roots: readonly string[]): Promise<string[]> {
  const missing: string[] = []
  for (const root of roots) {
    for (const name of CODEX_MOUNT_POINTS) {
      const path = `${trimSlash(root)}/${name}`
      if (!(await $.fs.exists(path).catch(() => true))) missing.push(path)
    }
  }
  return missing
}

/** A Head on Codex: a filesystem profile on the command line (no file to clean up), then rounds until it reports HEAD DONE. */
export async function runCodexHead($: EngineInterface, head: CodexHead, outer: AbortSignal, limits: HeadLimits, id: string) {
  const { cwd, model } = head
  if (/^[A-Za-z]:|^\\\\|\\/.test(cwd)) {
    const refusal = `${cwd} is a Windows path, and Hydra's rules use POSIX paths. Run Claude Code under WSL instead.`
    await setRun($, id, { state: 'failed', endedAt: await $.clock.now(), activity: refusal })
    await refreshStatus($, limits)
    return notStarted(id, model, cwd, `${refusal} A Head never starts without Hydra's rules.`, 'codex')
  }
  const [realCwd] = await realPaths($, [cwd])
  const writeDirs = await realPaths($, head.writeDirs)
  const home = await homeOf($)
  const [realHome] = home ? await realPaths($, [home]) : ['']
  if (!realHome) {
    const refusal = 'Hydra cannot find your home folder (HOME is empty), so it cannot close it to a Codex Head.'
    await setRun($, id, { state: 'failed', endedAt: await $.clock.now(), activity: refusal })
    await refreshStatus($, limits)
    return notStarted(id, model, cwd, `${refusal} A Head never starts without Hydra's rules.`, 'codex')
  }
  const homeRead = realHome ? await homeReadDirs($, realHome) : []
  const filesystem = codexFilesystem(realCwd!, { addDirs: await realPaths($, head.addDirs), writeDirs, shell: true }, realHome, homeRead)
  return runCodexRounds($, head, filesystem, outer, limits, id)
}

async function runCodexRounds($: EngineInterface, head: CodexHead, filesystem: string, outer: AbortSignal, limits: HeadLimits, id: string) {
  const { task, cwd, model, maxTurns, minutes } = head
  // Read each round, so a /hydra effort change reaches a running Head at its next round.
  const effortNow = async () => headEffort(effortModeOf(await readMode($)), head.effort)
  const controller = new AbortController()
  if (outer.aborted) controller.abort()
  else outer.addEventListener('abort', () => controller.abort(), { once: true })
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

  const startedAt = await $.clock.now()
  const mountPoints = await missingMountPoints($, [cwd, ...head.writeDirs])
  const state = newCodexState()
  const labels = new Map<string, string>()
  const onEvent = async (event: StreamEvent) => {
    await setRun($, id, run => applyEvent(run, event, labels, cwd))
  }
  const roundAt = async (round: { prompt: string; maxTurns: number; resume?: string }) => {
    const effort = await effortNow()
    await setRun($, id, { effort })
    const ran = await runRoundCodex($, { ...round, model, effort, cwd, addDirs: head.addDirs, filesystem, state, env: head.env }, signal, onEvent)
    return { ...ran, effort }
  }

  let round = await roundAt({ prompt: task + HEAD_RULES, maxTurns })
  for (let attempt = 1; !round.sessionId && !signal.aborted && attempt <= START_RETRIES; attempt++) {
    await $.clock.sleep(attempt * 5_000, { signal }).catch(() => undefined)
    round = await roundAt({ prompt: task + HEAD_RULES, maxTurns })
  }
  const sessionId = round.sessionId
  let rounds = 1
  while (!signal.aborted && sessionId && isResumable(round.code) && !isFinished(round.finalText) && rounds < MAX_ROUNDS && state.turns < maxTurns) {
    const denied = state.denied.map(d => `${d.tool} ${d.target}`.slice(0, 160))
    await setRun($, id, { activity: `resuming (round ${rounds + 1})` })
    round = await roundAt({ prompt: continuePrompt(denied), maxTurns: maxTurns - state.turns, resume: sessionId })
    rounds++
  }

  timerStop.abort()
  // `rmdir` only removes an empty folder, so one the Head filled (or another Head is using) stays.
  if (mountPoints.length > 0) await $.process.run(['/bin/rmdir', ...mountPoints]).catch(() => undefined)
  const files = union([...state.files], await changedFiles($, startedAt, [cwd, ...head.writeDirs]))
  const tokens = tokensText(state.inputTokens, state.outputTokens)
  const finished = isFinished(round.finalText)
  const isDone = round.code === 0 && round.subtype === 'success' && finished
  const stopped = outer.aborted ? stopReason(outer) : undefined
  await setRun($, id, {
    state: isDone ? 'done' : 'failed', turns: state.turns, tokens, endedAt: await $.clock.now(),
    files: files.map(file => relativeTo(cwd, file)), summary: summaryOf(round.finalText),
    activity: isDone ? undefined : timedOut ? `timed out after ${minutes} min` : stopped ?? (round.subtype === 'error_max_turns' ? `stopped at the ${maxTurns}-turn cap` : 'stopped before HEAD DONE'),
  })
  void refreshHeads($, limits)

  const text = formatReport({
    id, model, effort: round.effort, cwd, sessionId, finished, rounds, turns: state.turns, usd: null, files, denied: state.denied,
    finalText: round.finalText, exit: timedOut ? `timed out after ${minutes} min` : stopped ?? String(round.code ?? round.signal), errors: round.errors,
    writeDirs: head.writeDirs, engine: 'codex', tokens,
  })
  return { text, isDone, failure: isDone ? undefined : round.errors, files }
}
