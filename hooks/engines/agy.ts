/**
 * @author Shakib
 * @since 15/10/26
 */
import type { EngineInterface } from 'claude-code'

import { effortModeOf, headEffort } from '../lib/effort'
import { agyTokenOf } from '../lib/accounts'
import { AGY_TOKEN, agyModelId } from '../lib/engines'
import { applyEvent, formatReport, relativeTo, tokensText } from '../lib/format'
import type { HeadLimits, SessionReport, StreamEvent } from '../lib/format'
import { HEAD_RULES, MAX_ROUNDS, START_RETRIES, changedFiles, compareChangedFiles, continuePrompt, isFinished, isResumable, notStarted, pump, refreshHeads, refreshStatus, setRun, snapshotChangedFiles, stopReason, summaryOf } from '../lib/runtime'
import type { Round, RoundArgs } from '../lib/runtime'
import { DANGEROUS_SHELL, SECRET_PATHS, isWithin, trimSlash, union } from '../lib/safety'
import type { HeadNeeds } from '../lib/safety'
import { NO_GUARD } from '../lib/protect'
import type { Guarded } from '../lib/protect'
import { homeOf, platformOf } from '../lib/platform'
import { readMode } from '../lib/state'
import { caseVariants } from './opencode'

/** Antigravity's tool names as the names Command Code's stream uses, so one live view reads every engine. */
const AGY_TOOLS: Record<string, string> = {
  run_command: 'shell_command', write_to_file: 'write_file', replace_file_content: 'edit_file', multi_replace_file_content: 'edit_file',
  sed_file: 'edit_file', notebook_edit: 'edit_file', view_file: 'read_file', list_dir: 'read_directory', grep_search: 'grep', find_by_name: 'glob',
}

export type AgyRow = {
  event?: string
  conversation_id?: string
  step_update?: {
    conversation_id?: string; step_index?: number; state?: string; step_type?: string; tool_name?: string
    tool_info?: { name?: string; parameters?: Record<string, unknown> }
  }
  result?: {
    conversation_id?: string; status?: string; response?: string
    usage?: { input_tokens?: number; output_tokens?: number }
    denied_actions?: { action?: string; display_name?: string }[]
  }
}

/** What an Antigravity Head did, accumulated from its stream: tool calls (its turns), refused actions, tokens, the report. */
export type AgyState = {
  calls: Map<number, { tool: string; input: Record<string, unknown> }>
  denied: SessionReport['denied']
  turns: number
  inputTokens: number
  outputTokens: number
  finalText: string
  conversationId?: string
  status?: string
  lastTarget: string
}

export const newAgyState = (): AgyState => ({ calls: new Map(), denied: [], turns: 0, inputTokens: 0, outputTokens: 0, finalText: '', lastTarget: '' })

const agyInput = (name: string, parameters: Record<string, unknown> = {}): Record<string, unknown> => {
  if (name === 'run_command') return { command: String(parameters.CommandLine ?? '') }
  const path = parameters.TargetFile ?? parameters.AbsolutePath ?? parameters.DirectoryPath ?? parameters.SearchPath ?? parameters.SearchDirectory
  return { ...(path ? { file_path: String(path) } : {}), ...(parameters.Query ? { pattern: String(parameters.Query) } : {}) }
}

/**
 * Folds one line of `agy -p --output-format stream-json` into `state` and returns the live-view events it stands for.
 * A turn is one finished tool call. The stream does not say whether a file tool call was refused (a refusal ends the run
 * and shows only in the final `denied_actions`), so edited files come from the file system, not from here.
 */
export const foldAgyRow = (row: AgyRow, state: AgyState): StreamEvent[] => {
  const events: StreamEvent[] = []
  if (row.event === 'init' && typeof row.conversation_id === 'string') state.conversationId = row.conversation_id
  else if (row.event === 'step_update' && row.step_update) {
    const step = row.step_update
    if (step.conversation_id && !state.conversationId) state.conversationId = step.conversation_id
    if (step.step_type === 'agent_response' && step.state === 'ACTIVE') events.push({ type: 'thinking_start' })
    if (step.step_type === 'tool' && typeof step.step_index === 'number') {
      const name = step.tool_name ?? step.tool_info?.name ?? 'tool'
      const index = step.step_index
      if (!state.calls.has(index)) {
        const call = { tool: AGY_TOOLS[name] ?? name, input: agyInput(name, step.tool_info?.parameters) }
        state.calls.set(index, call)
        events.push({ type: 'tool_queued', toolCallId: String(index), toolName: call.tool, input: call.input }, { type: 'tool_running', toolCallId: String(index), toolName: call.tool })
      }
      if (step.state === 'DONE') {
        const call = state.calls.get(index)!
        state.lastTarget = String(call.input.command ?? call.input.file_path ?? call.input.pattern ?? '')
        events.push({ type: 'tool_completed', toolCallId: String(index), toolName: call.tool, isError: false }, { type: 'turn_end' })
        state.turns++
      }
    }
  } else if (row.event === 'result' && row.result) {
    const result = row.result
    if (result.conversation_id) state.conversationId = result.conversation_id
    state.status = result.status
    state.finalText = result.response ?? ''
    state.inputTokens += result.usage?.input_tokens ?? 0
    state.outputTokens += result.usage?.output_tokens ?? 0
    for (const action of result.denied_actions ?? []) {
      state.denied.push({ tool: action.display_name ?? action.action ?? 'tool', target: state.lastTarget, text: `Antigravity refused the ${action.action ?? 'action'} permission (the call before this stop: ${state.lastTarget || 'unknown'})` })
    }
  }
  return events
}


/** Credential folders under the person's home that an Antigravity Head must not read (its own, with the sign-in token, included). */
export const AGY_SECRET_DIRS = SECRET_PATHS

/**
 * Shell lines an Antigravity Head with a shell never runs: Command Code's list as regexes that match the command at the start
 * of the line or after `;`, `&`, `|` or `(` (a compound line skips prefix rules, and `\b` does not work in Antigravity's regexes).
 */
export const AGY_SHELL_DENY = DANGEROUS_SHELL.map(rule => {
  const text = rule.replace(/^Shell\((.*)\)$/, '$1').replace(/\*$/, '')
  return `command(regex:(?:.*[;&|(]\\s*)?${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*)`
})

/**
 * The permission settings one Antigravity Head runs with: it writes only under the project and the folders it may write to
 * (`.git` denied), reads outside them only the `addDirs`, reads no credential folder and none of `envFiles`, and has a shell
 * (inside the terminal sandbox, minus the dangerous commands) only when asked. `tempDirs` are system temp folders the sandbox would
 * leave writable. A refused call ends the Head's turn. Rules name paths: a glob or a regex makes the sandbox refuse every command.
 */
/** System temp folders the sandbox leaves writable, minus any that holds a folder the Head may write to (denying that would lock it out). */
export const agyTempDeny = (roots: readonly string[], existing: readonly string[]) =>
  existing.filter(temp => !roots.some(root => isWithin(trimSlash(root), temp)))

export const AGY_TEMP_DIRS = ['/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp']

/** More deny rules than this and an Antigravity Head is refused: every letter-case spelling of a long name would bloat its rules. */
export const AGY_RULE_CAP = 4096

/**
 * Every spelling of `path` that reaches it on a disk that ignores letter case: the part below the root that holds it in any
 * case, the root as written (any other spelling of the root is outside the workspace, which a headless Head is refused).
 */
export const agySpellings = (path: string, roots: readonly string[], caseless: boolean) => {
  const isDir = path.endsWith('/')
  const bare = trimSlash(path)
  const root = caseless ? roots.filter(dir => bare !== dir && isWithin(bare, dir)).sort((a, b) => b.length - a.length)[0] : undefined
  const spellings = root ? caseVariants(bare.slice(root.length + 1)).map(rest => `${root}/${rest}`) : [bare]
  return spellings.map(spelling => (isDir ? `${spelling}/` : spelling))
}

/**
 * The permission settings one Antigravity Head runs with: it writes only under the project and the folders it may write to
 * (`.git` denied), reads outside them only the `addDirs`, reads none of `envFiles` or the paths `.hydraignore` names (whose
 * `.hydraignore` stays read-only), reads no credential folder (its own `Library` folder, which links to the keychain, included),
 * and has a shell (inside the terminal sandbox, minus the dangerous commands) only when asked. `tempDirs` are system temp folders
 * the sandbox would leave writable. Rules name paths (a glob or a regex makes the sandbox refuse every command) and match one
 * spelling, so on a `caseless` disk each path inside a root is denied in every letter case. `headHome` is the Head's own `HOME`,
 * whose `Library` folder links to the keychain: it is denied too. A refused call ends the Head's turn.
 */
export const agySettings = (cwd: string, head: HeadNeeds, home = '', envFiles: readonly string[] = [], tempDirs: readonly string[] = [], caseless = false, headHome = '') => {
  const own = [cwd, ...(head.writeDirs ?? [])].map(trimSlash)
  const extra = union(head.addDirs.map(trimSlash), (head.writeDirs ?? []).map(trimSlash))
  const roots = union(own, extra)
  const rules = (action: string, path: string) => agySpellings(path, roots, caseless).map(spelling => `${action}(${spelling})`)
  const guarded = head.guarded ?? NO_GUARD
  return {
    permissions: {
      allow: [...own.map(root => `write_file(${root}/)`), ...extra.map(dir => `read_file(${dir}/)`), ...(head.shell ? ['command(*)'] : [])],
      deny: [
        ...own.flatMap(root => rules('write_file', `${root}/.git/`)),
        ...tempDirs.map(dir => `write_file(${dir}/)`),
        ...envFiles.flatMap(file => rules('read_file', file)),
        ...guarded.paths.flatMap(path => {
          const target = guarded.folders.includes(path) ? `${path}/` : path
          return [...rules('read_file', target), ...rules('write_file', target)]
        }),
        ...guarded.ignoreFiles.flatMap(file => rules('write_file', file)),
        ...(home ? AGY_SECRET_DIRS.map(dir => `read_file(${home.replace(/\/$/, '')}/${dir})`) : []),
        // The Head's own Library holds the link to the keychain, so no tool of its reads or writes there, with a shell or without.
        ...(headHome ? [`read_file(${trimSlash(headHome)}/Library)`, `write_file(${trimSlash(headHome)}/Library)`] : []),
        ...(head.shell ? AGY_SHELL_DENY : []),
      ],
    },
  }
}

/** Whether the disk under `cwd` ignores letter case: the path in swapped case leads to it too. A path without letters, or a failed check, counts as yes. */
async function isCaseless($: EngineInterface, cwd: string) {
  const swapped = [...cwd].map(char => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase())).join('')
  return swapped === cwd || (await $.fs.exists(swapped).catch(() => true))
}

/** A grant that holds a credential folder: on a disk that ignores case, a rule naming `~/.ssh` misses `~/.SSH` inside the grant. */
export const agyGrantRefusal = (grants: readonly string[], home: string) => {
  const base = trimSlash(home)
  if (!base) return undefined
  for (const grant of grants) {
    const secret = SECRET_PATHS.find(path => isWithin(`${base}/${path}`, trimSlash(grant)))
    if (secret) return `addDirs/writeDirs: ${grant} holds ${base}/${secret}, and on this disk (which ignores letter case) Antigravity's rules cannot deny it in every spelling. Grant a narrower folder.`
  }
  return undefined
}

export const tooManySpellings = (count: number) =>
  `This disk ignores letter case, so Hydra denies each protected path in every spelling for Antigravity, and this Head would need ${count} rules (over ${AGY_RULE_CAP}): a long name in .hydraignore (local.properties alone has 32,768 spellings) or many .env files. Use another engine here (Codex, Command Code or CodeBuddy).`

/** Why an Antigravity Head may not start here, if it may not: only on a disk that ignores letter case. */
export async function agyCaseRefusal($: EngineInterface, cwd: string, needs: HeadNeeds) {
  if (!(await isCaseless($, cwd))) return undefined
  const home = await homeOf($)
  const grant = agyGrantRefusal(union(needs.addDirs, needs.writeDirs ?? []), home)
  if (grant) return grant
  const envFiles = await findEnvFiles($, union([cwd, ...(needs.writeDirs ?? [])], needs.addDirs))
  const count = agySettings(cwd, needs, home, envFiles, [], true).permissions.deny.length
  return count > AGY_RULE_CAP ? tooManySpellings(count) : undefined
}

/**
 * The Antigravity command line for one round, started with stdin closed and `HOME` pointing at the Head's own settings folder
 * (there is no flag for settings), and `--sandbox` is what keeps a shell inside the project. Later rounds `--conversation` the first.
 */
export const agyArgs = (a: RoundArgs & { home: string }) => {
  const args = ['agy', '-p', a.prompt,
    '--model', agyModelId(a.model, a.effort), '--sandbox', '--output-format', 'stream-json']
  // No --add-dir: it turns the project read-only in the sandbox. The permission rules already open the folders the Head may use.
  if (a.resume) args.push('--conversation', a.resume)
  return args
}

/**
 * The CLI's own reason a round did not succeed (a usage limit among them), which account switching reads. A result that is not
 * a success puts that reason in `response`, where a model's report also goes, so only a short response counts: a CLI error
 * is a line or two, and a model's report naming "rate limits" must not switch accounts.
 */
export const failureReason = (state: Pick<AgyState, 'status' | 'finalText'>) =>
  state.status && state.status !== 'SUCCESS' && state.finalText.length <= 400 ? state.finalText : ''

/** What a Head's report says when Antigravity has no sign-in: the fix is one run of the CLI. */
export const AGY_NOT_SIGNED_IN = 'Antigravity is not signed in. Run `agy` once in a terminal (choose Google OAuth), then run the Head again.'

/** A round that stopped because the CLI has no sign-in: its result error, or its stderr. */
const AGY_SIGNED_OUT = /authentication failed|not logged into Antigravity/i

/** The error text a Head's report shows for a round: a lost sign-in said plainly, else what the CLI printed. */
export const agyRoundErrors = (stderr: string, state: Pick<AgyState, 'status' | 'finalText'>) => {
  const text = [stderr, failureReason(state)].filter(Boolean).join('\n').slice(-2000)
  return AGY_SIGNED_OUT.test(text) ? AGY_NOT_SIGNED_IN : text
}

async function runRoundAgy(
  $: EngineInterface,
  argv: RoundArgs & { home: string; state: AgyState },
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => Promise<void>,
): Promise<Round> {
  const { state } = argv
  state.finalText = ''
  state.status = undefined
  const turnsBefore = state.turns
  let isCapped = false
  const { errors, exit } = await pump($, agyArgs(argv), argv.cwd, signal, async line => {
    if (!line.trim().startsWith('{')) return false
    let row: AgyRow
    try {
      row = JSON.parse(line) as AgyRow
    } catch {
      return false // A partial or non-JSON line; the init and result rows are what count.
    }
    for (const event of foldAgyRow(row, state)) await onEvent(event)
    if (state.turns - turnsBefore > argv.maxTurns) isCapped = true
    return isCapped
  }, { HOME: argv.home })
  return {
    finalText: state.finalText,
    sessionId: state.conversationId,
    subtype: isCapped ? 'error_max_turns' : state.status === 'SUCCESS' ? 'success' : state.status ? 'error' : undefined,
    code: isCapped ? 8 : exit.code,
    signal: exit.signal,
    errors: agyRoundErrors(errors, state),
  }
}

const AGY_HOME_DIR = '.claude/hydra/heads'

/** `.env` and `.env.*` files that exist under the roots (not in dependency folders): an Antigravity rule names a file, not a pattern. */
async function findEnvFiles($: EngineInterface, roots: readonly string[]): Promise<string[]> {
  const found: string[] = []
  for (const root of roots) {
    const ran = await $.process
      .run(['/usr/bin/find', root, '-maxdepth', '8', '(', '-name', 'node_modules', '-o', '-name', '.git', ')', '-prune', '-o', '-type', 'f', '(', '-name', '.env', '-o', '-name', '.env.*', ')', '-print'], { timeoutMs: 20_000 })
      .catch(() => undefined)
    if (ran?.exitCode === 0) found.push(...ran.stdout.split('\n').filter(Boolean))
  }
  return union(found)
}

/**
 * Makes this Head's `HOME`: its own `settings.json` (the permission rules) and its sign-in, under Hydra's folder in `~/.claude`,
 * owner-only. The sign-in is the account's token file, or the person's own; an agy that keeps it in the macOS keychain instead
 * gets a link to the keychain (`Library/Keychains`), which the rules deny the model's tools. Removed when the Head ends.
 * Returns the folder.
 */
export async function writeAgyHome($: EngineInterface, cwd: string, id: string, needs: HeadNeeds, tokenDir?: string): Promise<string> {
  const real = await homeOf($)
  const dir = `${real}/${AGY_HOME_DIR}/agy-${await $.session.id()}-${id}`
  const config = `${dir}/.gemini/antigravity-cli`
  await $.process.run(['/bin/mkdir', '-p', config])
  await $.process.run(['/bin/chmod', '700', dir, `${dir}/.gemini`, config])
  const token = `${real}/${AGY_TOKEN}`
  if (tokenDir) await $.process.run(['/bin/cp', '-p', agyTokenOf(tokenDir), `${config}/antigravity-oauth-token`])
  else if (await $.fs.exists(token).catch(() => false)) await $.process.run(['/bin/cp', '-p', token, `${config}/antigravity-oauth-token`])
  else if ((await platformOf($)) === 'darwin') {
    await $.process.run(['/bin/mkdir', '-p', `${dir}/Library`])
    await $.process.run(['/bin/ln', '-s', `${real}/Library/Keychains`, `${dir}/Library/Keychains`])
  } else throw new Error(AGY_NOT_SIGNED_IN)
  await writeAgySettings($, dir, cwd, needs)
  return dir
}

/** (Re)writes the Head's rules, looking again for `.env` files: a rule names a file, so each round covers the ones made since the last. */
async function writeAgySettings($: EngineInterface, dir: string, cwd: string, needs: HeadNeeds) {
  const real = await homeOf($)
  const roots = [cwd, ...(needs.writeDirs ?? [])]
  const envFiles = await findEnvFiles($, union(roots, needs.addDirs))
  const present: string[] = []
  for (const temp of AGY_TEMP_DIRS) if (await $.fs.exists(temp).catch(() => false)) present.push(temp)
  const settings = agySettings(cwd, needs, real, envFiles, agyTempDeny(roots, present), await isCaseless($, cwd), dir)
  await $.fs.write(`${dir}/.gemini/antigravity-cli/settings.json`, JSON.stringify(settings, null, 2) + '\n')
}

/** Removes a Head's `HOME` folder; refuses any path that is not one of Hydra's own. */
async function removeAgyHome($: EngineInterface, dir: string) {
  if (dir.includes(`/${AGY_HOME_DIR}/agy-`)) await $.process.run(['/bin/rm', '-rf', dir]).catch(() => undefined)
}

/** Head folders a crashed session left behind: a Head never runs for a day. */
export async function sweepAgyHomes($: EngineInterface) {
  const home = await homeOf($)
  if (!home) return
  const folder = `${home}/${AGY_HOME_DIR}`
  const now = await $.clock.now()
  const entries = await $.fs.list(folder).catch(() => [])
  for (const entry of entries) {
    if (entry.kind === 'dir' && entry.name.startsWith('agy-')) {
      const stat = await $.fs.stat(`${folder}/${entry.name}`).catch(() => undefined)
      if (stat && now - stat.mtimeMs > 86_400_000) await removeAgyHome($, `${folder}/${entry.name}`)
    }
  }
}

type AgyHead = { task: string; cwd: string; model: string; maxTurns: number; addDirs: string[]; writeDirs: string[]; shell: boolean; minutes: number; effort?: string; /** An extra account's folder: the sign-in token is copied from there instead of the person's own home. */ tokenDir?: string; guarded?: Guarded }

/** A Head on Antigravity: its own HOME with permission rules, then rounds until it reports HEAD DONE. */
export async function runAgyHead($: EngineInterface, head: AgyHead, outer: AbortSignal, limits: HeadLimits, id: string) {
  const { cwd, model } = head
  let home = ''
  const refusal =
    /^[A-Za-z]:|^\\\\|\\/.test(cwd)
      ? `${cwd} is a Windows path, and Hydra's rules use POSIX paths. Run Claude Code under WSL instead.`
      : (await agyCaseRefusal($, cwd, { addDirs: head.addDirs, writeDirs: head.writeDirs, shell: head.shell, guarded: head.guarded })) ?? await writeAgyHome($, cwd, id, { addDirs: head.addDirs, writeDirs: head.writeDirs, shell: head.shell, guarded: head.guarded }, head.tokenDir).then(
          dir => {
            home = dir
            return undefined
          },
          error => `Hydra could not set up the Head's Antigravity settings (${String(error).slice(0, 160)}). Check that you are signed in (\`agy\`) and ~/.claude is writable, then run the Head again.`,
        )
  if (refusal) {
    await removeAgyHome($, home)
    await setRun($, id, { state: 'failed', endedAt: await $.clock.now(), activity: refusal })
    await refreshStatus($, limits)
    return notStarted(id, model, cwd, `${refusal} A Head never starts without Hydra's rules.`, 'agy')
  }
  try {
    return await runAgyRounds($, head, home, outer, limits, id)
  } finally {
    await removeAgyHome($, home)
  }
}

async function runAgyRounds($: EngineInterface, head: AgyHead, home: string, outer: AbortSignal, limits: HeadLimits, id: string) {
  const { task, cwd, model, maxTurns, minutes } = head
  const addDirs = union(head.addDirs, head.writeDirs)
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
  await snapshotChangedFiles($, id, [cwd, ...head.writeDirs])
  const state = newAgyState()
  const labels = new Map<string, string>()
  const onEvent = async (event: StreamEvent) => {
    await setRun($, id, run => applyEvent(run, event, labels, cwd))
  }
  const roundAt = async (round: { prompt: string; maxTurns: number; resume?: string }) => {
    const effort = await effortNow()
    await setRun($, id, { effort })
    await writeAgySettings($, home, cwd, { addDirs, writeDirs: head.writeDirs, shell: head.shell, guarded: head.guarded }).catch(() => undefined)
    const ran = await runRoundAgy($, { ...round, model, effort, cwd, addDirs, home, state }, signal, onEvent)
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
  const files = await changedFiles($, startedAt, [cwd, ...head.writeDirs])
  const endedAt = await $.clock.now()
  const edits = await compareChangedFiles($, id, { cwd, startedAt, endedAt }, [cwd, ...head.writeDirs])
  const tokens = tokensText(state.inputTokens, state.outputTokens)
  const finished = isFinished(round.finalText)
  const isDone = round.code === 0 && round.subtype === 'success' && finished
  const stopped = outer.aborted ? stopReason(outer) : undefined
  await setRun($, id, {
    state: isDone ? 'done' : 'failed', turns: state.turns, tokens, endedAt,
    files: files.map(file => relativeTo(cwd, file)), summary: summaryOf(round.finalText),
    activity: isDone ? undefined : timedOut ? `timed out after ${minutes} min` : stopped ?? (round.subtype === 'error_max_turns' ? `stopped at the ${maxTurns}-turn cap` : 'stopped before HEAD DONE'),
  })
  void refreshHeads($, limits)

  const text = formatReport({
    id, model, effort: round.effort, cwd, sessionId, finished, rounds, turns: state.turns, usd: null, files, denied: state.denied,
    finalText: round.finalText, exit: timedOut ? `timed out after ${minutes} min` : stopped ?? String(round.code ?? round.signal), errors: round.errors,
    writeDirs: head.writeDirs, engine: 'agy', tokens,
    reverted: edits.reverted, restored: edits.restored, overwritten: edits.overwritten, alsoRan: edits.alsoRan,
  })
  return { text, isDone, failure: isDone ? undefined : round.errors, files }
}
