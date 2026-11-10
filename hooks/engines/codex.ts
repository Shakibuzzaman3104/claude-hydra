/**
 * @author Shakib
 * @since 15/10/26
 */
import type { EngineInterface } from 'claude-code'

import { effortModeOf, headEffort } from '../lib/effort'
import { applyEvent, formatReport, relativeTo, tokensText } from '../lib/format'
import type { SessionReport, StreamEvent } from '../lib/format'
import { createCallCounter, endActivity, exitOf, runRounds } from '../lib/rounds'
import type { RoundSpec } from '../lib/rounds'
import { changedFiles, compareChangedFiles, notStarted, pump, realPaths, refreshHeads, refreshStatus, setRun, snapshotChangedFiles, stopReason, summaryOf } from '../lib/runtime'
import type { Round, RoundArgs } from '../lib/runtime'
import { SECRET_PATHS, homeReadDirs, homeRelative, isSecretPath, isWithin, trimSlash, union } from '../lib/safety'
import type { HeadNeeds } from '../lib/safety'
import type { Guarded } from '../lib/protect'
import { homeOf, toSlashes } from '../lib/platform'
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
          events.push({ type: isDenied ? 'tool_denied' : 'tool_completed', toolCallId: id, toolName: call.tool, isError, ...(item.type === 'file_change' ? { files: (item.changes ?? []).flatMap(change => (change.path ? [change.path] : [])) } : {}) }, { type: 'turn_end' })
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
 * credential folders stay unreadable even when a grant covers them. Among the system temp places only the Head's own temp
 * folder (`tempDir`) is writable, and the shell has no network. More specific paths win, so the order of the entries does
 * not matter.
 *
 * A project that is the home folder itself, or holds it, cannot have its home denied; `homeHeadRefusal` stops those first.
 */
export const codexFilesystem = (cwd: string, head: HeadNeeds, home = '', homeRead: readonly string[] = [], tempDir = '') => {
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
    ...(tempDir ? [[trimSlash(tempDir), 'write'] as [string, string]] : []),
    ...roots.flatMap((dir): [string, string][] => [[`${dir}/**/.env`, 'none'], [`${dir}/**/.env.*`, 'none']]),
    // Codex takes only `none` on a glob, so each `.hydraignore` is made read-only by its exact path.
    ...(head.guarded?.ignoreFiles ?? []).filter(file => writable.some(root => isWithin(file, root))).map((file): [string, string] => [file, 'read']),
    ...(head.guarded?.paths ?? []).filter(path => roots.some(root => isWithin(path, root))).map((path): [string, string] => [path, 'none']),
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
export const codexArgs = (a: RoundArgs & { filesystem: string; baseUrl?: string }) => {
  const args = ['codex', 'exec', ...(a.resume ? ['resume'] : []),
    '--json', '-m', a.model, '--skip-git-repo-check', '--ignore-user-config',
    '-c', 'default_permissions="hydra"', '-c', `permissions.hydra.filesystem=${a.filesystem}`, '-c', 'approval_policy="never"']
  if (a.effort) args.push('-c', `model_reasoning_effort=${tomlString(codexEffort(a.effort))}`)
  if (a.baseUrl) args.push('-c', `openai_base_url=${tomlString(a.baseUrl)}`)
  args.push('--', ...(a.resume ? [a.resume] : []), a.prompt)
  return args
}

async function runRoundCodex(
  $: EngineInterface,
  argv: RoundArgs & { filesystem: string; baseUrl?: string; state: CodexState },
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

type CodexHead = { task: string; cwd: string; model: string; maxTurns: number; addDirs: string[]; writeDirs: string[]; minutes: number; effort?: string; env?: Record<string, string>; guarded?: Guarded; /** An earlier Head's thread to continue. */ resume?: string }

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

/**
 * The git folders a Head in `cwd` needs to read that lie above it: the repository's top level when `cwd` is a subfolder
 * of a monorepo, and the shared `.git` folder of a worktree. Never the home folder itself or a folder above it.
 */
async function gitReadDirs($: EngineInterface, cwd: string, home: string): Promise<string[]> {
  const ran = await $.process.run(['git', '-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { timeoutMs: 10_000 }).catch(() => undefined)
  if (!ran || ran.exitCode !== 0) return []
  const dirs = await realPaths($, ran.stdout.split('\n').map(line => line.trim()).filter(Boolean))
  // Inside the project they are readable already; one that holds the home folder would open all of it.
  return dirs.filter(dir => !isWithin(dir, cwd) && !(home && isWithin(home, dir)))
}

/** How Codex refuses a model the person's ChatGPT plan does not include. */
export const CODEX_PLAN_REFUSAL = /not supported when using Codex with a ChatGPT account/i

/** The Codex model every ChatGPT plan runs; a Head falls back to it when its model is refused. */
export const CODEX_PLAN_MODEL = 'gpt-6-luna'

/** Models this session's ChatGPT plan refused: later Heads start on `CODEX_PLAN_MODEL` without trying them again. */
const refusedOnPlan = new Set<string>()

const planWarning = (model: string) => `${model} is not available on this ChatGPT plan, so the Head ran on ${CODEX_PLAN_MODEL}. Check its work as you would a lighter model's, or set head=${CODEX_PLAN_MODEL}.`

/** The system temp folder (`TMPDIR`, as `os.tmpdir()` reads it), and `/tmp` where the host sets none. */
async function codexTempRoot($: EngineInterface) {
  return trimSlash(toSlashes((await $.env.get('TMPDIR')) || '/tmp'))
}

const CODEX_TEMP_PREFIX = 'hydra-codex-'

/** Makes this Head's private temp folder, under the system temp folder and owner-only. Returns its path. */
async function makeCodexTemp($: EngineInterface, id: string): Promise<string> {
  const dir = `${await codexTempRoot($)}/${CODEX_TEMP_PREFIX}${await $.session.id()}-${id}`
  await $.process.run(['/bin/mkdir', '-p', dir])
  await $.process.run(['/bin/chmod', '700', dir])
  return dir
}

/** Removes a Head's temp folder; refuses any path that is not one of Hydra's own. */
export async function removeCodexTemp($: EngineInterface, dir: string) {
  if (dir.includes(`/${CODEX_TEMP_PREFIX}`)) await $.process.run(['/bin/rm', '-rf', dir]).catch(() => undefined)
}

/** Temp folders a crashed session left behind: a Head never runs for a day. */
export async function sweepCodexTemps($: EngineInterface) {
  const root = await codexTempRoot($)
  const now = await $.clock.now()
  const entries = await $.fs.list(root).catch(() => [])
  for (const entry of entries) {
    if (entry.kind === 'dir' && entry.name.startsWith(CODEX_TEMP_PREFIX)) {
      const stat = await $.fs.stat(`${root}/${entry.name}`).catch(() => undefined)
      if (stat && now - stat.mtimeMs > 86_400_000) await removeCodexTemp($, `${root}/${entry.name}`)
    }
  }
}

/**
 * A Codex Head's environment: the person's own for the engine, and `TMPDIR` at the Head's private folder. macOS's
 * `/usr/bin/git` is an xcrun shim that needs a writable temp folder, and the sandbox writes nowhere else in `/tmp`.
 */
export const codexEnv = (tempDir: string, env: Record<string, string> = {}) => ({ ...env, TMPDIR: `${tempDir}/` })

/** The top-level `openai_base_url` of a Codex config (an API-key gateway), which `--ignore-user-config` would drop. */
export const codexBaseUrl = (config: string) => /^[ \t]*openai_base_url[ \t]*=[ \t]*"([^"]+)"/m.exec(config.split(/^[ \t]*\[/m)[0] ?? '')?.[1]

/** A Head on Codex: a filesystem profile on the command line (no file to clean up), then rounds until it reports HEAD DONE. */
export async function runCodexHead($: EngineInterface, head: CodexHead, outer: AbortSignal, id: string) {
  const { cwd, model } = head
  if (/^[A-Za-z]:|^\\\\|\\/.test(cwd)) {
    const refusal = `${cwd} is a Windows path, and Hydra's rules use POSIX paths. Run Claude Code under WSL instead.`
    await setRun($, id, { state: 'failed', endedAt: await $.clock.now(), activity: refusal })
    await refreshStatus($)
    return notStarted(id, model, cwd, `${refusal} A Head never starts without Hydra's rules.`, 'codex', 'unavailable')
  }
  const [realCwd] = await realPaths($, [cwd])
  const writeDirs = await realPaths($, head.writeDirs)
  const home = await homeOf($)
  const [realHome] = home ? await realPaths($, [home]) : ['']
  if (!realHome) {
    const refusal = 'Hydra cannot find your home folder (HOME is empty), so it cannot close it to a Codex Head.'
    await setRun($, id, { state: 'failed', endedAt: await $.clock.now(), activity: refusal })
    await refreshStatus($)
    return notStarted(id, model, cwd, `${refusal} A Head never starts without Hydra's rules.`, 'codex', 'unavailable')
  }
  const homeRead = realHome ? await homeReadDirs($, realHome) : []
  const repoDirs = await gitReadDirs($, realCwd!, realHome)
  const tempDir = await makeCodexTemp($, id)
  const filesystem = codexFilesystem(realCwd!, { addDirs: union(await realPaths($, head.addDirs), repoDirs), writeDirs, shell: true, guarded: head.guarded }, realHome, homeRead, tempDir)
  const baseUrl = codexBaseUrl(await $.fs.read(`${head.env?.CODEX_HOME ?? `${realHome}/.codex`}/config.toml`).catch(() => ''))
  try {
    return await runCodexRounds($, head, filesystem, baseUrl, tempDir, outer, id)
  } finally {
    await removeCodexTemp($, tempDir)
  }
}

async function runCodexRounds($: EngineInterface, head: CodexHead, filesystem: string, baseUrl: string | undefined, tempDir: string, outer: AbortSignal, id: string) {
  const { task, cwd, maxTurns, minutes } = head
  let model = refusedOnPlan.has(head.model) ? CODEX_PLAN_MODEL : head.model
  const warnings: string[] = model === head.model ? [] : [planWarning(head.model)]
  // Read each round, so a /hydra effort change reaches a running Head at its next round.
  const effortNow = async () => headEffort(effortModeOf(await readMode($)), head.effort)

  const startedAt = await $.clock.now()
  await snapshotChangedFiles($, id, [cwd, ...head.writeDirs])
  const mountPoints = await missingMountPoints($, [cwd, ...head.writeDirs])
  const state = newCodexState()
  const labels = new Map<string, string>()
  const counter = createCallCounter()
  const onEvent = async (event: StreamEvent) => {
    counter.see(event)
    await setRun($, id, run => applyEvent(run, event, labels, cwd))
  }
  const roundOn = async (round: RoundSpec, signal: AbortSignal) => {
    const effort = await effortNow()
    await setRun($, id, { effort })
    const ran = await runRoundCodex($, { ...round, model, effort, cwd, addDirs: head.addDirs, filesystem, baseUrl, state, env: codexEnv(tempDir, head.env) }, signal, onEvent)
    return { ...ran, effort }
  }
  const runRound = async (round: RoundSpec, signal: AbortSignal) => {
    const ran = await roundOn(round, signal)
    if (model === CODEX_PLAN_MODEL || !CODEX_PLAN_REFUSAL.test(ran.errors ?? '')) return ran
    // The person's ChatGPT plan does not offer this model: run the Head on the one every plan has, and remember it for the session.
    refusedOnPlan.add(model)
    warnings.push(planWarning(model))
    model = CODEX_PLAN_MODEL
    Object.assign(state, { threadId: undefined, failure: undefined, lastError: undefined })
    await setRun($, id, { model })
    return roundOn(round, signal)
  }

  const ended = await runRounds({
    task, maxTurns, minutes, outer, resume: head.resume, runRound,
    turns: () => state.turns,
    calls: () => counter.calls,
    denied: () => state.denied.map(d => `${d.tool} ${d.target}`.slice(0, 160)),
    sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
    onStep: activity => setRun($, id, { activity }),
  })
  const { round, rounds, sessionId, ending } = ended

  // `rmdir` only removes an empty folder, so one the Head filled (or another Head is using) stays.
  if (mountPoints.length > 0) await $.process.run(['/bin/rmdir', ...mountPoints]).catch(() => undefined)
  const files = union([...state.files], await changedFiles($, startedAt, [cwd, ...head.writeDirs]))
  const endedAt = await $.clock.now()
  const edits = await compareChangedFiles($, id, { cwd, startedAt, endedAt }, [cwd, ...head.writeDirs])
  const tokens = tokensText(state.inputTokens, state.outputTokens)
  const isDone = ending === 'done'
  const stopped = outer.aborted ? stopReason(outer) : undefined
  await setRun($, id, {
    state: isDone ? 'done' : 'failed', turns: state.turns, tokens, endedAt, ending, sessionId,
    files: files.map(file => relativeTo(cwd, file)), summary: summaryOf(round.finalText),
    activity: endActivity(ended, { maxTurns, minutes, stopped }),
  })
  void refreshHeads($)

  const text = formatReport({
    id, model, effort: round.effort, cwd, sessionId, finished: isDone, ending, cap: ended.cap, maxTurns, rounds, turns: state.turns, usd: null, files, denied: state.denied,
    finalText: round.finalText, exit: exitOf(ended, { minutes, stopped }), errors: round.errors,
    writeDirs: head.writeDirs, engine: 'codex', tokens, warnings, startedAt, endedAt,
    reverted: edits.reverted, restored: edits.restored, overwritten: edits.overwritten, alsoRan: edits.alsoRan,
  })
  return { text, isDone, failure: isDone ? undefined : round.errors, files, ending, sessionId }
}
