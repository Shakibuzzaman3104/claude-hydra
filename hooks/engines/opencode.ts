/**
 * @author Shakib
 * @since 15/10/26
 */
import type { EngineInterface } from 'claude-code'

import { applyEvent, formatReport, relativeTo, tokensText } from '../lib/format'
import type { HeadLimits, SessionReport, StreamEvent } from '../lib/format'
import { HEAD_RULES, MAX_ROUNDS, START_RETRIES, changedFiles, continuePrompt, isFinished, isResumable, notStarted, pump, realPaths, refreshHeads, refreshStatus, setRun, stopReason, summaryOf } from '../lib/runtime'
import type { IdleLimits, Round } from '../lib/runtime'
import { SECRET_PATHS, isWithin, trimSlash, union } from '../lib/safety'
import type { HeadNeeds } from '../lib/safety'
import { homeOf } from '../lib/platform'

/** OpenCode tool names as the names Command Code's stream uses, so one live view reads every engine. */
const OPENCODE_TOOLS: Record<string, string> = {
  read: 'read_file', write: 'write_file', edit: 'edit_file', apply_patch: 'edit_file', patch: 'edit_file',
  glob: 'glob', grep: 'grep', shell: 'shell_command', bash: 'shell_command',
}

/** The tools a Head is meant to have. Any other tool that completes is flagged in the report: Hydra's rules should have refused it. */
const OPENCODE_SAFE_TOOLS = new Set(['read', 'write', 'edit', 'apply_patch', 'patch', 'glob', 'todowrite', 'todoread', 'invalid'])

/** The tools that change files: their completed calls name the files a Head edited. */
const OPENCODE_EDIT_TOOLS = new Set(['write', 'edit', 'apply_patch', 'patch'])

/** How OpenCode words a call its permission rules refused, and the one it would have asked about (headless mode rejects those). */
const OPENCODE_DENIAL = /permission denied|auto-rejecting|rejected permission/i

/**
 * Every permission key a Head never gets, denied by name on top of the `"*": "deny"` default: the shell (it is not
 * path-checked, so it escapes the project), grep (it returns lines from `.env` files), the `execute` code tool (it
 * reaches `tools.browser.*` and every MCP tool), the web, subagents, questions (headless mode would abort on one),
 * skills, LSP, the doom-loop prompt and MCP resources. `bash` and `task` are the legacy names of `shell` and `subagent`.
 */
export const OPENCODE_DENY = [
  'bash', 'shell', 'grep', 'execute', 'webfetch', 'websearch', 'task', 'subagent', 'question', 'skill', 'lsp', 'doom_loop',
  'list_mcp_resources', 'read_mcp_resource',
] as const

/** No `.env` file is read or edited, at any depth (`*` matches `/` in OpenCode's patterns). */
const OPENCODE_SECRETS = { '*.env': 'deny', '*.env.*': 'deny' } as const

/** `.git` itself and anything in it, at the top and at any depth or absolute path. */
const OPENCODE_GIT = { '.git': 'deny', '.git/*': 'deny', '*/.git': 'deny', '*/.git/*': 'deny' } as const

type Rule = 'allow' | 'deny'

/** A symlink in the project whose real target is outside it: its path relative to the project, and the target. */
export type OutLink = { path: string; target: string }

/**
 * The OpenCode config one Head runs with (`OPENCODE_CONFIG`), in the legacy `permission` form that v2 still honours.
 * Everything is denied by default and every key Hydra cares about is explicit; nothing is `ask`, because headless
 * `opencode run` rejects an ask and aborts the whole run. A Head may read anything in the project except `.env`
 * files, edit inside the project and its `writeDirs` (never `.git` or `.env`), list files with `glob` and keep a todo
 * list. `external_directory` keeps it inside: only `writeDirs` and `addDirs` folders are reachable outside `cwd`, and a
 * folder it may only read is denied for edits. OpenCode checks the path as written, so a symlink inside the project
 * that leads out of it (`links`, with their real targets) would reach its target: one is denied for edits unless it
 * leads into a `writeDirs` folder, and for reads too unless it leads into a folder the Head may read. `shell` is never
 * given, whatever the Head asked for: OpenCode does not check a command's paths. The credential folders and files in
 * the home folder (`SECRET_PATHS`) are denied for reads, globs and edits by absolute path too, in case a grant covers them.
 */
export const opencodeConfig = (cwd: string, head: HeadNeeds, links: readonly OutLink[] = [], home = '') => {
  const writable = [cwd, ...(head.writeDirs ?? [])].map(trimSlash)
  const readOnly = head.addDirs.map(trimSlash).filter(dir => !writable.some(root => isWithin(dir, root)))
  const outside = union(writable.slice(1), readOnly).filter(dir => !isWithin(dir, writable[0]!))
  const denyFolder = (dir: string): [string, Rule][] => [[dir, 'deny'], [`${dir}/*`, 'deny']]
  const deny = Object.fromEntries(OPENCODE_DENY.map(key => [key, 'deny' as Rule]))
  const secrets = Object.fromEntries(home ? SECRET_PATHS.flatMap(path => denyFolder(`${trimSlash(home)}/${path}`)) : [])
  const unwritableLinks = links.filter(link => !writable.some(root => isWithin(link.target, root))).map(link => link.path)
  const unreadableLinks = links.filter(link => ![...writable, ...readOnly].some(root => isWithin(link.target, root))).map(link => link.path)
  return {
    autoupdate: false,
    share: 'disabled',
    tools: Object.fromEntries(OPENCODE_DENY.map(key => [key, false])),
    permission: {
      '*': 'deny' as Rule,
      read: { '*': 'allow' as Rule, ...Object.fromEntries(unreadableLinks.flatMap(denyFolder)), ...OPENCODE_SECRETS, ...secrets },
      edit: { '*': 'allow' as Rule, ...Object.fromEntries([...readOnly, ...unwritableLinks].flatMap(denyFolder)), ...OPENCODE_GIT, ...OPENCODE_SECRETS, ...secrets },
      glob: { '*': 'allow' as Rule, ...secrets },
      todowrite: 'allow' as Rule,
      external_directory: { '*': 'deny' as Rule, ...Object.fromEntries(outside.map(dir => [`${dir}/*`, 'allow' as Rule])) },
      ...deny,
    },
  }
}

/**
 * The environment one OpenCode Head runs with: its config file (and the same JSON inline, which outranks any config
 * the person's environment names), no project config, no auto-update, and its own empty config home, so the person's
 * `~/.config/opencode` (which can hold provider API keys) is neither loaded nor allowed to the Head as OpenCode's own
 * config folder. The data folder (sign-ins, the free models' access) stays the person's, unless an account sets it.
 */
export const opencodeEnv = (configFile: string, configHome: string, config: string, account?: Record<string, string>) => ({
  OPENCODE_CONFIG: configFile,
  OPENCODE_CONFIG_CONTENT: config,
  OPENCODE_CONFIG_DIR: configHome,
  OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  XDG_CONFIG_HOME: configHome,
  ...(account ?? {}),
})

/**
 * The OpenCode command line for one round: `--standalone` runs a private server for this run instead of attaching to
 * (or starting) the person's background service, `--format json` streams one event per line, and a later round
 * continues the session with `-s`. Never `--auto`, which approves whatever is not denied. Stdin is closed by `pump`.
 */
export const opencodeArgs = (a: { prompt: string; model: string; resume?: string }) =>
  ['opencode', 'run', '--standalone', '--format', 'json', '-m', a.model, ...(a.resume ? ['-s', a.resume] : []), '--', a.prompt]

/** No event within 90 s of the start, or 5 min of silence later: OpenCode has hung (seen in about 40% of research runs). */
export const OPENCODE_WATCHDOG: IdleLimits = { firstMs: 90_000, idleMs: 300_000 }

type OpenCodeTokens = { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
type OpenCodePart = {
  id?: string; type?: string; text?: string; tool?: string; reason?: string; cost?: number; tokens?: OpenCodeTokens
  state?: { status?: string; input?: Record<string, unknown>; error?: string; output?: string }
}
export type OpenCodeRow = { type?: string; timestamp?: number; sessionID?: string; part?: OpenCodePart; error?: { type?: string; message?: string; status?: number } }

/** What an OpenCode Head did, accumulated from its stream: model steps (its turns), files edited, calls refused, tokens, cost. */
export type OpenCodeState = {
  cwd: string
  turns: number
  files: Set<string>
  denied: SessionReport['denied']
  /** Calls that ran although Hydra's rules should have refused them; each becomes a ⚠ line in the report. */
  flagged: string[]
  inputTokens: number
  outputTokens: number
  usd: number
  finalText: string
  textTurn: number
  sessionId?: string
  /** The `error` events of the current round, as `type: message`. */
  failures: string[]
}

export const newOpenCodeState = (cwd: string): OpenCodeState => ({
  cwd, turns: 0, files: new Set(), denied: [], flagged: [], inputTokens: 0, outputTokens: 0, usd: 0, finalText: '', textTurn: -1, failures: [],
})

const absoluteIn = (cwd: string, path: string) => (path.startsWith('/') ? path : `${trimSlash(cwd)}/${path.replace(/^\.\//, '')}`)

/** The files a patch names (`*** Add File: a.txt`, `*** Update File: …`, `*** Move to: …`). */
export const patchFiles = (patch: string) =>
  [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(found => found[1]!.trim())

const pathOf = (input: Record<string, unknown>) => String(input.path ?? input.filePath ?? input.file_path ?? '')

/**
 * Folds one line of `opencode run --format json` into `state` and returns the live-view events it stands for. A turn is
 * one model step (`step_start`); a `tool_use` row arrives once, with the call's final state, so it is queued, run and
 * finished at once. A tool error that starts "Permission denied" is a refusal. `step_finish` carries tokens and cost,
 * but only for steps that end in tool calls: the last, text-only step is not counted.
 */
export const foldOpenCodeRow = (row: OpenCodeRow, state: OpenCodeState): StreamEvent[] => {
  const events: StreamEvent[] = []
  if (typeof row.sessionID === 'string' && !state.sessionId) state.sessionId = row.sessionID
  const part = row.part ?? {}
  if (row.type === 'step_start') {
    state.turns++
    events.push({ type: 'turn_end' }, { type: 'thinking_start' })
  } else if (row.type === 'text' && typeof part.text === 'string') {
    state.finalText = state.textTurn === state.turns ? `${state.finalText}\n${part.text}` : part.text
    state.textTurn = state.turns
  } else if (row.type === 'reasoning') {
    events.push({ type: 'thinking_start' })
  } else if (row.type === 'step_finish') {
    const tokens = part.tokens ?? {}
    state.inputTokens += (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
    state.outputTokens += (tokens.output ?? 0) + (tokens.reasoning ?? 0)
    state.usd += typeof part.cost === 'number' ? part.cost : 0
  } else if (row.type === 'error') {
    state.failures.push(`${row.error?.type ?? 'error'}: ${row.error?.message ?? 'OpenCode reported an error'}`)
  } else if (row.type === 'tool_use' && part.tool) {
    const name = part.tool
    const tool = OPENCODE_TOOLS[name] ?? name
    const id = part.id ?? `${name}-${state.turns}-${state.denied.length}-${state.files.size}`
    const raw = part.state?.input ?? {}
    const patched = typeof raw.patchText === 'string' ? patchFiles(raw.patchText) : []
    const input: Record<string, unknown> = name === 'shell' || name === 'bash' ? { command: raw.command ?? '' }
      : pathOf(raw) ? { path: absoluteIn(state.cwd, pathOf(raw)) }
      : patched.length > 0 ? { path: absoluteIn(state.cwd, patched[0]!) }
      : { pattern: raw.pattern ?? '' }
    const status = part.state?.status
    const error = String(part.state?.error ?? '')
    const isError = status === 'error'
    const isDenied = isError && OPENCODE_DENIAL.test(error)
    if (isDenied) {
      state.denied.push({ tool, target: String(input.path ?? input.command ?? input.pattern ?? ''), text: error.replace(/\s+/g, ' ').trim() })
    } else if (status === 'completed') {
      if (OPENCODE_EDIT_TOOLS.has(name)) {
        for (const file of patched.length > 0 ? patched : [pathOf(raw)]) if (file) state.files.add(absoluteIn(state.cwd, file))
      }
      if (!OPENCODE_SAFE_TOOLS.has(name)) state.flagged.push(`the Head ran OpenCode's \`${name}\` tool, which Hydra's rules deny: check what it did`)
    }
    events.push(
      { type: 'tool_queued', toolCallId: id, toolName: tool, input },
      { type: 'tool_running', toolCallId: id, toolName: tool },
      { type: isDenied ? 'tool_denied' : 'tool_completed', toolCallId: id, toolName: tool, isError },
    )
  }
  return events
}

async function runRoundOpenCode(
  $: EngineInterface,
  argv: { prompt: string; model: string; maxTurns: number; resume?: string; cwd: string; env: Record<string, string>; state: OpenCodeState },
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => Promise<void>,
): Promise<Round> {
  const { state } = argv
  state.failures = []
  state.finalText = ''
  const turnsBefore = state.turns
  let isCapped = false
  const { errors, exit } = await pump($, opencodeArgs(argv), argv.cwd, signal, async line => {
    if (!line.trim().startsWith('{')) return false
    let row: OpenCodeRow
    try {
      row = JSON.parse(line) as OpenCodeRow
    } catch {
      return false // A partial or non-JSON line; the step and tool rows are what count.
    }
    for (const event of foldOpenCodeRow(row, state)) await onEvent(event)
    if (state.turns - turnsBefore > argv.maxTurns) isCapped = true
    return isCapped
  }, argv.env, OPENCODE_WATCHDOG)
  const failure = state.failures.join('\n')
  return {
    finalText: state.finalText,
    sessionId: state.sessionId,
    subtype: isCapped ? 'error_max_turns' : failure || (exit.code !== null && exit.code !== 0) ? 'error' : exit.code === 0 ? 'success' : undefined,
    code: isCapped ? 8 : exit.code,
    signal: exit.signal,
    errors: [failure, errors].filter(Boolean).join('\n').slice(-2000),
  }
}

type OpenCodeHead = { task: string; cwd: string; model: string; maxTurns: number; addDirs: string[]; writeDirs: string[]; minutes: number; env?: Record<string, string> }

const HEADS_DIR = '.claude/hydra/heads'
const PREFIX = 'opencode-'

/** The symlinks under `cwd` (8 levels down, `.git` skipped, at most 500) whose real target is outside it, with their paths relative to `cwd`. */
async function outsideLinks($: EngineInterface, cwd: string): Promise<OutLink[]> {
  const ran = await $.process.run(['/usr/bin/find', cwd, '-maxdepth', '8', '-name', '.git', '-prune', '-o', '-type', 'l', '-print'], { timeoutMs: 15_000 }).catch(() => undefined)
  const links = (ran?.stdout ?? '').split('\n').map(line => line.trim()).filter(Boolean).slice(0, 500)
  if (links.length === 0) return []
  const real = await realPaths($, links)
  return links.map((link, index) => ({ path: relativeTo(cwd, link), target: real[index] ?? link })).filter(link => !isWithin(link.target, cwd))
}

/** Writes the Head's config file and its empty config home next to Hydra's status files (owner-only), never in the project. */
async function writeOpenCodeFiles($: EngineInterface, cwd: string, id: string, needs: HeadNeeds) {
  const home = await homeOf($)
  const base = `${home}/${HEADS_DIR}/${PREFIX}${await $.session.id()}-${id}`
  const configHome = base
  const configFile = `${base}.json`
  await $.process.run(['/bin/mkdir', '-p', configHome])
  await $.process.run(['/bin/chmod', '700', configHome])
  const links = await outsideLinks($, cwd)
  const [realHome] = home ? await realPaths($, [home]) : ['']
  const config = JSON.stringify(opencodeConfig(cwd, needs, links, realHome), null, 2)
  await $.fs.write(configFile, config + '\n')
  await $.process.run(['/bin/chmod', '600', configFile])
  return { configFile, configHome, config }
}

async function removeOpenCodeFiles($: EngineInterface, base: string) {
  if (!base.includes(`/${HEADS_DIR}/${PREFIX}`)) return
  await $.process.run(['/bin/rm', '-f', `${base}.json`]).catch(() => undefined)
  await $.process.run(['/bin/rm', '-rf', base]).catch(() => undefined)
}

/** Config files and folders a crashed session left behind: a Head never runs for a day. */
export async function sweepOpenCodeFiles($: EngineInterface) {
  const home = await homeOf($)
  if (!home) return
  const folder = `${home}/${HEADS_DIR}`
  const now = await $.clock.now()
  const entries = await $.fs.list(folder).catch(() => [])
  for (const entry of entries) {
    if (!entry.name.startsWith(PREFIX) || now - entry.mtimeMs <= 86_400_000) continue
    if (entry.kind === 'file' && entry.name.endsWith('.json')) await $.process.run(['/bin/rm', '-f', `${folder}/${entry.name}`]).catch(() => undefined)
    else if (entry.kind === 'dir') await removeOpenCodeFiles($, `${folder}/${entry.name}`)
  }
}

/** A Head on OpenCode (beta): its own config and config home, then rounds until it reports HEAD DONE. */
export async function runOpenCodeHead($: EngineInterface, head: OpenCodeHead, outer: AbortSignal, limits: HeadLimits, id: string) {
  const { cwd, model } = head
  let files: { configFile: string; configHome: string; config: string } | undefined
  const refusal = /^[A-Za-z]:|^\\\\|\\/.test(cwd)
    ? `${cwd} is a Windows path, and Hydra's rules use POSIX paths. Run Claude Code under WSL instead.`
    : await writeOpenCodeFiles($, (await realPaths($, [cwd]))[0] ?? cwd, id, { addDirs: await realPaths($, head.addDirs), writeDirs: await realPaths($, head.writeDirs), shell: false }).then(
        written => {
          files = written
          return undefined
        },
        error => `Hydra could not write the Head's OpenCode config (${String(error).slice(0, 160)}). Check that ~/.claude is writable, then run the Head again.`,
      )
  if (refusal || !files) {
    if (files) await removeOpenCodeFiles($, files.configHome)
    await setRun($, id, { state: 'failed', endedAt: await $.clock.now(), activity: refusal })
    await refreshStatus($, limits)
    return notStarted(id, model, cwd, `${refusal} A Head never starts without Hydra's rules.`, 'opencode')
  }
  try {
    return await runOpenCodeRounds($, head, opencodeEnv(files.configFile, files.configHome, files.config, head.env), outer, limits, id)
  } finally {
    await removeOpenCodeFiles($, files.configHome)
  }
}

async function runOpenCodeRounds($: EngineInterface, head: OpenCodeHead, env: Record<string, string>, outer: AbortSignal, limits: HeadLimits, id: string) {
  const { task, cwd, model, maxTurns, minutes } = head
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
  const state = newOpenCodeState(cwd)
  const labels = new Map<string, string>()
  const onEvent = async (event: StreamEvent) => {
    await setRun($, id, run => applyEvent(run, event, labels, cwd))
  }
  let hangs = 0
  // A silent run is stopped by the watchdog and tried once more; a second silence is reported as a hang.
  const roundAt = async (round: { prompt: string; maxTurns: number; resume?: string }) => {
    const once = () => runRoundOpenCode($, { ...round, model, cwd, env, state }, signal, onEvent)
    let ran = await once()
    if (ran.signal === 'idle' && !signal.aborted) {
      hangs++
      await setRun($, id, { activity: 'no output from OpenCode, retrying' })
      ran = await once()
    }
    if (ran.signal === 'idle') {
      hangs++
      return { ...ran, errors: [`OpenCode produced no output for ${state.turns === 0 ? '90 s after starting' : '5 min'} twice, so Hydra stopped it (a known OpenCode hang).`, ran.errors].filter(Boolean).join('\n') }
    }
    return ran
  }

  let round = await roundAt({ prompt: task + HEAD_RULES, maxTurns })
  for (let attempt = 1; !round.sessionId && !signal.aborted && round.signal !== 'idle' && attempt <= START_RETRIES; attempt++) {
    await $.clock.sleep(attempt * 5_000, { signal }).catch(() => undefined)
    round = await roundAt({ prompt: task + HEAD_RULES, maxTurns })
  }
  const sessionId = round.sessionId
  let rounds = 1
  while (!signal.aborted && sessionId && isResumable(round.code) && !isFinished(round.finalText) && rounds < MAX_ROUNDS && state.turns < maxTurns) {
    const denied = state.denied.map(d => `${d.tool} ${relativeTo(cwd, d.target)}`.slice(0, 160))
    await setRun($, id, { activity: `resuming (round ${rounds + 1})` })
    round = await roundAt({ prompt: continuePrompt(denied), maxTurns: maxTurns - state.turns, resume: sessionId })
    rounds++
  }

  timerStop.abort()
  const files = union([...state.files], await changedFiles($, startedAt, [cwd, ...head.writeDirs]))
  const tokens = tokensText(state.inputTokens, state.outputTokens)
  const finished = isFinished(round.finalText)
  const isDone = round.code === 0 && round.subtype === 'success' && finished
  const stopped = outer.aborted ? stopReason(outer) : undefined
  const hung = round.signal === 'idle'
  await setRun($, id, {
    state: isDone ? 'done' : 'failed', turns: state.turns, tokens, endedAt: await $.clock.now(),
    files: files.map(file => relativeTo(cwd, file)), summary: summaryOf(round.finalText),
    activity: isDone ? undefined : timedOut ? `timed out after ${minutes} min` : stopped ?? (hung ? 'OpenCode hung (no output)' : round.subtype === 'error_max_turns' ? `stopped at the ${maxTurns}-turn cap` : 'stopped before HEAD DONE'),
  })
  void refreshHeads($, limits)

  const warnings = [...new Set(state.flagged)]
  if (hangs > 0 && !hung) warnings.push(`OpenCode went silent ${hangs} time(s) and was restarted by Hydra's watchdog; check the files it edited.`)
  const text = formatReport({
    id, model, cwd, sessionId, finished, rounds, turns: state.turns, usd: null, files, denied: state.denied,
    finalText: round.finalText, exit: timedOut ? `timed out after ${minutes} min` : stopped ?? (hung ? 'hung' : String(round.code ?? round.signal)), errors: round.errors,
    writeDirs: head.writeDirs, engine: 'opencode', tokens: state.usd > 0 ? `${tokens} · $${state.usd.toFixed(4)}` : tokens, warnings,
  })
  return { text, isDone, failure: isDone ? undefined : round.errors, files }
}
