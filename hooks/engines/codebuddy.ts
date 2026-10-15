/**
 * @author Shakib
 * @since 15/10/26
 */
import type { EngineInterface } from 'claude-code'

import { effortModeOf, headEffort } from '../lib/effort'
import { EDIT_TOOLS, applyEvent, formatReport, relativeTo, tokensText } from '../lib/format'
import type { HeadLimits, SessionReport, StreamEvent } from '../lib/format'
import { HEAD_RULES, MAX_ROUNDS, START_RETRIES, continuePrompt, isFinished, isResumable, notStarted, pump, refreshHeads, refreshStatus, setRun, stopReason, summaryOf } from '../lib/runtime'
import type { Round, RoundArgs } from '../lib/runtime'
import { DANGEROUS_SHELL, SECRET_PATHS, guardCommand, isWithin, trimSlash, union } from '../lib/safety'
import type { HeadNeeds } from '../lib/safety'
import { homeOf } from '../lib/platform'
import { readMode } from '../lib/state'

/** CodeBuddy tool names as the names Command Code's stream uses, so one live view reads both engines. */
const BUDDY_TOOLS: Record<string, string> = {
  Read: 'read_file', Edit: 'edit_file', MultiEdit: 'edit_file', NotebookEdit: 'edit_file', Write: 'write_file',
  Bash: 'shell_command', Grep: 'grep', Glob: 'glob', LS: 'read_directory',
}

/** How CodeBuddy words a refused call in headless mode, and how Hydra's write guard words its own. */
const BUDDY_DENIAL = /has been denied|requires approval|permission prompts are not available|blocked by|outside the project|write guard/i

/** What a CodeBuddy Head did, accumulated from its stream: the turns it took, files it edited, calls refused, tokens used. */
export type BuddyState = {
  messages: Set<string>
  calls: Map<string, { tool: string; input: Record<string, unknown> }>
  files: Set<string>
  denied: SessionReport['denied']
  inputTokens: number
  outputTokens: number
}

export const newBuddyState = (): BuddyState => ({ messages: new Set(), calls: new Map(), files: new Set(), denied: [], inputTokens: 0, outputTokens: 0 })

type BuddyBlock = { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean; content?: unknown }
export type BuddyRow = {
  type?: string
  subtype?: string
  session_id?: string
  message?: { id?: string; content?: unknown }
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
  result?: string
  [key: string]: unknown
}

const blockText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(part => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '')).join(' ')
      : ''

/**
 * Folds one line of CodeBuddy's `stream-json` into `state` and returns the live-view events it stands for: a new model
 * message is a turn, a `tool_use` block a queued and running call, a `tool_result` a finished or refused one.
 */
export const foldBuddyRow = (row: BuddyRow, state: BuddyState): StreamEvent[] => {
  const events: StreamEvent[] = []
  const content = row.message?.content
  if (!Array.isArray(content)) return events
  if (row.type === 'assistant') {
    const id = row.message?.id
    if (id && !state.messages.has(id)) {
      state.messages.add(id)
      events.push({ type: 'turn_end' })
    }
    for (const block of content as BuddyBlock[]) {
      if (block.type === 'thinking') events.push({ type: 'thinking_start' })
      if (block.type === 'tool_use' && block.id && block.name) {
        const tool = BUDDY_TOOLS[block.name] ?? block.name.toLowerCase()
        const input = block.input ?? {}
        state.calls.set(block.id, { tool, input })
        events.push({ type: 'tool_queued', toolCallId: block.id, toolName: tool, input }, { type: 'tool_running', toolCallId: block.id, toolName: tool })
      }
    }
  } else if (row.type === 'user') {
    for (const block of content as BuddyBlock[]) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue
      const call = state.calls.get(block.tool_use_id)
      const text = blockText(block.content)
      const isDenied = block.is_error === true && BUDDY_DENIAL.test(text)
      const path = call?.input.file_path ?? call?.input.notebook_path
      if (isDenied) {
        state.denied.push({ tool: call?.tool ?? 'tool', target: String(path ?? call?.input.path ?? call?.input.command ?? ''), text: text.replace(/\s+/g, ' ').trim() })
      } else if (!block.is_error && call && EDIT_TOOLS.has(call.tool) && typeof path === 'string') {
        state.files.add(path)
      }
      events.push({ type: isDenied ? 'tool_denied' : 'tool_completed', toolCallId: block.tool_use_id, toolName: call?.tool, isError: block.is_error === true })
    }
  }
  return events
}

/** Shell commands a CodeBuddy Head never runs: Command Code's list in CodeBuddy's rule syntax, plus `.env` as a path. */
export const BUDDY_SHELL_DENY = [
  ...DANGEROUS_SHELL.map(rule => rule.replace(/^Shell\((.*)\)$/, 'Bash($1)')),
  'Bash(* .env*)', 'Bash(*/.env*)', 'Bash(*=.env*)',
]

/** The built-in tools a CodeBuddy Head gets: files and search, and a shell only when its task asked for one. */
export const buddyTools = (shell: boolean) => ['Read', 'Write', 'Edit', 'Glob', 'Grep', ...(shell ? ['Bash'] : [])].join(',')

/**
 * The permission settings one CodeBuddy Head runs with, passed with `--settings` (so no file lands in the project):
 * edits are allowed only under the project and the folders it may write to, `.git` and `.env` files are denied
 * everywhere, a folder it may only read is denied for edits, and the write guard checks each write's real path
 * (a symlink in the project cannot lead out of it, which the path rules alone do not stop). The person's credential
 * folders (`SECRET_PATHS` under `home`) are denied to the read tools and to shell lines that name them.
 */
export const buddySecretDeny = (home: string) => {
  const base = trimSlash(home)
  if (!base || base === '/') return []
  return SECRET_PATHS.flatMap(dir => [`Read(${base}/${dir})`, `Read(${base}/${dir}/**)`, `Bash(*${base}/${dir}*)`, `Bash(*~/${dir}*)`, `Bash(*$HOME/${dir}*)`])
}

export const buddySettings = (cwd: string, head: HeadNeeds, guard?: string, home = '') => {
  const own = [cwd, ...(head.writeDirs ?? [])].map(trimSlash)
  const extra = union(head.addDirs.map(trimSlash), (head.writeDirs ?? []).map(trimSlash))
  const readOnly = extra.filter(dir => !own.some(root => isWithin(dir, root)))
  return {
    permissions: {
      allow: [...own.flatMap(root => [`Edit(${root}/**)`, `Write(${root}/**)`]), ...extra.map(dir => `Read(${dir}/**)`), ...(head.shell ? ['Bash'] : [])],
      deny: [
        ...own.flatMap(root => [
          `Edit(${root}/.git/**)`, `Write(${root}/.git/**)`,
          `Edit(${root}/**/.env)`, `Edit(${root}/**/.env.*)`, `Write(${root}/**/.env)`, `Write(${root}/**/.env.*)`,
          `Read(${root}/**/.env)`, `Read(${root}/**/.env.*)`,
        ]),
        ...readOnly.flatMap(dir => [`Edit(${dir}/**)`, `Write(${dir}/**)`, `Read(${dir}/**/.env)`, `Read(${dir}/**/.env.*)`]),
        ...buddySecretDeny(home),
        ...(head.shell ? BUDDY_SHELL_DENY : []),
      ],
    },
    ...(guard ? { hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command' as const, command: guard, timeout: 10 }] }] } } : {}),
  }
}

/** CodeBuddy's `--effort` levels: Hydra's `off` is its `minimal`. */
export const buddyEffort = (effort: string) => (effort === 'off' ? 'minimal' : effort)

/**
 * The CodeBuddy command line for one round. `default` permission mode plus the settings file means anything the rules
 * do not allow is refused (headless mode cannot ask), so a Head cannot edit outside its folders or use a tool it was not given.
 * The first round names its session; later rounds resume it.
 */
export const buddyArgs = (a: RoundArgs & { settings: string; shell: boolean; sessionId: string }) => {
  const args = ['codebuddy', '-p', a.prompt, '--model', a.model, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'default', '--tools', buddyTools(a.shell), '--settings', a.settings, '--setting-sources', 'local',
    '--max-turns', String(a.maxTurns)]
  for (const dir of a.addDirs) args.push('--add-dir', dir)
  if (a.effort) args.push('--effort', buddyEffort(a.effort))
  args.push(...(a.resume ? ['--resume', a.resume] : ['--session-id', a.sessionId]))
  return args
}

/** A session id for a Head's first CodeBuddy round; later rounds resume it. */
const buddySessionId = (id: string, now: number) => `hydra-${id}-${now.toString(36)}`

/** A result row that reports a failure (not a clean finish or the turn cap): its `result` is then the CLI's error text, not the model's report. */
const isBuddyError = (row: BuddyRow | null) =>
  row !== null && (row.is_error === true || (typeof row.subtype === 'string' && row.subtype.startsWith('error') && row.subtype !== 'error_max_turns'))

async function runRoundBuddy(
  $: EngineInterface,
  argv: RoundArgs & { settings: string; shell: boolean; sessionId: string; state: BuddyState },
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => Promise<void>,
): Promise<Round> {
  let result: BuddyRow | null = null
  let started: string | undefined
  let isCapped = false
  const turnsBefore = argv.state.messages.size
  const { errors, exit } = await pump($, buddyArgs(argv), argv.cwd, signal, async line => {
    if (!line.trim().startsWith('{')) return false
    let row: BuddyRow
    try {
      row = JSON.parse(line) as BuddyRow
    } catch {
      return false // A partial or non-JSON line; the result line is what counts.
    }
    if (row.type === 'system' && row.subtype === 'init' && typeof row.session_id === 'string') started = row.session_id
    if (row.type === 'result') {
      result = row
      argv.state.inputTokens += (row.usage?.input_tokens ?? 0) + (row.usage?.cache_creation_input_tokens ?? 0) + (row.usage?.cache_read_input_tokens ?? 0)
      argv.state.outputTokens += row.usage?.output_tokens ?? 0
    }
    for (const event of foldBuddyRow(row, argv.state)) await onEvent(event)
    // CodeBuddy's own --max-turns is loose (a Head ran 13 turns under a cap of 2), so Hydra counts model messages itself.
    if (argv.state.messages.size - turnsBefore > argv.maxTurns) isCapped = true
    return isCapped
  }, argv.env)
  const final = result as BuddyRow | null
  return {
    finalText: String(final?.result ?? ''),
    sessionId: typeof final?.session_id === 'string' ? final.session_id : undefined,
    subtype: isCapped ? 'error_max_turns' : typeof final?.subtype === 'string' ? final.subtype : undefined,
    code: isCapped ? 8 : exit.code,
    signal: exit.signal,
    errors: [errors, isBuddyError(final) ? String(final?.result ?? '') : ''].filter(Boolean).join('\n').slice(-2000),
    startedSession: started,
  }
}

type BuddyHead = { task: string; cwd: string; model: string; maxTurns: number; addDirs: string[]; writeDirs: string[]; shell: boolean; minutes: number; effort?: string; env?: Record<string, string> }

const BUDDY_SETTINGS_DIR = '.claude/hydra/heads'

/** Writes this Head's permission settings next to Hydra's status files, not in the project. Returns the file's path. */
async function writeBuddySettings($: EngineInterface, cwd: string, id: string, needs: HeadNeeds): Promise<string> {
  const home = await homeOf($)
  const dir = `${home}/${BUDDY_SETTINGS_DIR}`
  await $.process.run(['/bin/mkdir', '-p', dir])
  const path = `${dir}/${await $.session.id()}-${id}.json`
  const settings = buddySettings(cwd, needs, guardCommand($.plugin.root, cwd, needs.writeDirs ?? []), home)
  await $.fs.write(path, JSON.stringify(settings, null, 2) + '\n')
  return path
}

/** Settings files a crashed session left behind: a Head never runs for a day. */
export async function sweepBuddySettings($: EngineInterface) {
  const home = await homeOf($)
  if (!home) return
  const folder = `${home}/${BUDDY_SETTINGS_DIR}`
  const now = await $.clock.now()
  const entries = await $.fs.list(folder).catch(() => [])
  const old = entries.filter(entry => entry.kind === 'file' && entry.name.endsWith('.json') && now - entry.mtimeMs > 86_400_000)
  if (old.length > 0) await $.process.run(['/bin/rm', '-f', ...old.map(entry => `${folder}/${entry.name}`)]).catch(() => undefined)
}

/** A Head on CodeBuddy: its own permission settings (no shared rules file), then rounds until it reports HEAD DONE. */
export async function runBuddyHead($: EngineInterface, head: BuddyHead, outer: AbortSignal, limits: HeadLimits, id: string) {
  const { cwd, model } = head
  const unsupported = /^[A-Za-z]:|^\\\\|\\/.test(cwd) ? `${cwd} is a Windows path, and Hydra's rules use POSIX paths. Run Claude Code under WSL instead.` : undefined
  let settings = ''
  const refusal =
    unsupported ??
    (await writeBuddySettings($, cwd, id, { addDirs: head.addDirs, writeDirs: head.writeDirs, shell: head.shell }).then(
      path => {
        settings = path
        return undefined
      },
      error => `Hydra could not write the Head's permission settings (${String(error).slice(0, 160)}). Check that ~/.claude is writable, then run the Head again.`,
    ))
  if (refusal) {
    await setRun($, id, { state: 'failed', endedAt: await $.clock.now(), activity: refusal })
    await refreshStatus($, limits)
    return notStarted(id, model, cwd, `${refusal} A Head never starts without Hydra's rules.`)
  }
  try {
    return await runBuddyRounds($, head, settings, outer, limits, id)
  } finally {
    await $.process.run(['/bin/rm', '-f', settings]).catch(() => undefined)
  }
}

async function runBuddyRounds($: EngineInterface, head: BuddyHead, settings: string, outer: AbortSignal, limits: HeadLimits, id: string) {
  const { task, cwd, model, maxTurns, addDirs, shell, minutes } = head
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

  let turns = 0
  const state = newBuddyState()
  const labels = new Map<string, string>()
  const onEvent = async (event: StreamEvent) => {
    if (event.type === 'turn_end') turns++
    await setRun($, id, run => applyEvent(run, event, labels, cwd))
  }
  const roundAt = async (round: { prompt: string; maxTurns: number; resume?: string }) => {
    const effort = await effortNow()
    await setRun($, id, { effort })
    const ran = await runRoundBuddy($, { ...round, model, effort, cwd, addDirs, settings, shell, sessionId: buddySessionId(id, await $.clock.now()), state, env: head.env }, signal, onEvent)
    return { ...ran, effort }
  }

  let round = await roundAt({ prompt: task + HEAD_RULES, maxTurns })
  for (let attempt = 1; !round.sessionId && !signal.aborted && attempt <= START_RETRIES; attempt++) {
    await $.clock.sleep(attempt * 5_000, { signal }).catch(() => undefined)
    round = await roundAt({ prompt: task + HEAD_RULES, maxTurns })
  }
  const sessionId = round.sessionId ?? round.startedSession
  let rounds = 1
  while (!signal.aborted && sessionId && isResumable(round.code) && !isFinished(round.finalText) && rounds < MAX_ROUNDS && turns < maxTurns) {
    const denied = state.denied.map(d => `${d.tool} ${relativeTo(cwd, d.target)}`)
    await setRun($, id, { activity: `resuming (round ${rounds + 1})` })
    round = await roundAt({ prompt: continuePrompt(denied), maxTurns: maxTurns - turns, resume: sessionId })
    rounds++
  }

  timerStop.abort()
  const files = [...state.files]
  const tokens = tokensText(state.inputTokens, state.outputTokens)
  const finished = isFinished(round.finalText)
  const isDone = round.code === 0 && round.subtype === 'success' && finished
  const stopped = outer.aborted ? stopReason(outer) : undefined
  await setRun($, id, {
    state: isDone ? 'done' : 'failed', turns, tokens, endedAt: await $.clock.now(),
    files: files.map(file => relativeTo(cwd, file)), summary: summaryOf(round.finalText),
    activity: isDone ? undefined : timedOut ? `timed out after ${minutes} min` : stopped ?? (round.subtype === 'error_max_turns' ? `stopped at the ${maxTurns}-turn cap` : 'stopped before HEAD DONE'),
  })
  void refreshHeads($, limits)

  const text = formatReport({
    id, model, effort: round.effort, cwd, sessionId, finished, rounds, turns, usd: null, files, denied: state.denied,
    finalText: round.finalText, exit: timedOut ? `timed out after ${minutes} min` : stopped ?? String(round.code ?? round.signal), errors: round.errors,
    writeDirs: head.writeDirs, engine: 'codebuddy', tokens,
  })
  return { text, isDone, failure: isDone ? undefined : round.errors, files }
}
