/**
 * @author Shakib
 * @since 15/10/26
 */
import type { EngineInterface } from 'claude-code'

import type { HeadRun, HeadsUsage, LeadWindow } from '../../types'
import { AGY_TOKEN, DEFAULT_ENGINE, ENGINE_BIN, ENGINE_LABEL, engineOf, isAuto, poolOf } from './engines'
import type { Engine } from './engines'
import { AGY_NO_SPEND, AUTO_NO_SPEND, CODEBUDDY_NO_SPEND, CODEX_NO_SPEND, OPENCODE_NO_SPEND, WORKBUDDY_NO_SPEND, WARN_AT, formatReport, leadLabel, overlappingHeads, resetsIn, statusLine, stopRuns } from './format'
import type { HeadLimits } from './format'
import { WORKBUDDY_LOGIN, engineChecks } from './checks'
import { AUTO_CONSENT_QUESTION, CHECK_CONSENT_QUESTION, CHECK_CONSENT_YES, CONSENT_QUESTION, CONSENT_YES } from './policy'
import { isWithin, secretDirRefusal, union } from './safety'
import { canRun, commandOf, homeOf, platformOf, pythonOf, runScript, toSlashes } from './platform'
import { readHeads, readMode, readRuns, readWarned, updateHeads, updateLead, updateRuns, updateWarned } from './state'

const STATUS_KEEP_MS = 7 * 86_400_000
const CONSENT_KEY = 'consent-v1'

export const DONE_MARK = 'HEAD DONE'
export const MAX_ROUNDS = 8
export const MAX_PARALLEL = 6
export const DEFAULT_MINUTES = 40
export const START_RETRIES = 2

/** The `headEngine` option, for code outside `register` that reads a stored mode without an engine. */
let configuredEngine: Engine = DEFAULT_ENGINE
export const setConfiguredEngine = (engine: Engine) => {
  configuredEngine = engine
}

/** Where the person's status line command finds this session's Hydra line; empty while Hydra is off. */
export const statusFile = (home: string, sessionId: string) => `${home}/.claude/hydra/status/${sessionId}.txt`

let lastStatus: string | undefined

/**
 * Hydra's line goes to a per-session file that ~/.claude/statusline.sh prints, not to `$.ui.status`, which the
 * engine draws with a `⚠ hydra:` prefix.
 */
export async function refreshStatus($: EngineInterface, limits: HeadLimits) {
  const line = statusLine(await readMode($), await readHeads($), limits) ?? ''
  if (line === lastStatus) return
  const home = await homeOf($)
  if (!home) return
  await $.fs.write(statusFile(home, await $.session.id()), line ? `${line}\n` : '')
  lastStatus = line
}

/** Deletes other sessions' status files untouched for a week. */
export async function sweepStatusFiles($: EngineInterface) {
  const home = await homeOf($)
  if (!home) return
  const folder = `${home}/.claude/hydra/status`
  const now = await $.clock.now()
  const own = `${await $.session.id()}.txt`
  const entries = await $.fs.list(folder).catch(() => [])
  const old = entries.filter(entry => entry.kind === 'file' && entry.name.endsWith('.txt') && entry.name !== own && now - entry.mtimeMs > STATUS_KEEP_MS)
  if (old.length > 0) await $.process.run(['/bin/rm', '-f', ...old.map(entry => `${folder}/${entry.name}`)]).catch(() => undefined)
}

export type Preflight = { problems: string[]; warnings: string[] }

const preflightPassed = new Set<Engine>()

/** How to install each engine's CLI and sign in, as one line the person can act on. */
export const INSTALL_HINT: Record<Engine, string> = {
  commandcode: 'The Command Code CLI is not installed. Run `npm i -g command-code`, then `commandcode` once in a terminal to sign in.',
  codebuddy: 'The CodeBuddy CLI is not installed. Run `npm i -g @tencent-ai/codebuddy-code`, then `codebuddy` once in a terminal to sign in.',
  codex: 'The Codex CLI is not installed. Run `npm i -g @openai/codex`, then `codex login` in a terminal to sign in.',
  agy: 'The Antigravity CLI is not installed. Run `curl -fsSL https://antigravity.google/cli/install.sh | bash` (read the script first if you like), then `agy` once in a terminal to sign in.',
  workbuddy: `The CodeBuddy CLI is not installed. WorkBuddy Heads run it: run \`npm i -g @tencent-ai/codebuddy-code\`, then \`${WORKBUDDY_LOGIN}\` and /login to sign in.`,
  opencode: 'The OpenCode CLI is not installed. Run `curl -fsSL https://opencode.ai/install | bash` (or `npm i -g opencode-ai`), then `opencode auth login`, or use its free models without signing in.',
}

/**
 * Engines whose lockdown has been verified on native Windows. An engine left out refuses to start there instead of
 * running a Head unlocked: Command Code's path rules do not match drive paths (see DEVELOPING.md), and the others have
 * not been smoke-tested on Windows yet. Under WSL Hydra is on Linux and every engine runs.
 */
export const WINDOWS_ENGINES: ReadonlySet<Engine> = new Set<Engine>()

export const windowsRefusal = (engine: Engine) =>
  `${ENGINE_LABEL[engine]} Heads are not locked down on native Windows yet, so Hydra will not start them there. Run Claude Code under WSL (every engine works there)${WINDOWS_ENGINES.size > 0 ? `, or use ${[...WINDOWS_ENGINES].map(name => ENGINE_LABEL[name]).join(' or ')}` : ''}.`

/** What stops Heads from running on this machine, each with what to run about it. */
export async function preflight($: EngineInterface, engine: Engine = DEFAULT_ENGINE): Promise<Preflight> {
  if (preflightPassed.has(engine)) return { problems: [], warnings: [] }
  const works = (argv: readonly string[]) => $.process.run(argv, { timeoutMs: 15_000 }).then(ran => ran.exitCode === 0, () => false)
  const isWindows = (await platformOf($)) === 'windows'
  if (isWindows && !WINDOWS_ENGINES.has(engine)) return { problems: [windowsRefusal(engine)], warnings: [] }
  const problems: string[] = []
  if (!(await canRun($, ENGINE_BIN[engine]))) problems.push(INSTALL_HINT[engine])
  if (!(await pythonOf($))) {
    problems.push(isWindows
      ? 'Python 3 is missing; Hydra reads Head transcripts with it. Install it from python.org (it adds the `py` launcher).'
      : 'python3 is missing; Hydra reads Head transcripts with it. Install it (on macOS: `xcode-select --install`).')
  }
  if (!(await works(['git', '--version']))) problems.push('git is missing. Install it (on macOS: `xcode-select --install`).')
  const home = await homeOf($)
  const warnings: string[] = []
  if (engine === 'codex' && problems.length === 0 && !(await canRun($, 'codex', ['login', 'status']))) {
    problems.push('Codex is not signed in. Run `codex login` in a terminal (`codex login --device-auth` on a remote machine), then try again.')
  }
  if (engine === 'agy' && problems.length === 0 && !(home && (await $.fs.exists(`${home}/${AGY_TOKEN}`).catch(() => false)))) {
    // A newer agy keeps the sign-in in the macOS keychain, where nothing on disk says whether it is there: a Head may still start.
    if ((await platformOf($)) === 'darwin') warnings.push('Antigravity keeps its sign-in in the macOS keychain here, so Hydra cannot check it before a Head starts. If a Head stops with "not signed in", run `agy` once in a terminal.')
    else problems.push('Antigravity is not signed in. Run `agy` once in a terminal (choose Google OAuth), then try again.')
  }
  const isSignedIn = engine !== 'commandcode' || (home ? await $.fs.exists(`${home}/.commandcode/auth.json`).catch(() => false) : false)
  if (!isSignedIn && problems.length === 0) warnings.push('Command Code looks signed out: run `commandcode` once in a terminal to sign in, or Heads will fail.')
  if (problems.length === 0) {
    const extra = await engineChecks($, engine, home)
    problems.push(...extra.problems)
    warnings.push(...extra.warnings)
  }
  if (problems.length === 0) preflightPassed.add(engine)
  return { problems, warnings }
}

export const preflightText = (check: Preflight) =>
  [`🐉 Hydra can't start yet:`, ...check.problems.map(problem => `  • ${problem}`), 'Then run /hydra again.'].join('\n')

/** A control call that turns Hydra on or names an engine or pool must pass the readiness and consent checks `/hydra` runs. */
export const needsEngineCheck = (action: string, input: Readonly<Record<string, unknown>>) =>
  action === 'on' || input.engine !== undefined || input.engines !== undefined

const consentKey = (engine: Engine) => (engine === 'commandcode' ? CONSENT_KEY : `${CONSENT_KEY}:${engine}`)

/** Asks once for every engine in `engines` that has no saved answer; the answers are kept across sessions. */
export async function hasConsentAll($: EngineInterface, engines: readonly Engine[], mayAsk: boolean) {
  const missing: Engine[] = []
  for (const engine of engines) if ((await $.store.get(consentKey(engine))) !== true) missing.push(engine)
  if (missing.length === 0) return true
  if (!mayAsk) return false
  const answer = await $.ui.ask(AUTO_CONSENT_QUESTION(missing), { options: [CONSENT_YES, 'Not now'], header: 'Hydra' }).catch(() => undefined)
  if (answer !== CONSENT_YES) return false
  for (const engine of missing) await $.store.set(consentKey(engine), true)
  return true
}

/** Checks each wanted engine on this machine: the ready ones form the pool, the others come back with what to run about them. */
export async function readyEngines($: EngineInterface, wanted: readonly Engine[]) {
  const pool: Engine[] = []
  const skipped: { engine: Engine; problem: string }[] = []
  const warnings: string[] = []
  for (const engine of wanted) {
    const check = await preflight($, engine)
    if (check.problems.length === 0) {
      pool.push(engine)
      warnings.push(...check.warnings)
    } else skipped.push({ engine, problem: check.problems[0]! })
  }
  return { pool, skipped, warnings }
}

const CHECK_CONSENT_KEY = 'consent-check-v1'

/** Asks once, the first time Claude gives a Head a `check`: Hydra then runs code on the person's machine without the Bash prompt. */
export async function hasCheckConsent($: EngineInterface, check: string) {
  if ((await $.store.get(CHECK_CONSENT_KEY)) === true) return true
  const answer = await $.ui.ask(CHECK_CONSENT_QUESTION(check), { options: [CHECK_CONSENT_YES, 'Not now'], header: 'Hydra' }).catch(() => undefined)
  if (answer !== CHECK_CONSENT_YES) return false
  await $.store.set(CHECK_CONSENT_KEY, true)
  return true
}

/** Asks once, the first time Hydra turns on; the answer is kept across sessions. */
export async function hasConsent($: EngineInterface, headModel: string, mayAsk: boolean, engine: Engine = DEFAULT_ENGINE) {
  const key = consentKey(engine)
  if ((await $.store.get(key)) === true) return true
  if (!mayAsk) return false
  const answer = await $.ui.ask(CONSENT_QUESTION(headModel, engine), { options: [CONSENT_YES, 'Not now'], header: 'Hydra' }).catch(() => undefined)
  if (answer !== CONSENT_YES) return false
  await $.store.set(key, true)
  return true
}

export async function refreshHeads($: EngineInterface, limits: HeadLimits) {
  const hydra = await readMode($)
  const engine = engineOf(hydra, configuredEngine)
  const hasCommandCode = isAuto(hydra) ? poolOf(hydra).includes('commandcode') : engine === 'commandcode'
  if (!hasCommandCode) {
    const measuredAt = await $.clock.now()
    const error = isAuto(hydra) ? AUTO_NO_SPEND : engine === 'agy' ? AGY_NO_SPEND : engine === 'codex' ? CODEX_NO_SPEND
      : engine === 'workbuddy' ? WORKBUDDY_NO_SPEND : engine === 'opencode' ? OPENCODE_NO_SPEND : CODEBUDDY_NO_SPEND
    await updateHeads($, () => ({ fiveHour: { usd: 0, resetsAt: null }, weekly: { usd: 0, resetsAt: null }, measuredAt, error }))
    await refreshStatus($, limits)
    return
  }
  try {
    const ran = await runScript($, 'cc-usage.py', [], 20_000)
    const usage = JSON.parse(ran.stdout) as HeadsUsage
    await updateHeads($, () => usage)
  } catch (error) {
    const measuredAt = await $.clock.now()
    await updateHeads($, () => ({
      fiveHour: { usd: 0, resetsAt: null },
      weekly: { usd: 0, resetsAt: null },
      measuredAt,
      error: String(error).slice(0, 120),
    }))
  }
  await refreshStatus($, limits)
}

export async function storeLead($: EngineInterface, windows: readonly LeadWindow[], limits: HeadLimits) {
  await updateLead($, () => windows.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt })))
  for (const w of windows) {
    const mark = `${w.kind}@${w.resetsAt ?? ''}`
    if (w.percentUsed < WARN_AT || (await readWarned($)).includes(mark)) continue
    await updateWarned($, list => [...list, mark].slice(-20))
    $.ui.toast(`Claude ${leadLabel(w.kind)} at ${Math.round(w.percentUsed)}% · ${resetsIn(w.resetsAt, await $.clock.now())}`)
  }
  await refreshStatus($, limits)
}

export async function setRun($: EngineInterface, id: string, change: Partial<HeadRun> | ((run: HeadRun) => Partial<HeadRun>)) {
  await updateRuns($, list => list.map(run => (run.id === id ? { ...run, ...(typeof change === 'function' ? change(run) : change) } : run)))
}

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

/**
 * The real folders a Head asked to write to outside `cwd`, or why one is refused: it must exist, and must not be
 * `/`, the home folder, a folder above the project or one inside it.
 */
export async function resolveWriteDirs($: EngineInterface, cwd: string, dirs: readonly string[]): Promise<{ dirs: string[] } | { refusal: string }> {
  const home = await homeOf($)
  const realHome = home ? ((await $.fs.stat(home, { resolve: true }).catch(() => undefined))?.realPath ?? home) : ''
  const realCwd = (await $.fs.stat(cwd, { resolve: true }).catch(() => undefined))?.realPath ?? cwd
  const resolved: string[] = []
  for (const dir of dirs) {
    if (!dir.startsWith('/')) return { refusal: `writeDirs needs absolute folders; "${dir}" is not one.` }
    const stat = await $.fs.stat(dir, { resolve: true }).catch(() => undefined)
    const real = stat?.realPath
    if (!stat || stat.kind !== 'dir' || !real) return { refusal: `writeDirs: ${dir} is not an existing folder.` }
    if (real === '/' || (realHome && isWithin(realHome, real)) || isWithin(realCwd, real)) return { refusal: `writeDirs: ${dir} is too broad: it holds the project or your home folder. Name the folder the task changes.` }
    const secret = secretDirRefusal([real], realHome, 'writeDirs')
    if (secret) return { refusal: secret }
    if (isWithin(real, realCwd)) return { refusal: `writeDirs: ${dir} is inside the project, which a Head can write to already.` }
    resolved.push(real)
  }
  return { dirs: union(resolved) }
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

export const gate = createGate(MAX_PARALLEL)

/**
 * Background Heads run in a worker loop that `session.start` owns, on that hook's `$`: a `tool.call` hook's `$`
 * lapses once the call is long over, and a Head spawned under it dies with it. The tool call only queues the job.
 */
export type HeadResult = {
  text: string
  isDone: boolean
  /** What the CLI itself reported as the reason a Head stopped (its error output), not the model's report: the only text `isQuotaFailure` reads. */
  failure?: string
  /** The files the Head edited, as the engine saw them. */
  files?: string[]
}
/** `reply` hands a foreground call its result; it answers false once that call is gone, and the report goes out as a message. */
export type Job = { input: Record<string, unknown>; headModel: string; id: string; engine?: Engine; reply?: (result: HeadResult) => boolean }

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
export const controllers = new Map<string, AbortController>()

export const stopReason = (signal: AbortSignal) => (typeof signal.reason === 'string' && signal.reason ? signal.reason : 'stopped')

/**
 * Waits for a worker-run Head's result by repeatedly awaiting `pause`, which must be a `$` call (a host `sleep`):
 * the engine stops a hook's own clock while a `$` call is in flight, so the wait costs no budget. Ends early on abort.
 */
export const waitForResult = async <T,>(box: { result?: T }, signal: AbortSignal, pause: () => Promise<void>): Promise<T | undefined> => {
  while (box.result === undefined && !signal.aborted) await pause().catch(() => undefined)
  return box.result
}

/** Stops live Heads by id; ones with no process behind them are marked failed at once. Returns those. */
export async function stopHeadsNow($: EngineInterface, ids: readonly string[], reason: string, limits: HeadLimits) {
  for (const id of ids) controllers.get(id)?.abort(reason)
  const ghosts = ids.filter(id => !controllers.has(id))
  const now = await $.clock.now()
  if (ghosts.length > 0) await updateRuns($, current => stopRuns(current, ghosts, `${reason} (no live process)`, now))
  await refreshStatus($, limits)
  return ghosts
}

/** Names handed out in this module's life, so parallel calls never get the same one before their runs are recorded. */
export const usedNames = new Set<string>()

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

export const backgroundJobs = createJobQueue()

/** Prompts a command hands to the session to submit: a command's own `$` may lapse before the session is idle. */
export const pendingPrompts = createQueue<string>()

export type Round = { finalText: string; sessionId?: string; subtype?: string; code: number | null; signal?: string; errors: string; startedSession?: string }
export type RoundArgs = { prompt: string; model: string; effort?: string; maxTurns: number; resume?: string; cwd: string; addDirs: readonly string[]; /** Set over the host's environment for this CLI run: the account the Head runs on. */ env?: Record<string, string> }

/**
 * A watchdog for a CLI that can hang without a word: the child is stopped when no stdout has arrived `firstMs` after the
 * start, or `idleMs` after the last stdout. Either may be left out.
 */
export type IdleLimits = { firstMs?: number; idleMs?: number }

/** How long a watched child may stay silent from now, or undefined for no limit. */
export const silenceLeft = (limits: IdleLimits, startedAt: number, lastOutputAt: number | undefined, now: number) => {
  const limit = lastOutputAt === undefined ? limits.firstMs : limits.idleMs
  return limit === undefined ? undefined : Math.max(0, (lastOutputAt ?? startedAt) + limit - now)
}

/**
 * Spawns a Head's CLI and feeds each stdout line to `onLine` (which returns true to stop the run early). The stream
 * read is raced against `signal`, so a silent child (a model thinking, a hung CLI) cannot hold a stopped Head open,
 * and against the `idle` watchdog when one is given: a child silent for too long is stopped with signal `idle`.
 */
export async function pump(
  $: EngineInterface,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  onLine: (line: string) => Promise<boolean>,
  env?: Record<string, string>,
  idle?: IdleLimits,
): Promise<{ errors: string; exit: { code: number | null; signal?: string }; isStopped: boolean }> {
  const [bin, ...rest] = args
  const child = $.process.spawn({ argv: [...(await commandOf($, bin!)), ...rest], cwd, input: '', ...(env ? { env } : {}) })
  let pending = ''
  let errors = ''
  let isStopped = false
  let isIdle = false
  const startedAt = idle ? await $.clock.now() : 0
  let lastOutputAt: number | undefined
  const aborted = new Promise<'aborted'>(resolve => {
    if (signal.aborted) resolve('aborted')
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true })
  })
  for (;;) {
    const left = idle ? silenceLeft(idle, startedAt, lastOutputAt, await $.clock.now()) : undefined
    const timer = new AbortController()
    const silent = left === undefined
      ? new Promise<never>(() => undefined)
      : $.clock.sleep(left, { signal: timer.signal }).then(() => 'idle' as const, () => new Promise<never>(() => undefined))
    const step = await Promise.race([child.next(), aborted, silent])
    timer.abort()
    if (step === 'aborted') {
      void child.return({ code: null, signal: 'aborted' }).catch(() => undefined)
      break
    }
    if (step === 'idle') {
      isIdle = true
      void child.return({ code: null, signal: 'idle' }).catch(() => undefined)
      break
    }
    if (step.done) break
    const { stream, text } = step.value
    if (stream === 'stderr') {
      errors = (errors + text).slice(-2000)
      continue
    }
    if (idle) lastOutputAt = await $.clock.now()
    const lines = (pending + text).split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (await onLine(line)) isStopped = true
      if (isStopped) break
    }
    if (isStopped) {
      void child.return({ code: null, signal: 'stopped' }).catch(() => undefined)
      break
    }
  }
  if (!isStopped && !isIdle && !signal.aborted && (await onLine(pending))) isStopped = true
  const exit = signal.aborted ? { code: null, signal: 'aborted' }
    : isIdle ? { code: null, signal: 'idle' }
    : isStopped ? { code: null, signal: 'stopped' } : await child.result.catch(() => ({ code: null, signal: 'lost' }))
  return { errors, exit: { code: exit.code ?? null, signal: 'signal' in exit ? String(exit.signal ?? '') : undefined }, isStopped }
}

export const notStarted = (id: string, model: string, cwd: string, reason: string, engine: Engine = 'codebuddy') => ({
  text: formatReport({
    id, model, cwd, finished: false, rounds: 0, turns: 0, usd: 0, files: [], denied: [], finalText: '',
    exit: 'not started', rulesNote: reason, engine,
  }),
  isDone: false,
})

/** Prints the real path of each argument as a JSON list; one Python call works on every platform, unlike `realpath`. */
const REALPATHS = 'import json, os, sys; print(json.dumps([os.path.realpath(p) for p in sys.argv[1:]]))'

/** The real path of each folder, so the profile's rules match what the sandbox sees through a symlink. */
export async function realPaths($: EngineInterface, paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) return []
  const python = await pythonOf($)
  const ran = python
    ? await $.process.run([...python, '-I', '-c', REALPATHS, ...paths], { timeoutMs: 10_000 }).catch(() => undefined)
    : undefined
  const real = ran?.exitCode === 0 ? (JSON.parse(ran.stdout) as string[]) : []
  return paths.map((path, index) => (real[index] ? toSlashes(real[index]!) : path))
}

/** Files under `dirs` written since `since` (ms), by the file system's own account: Codex's stream misses what a shell command writes. */
export async function changedFiles($: EngineInterface, since: number, dirs: readonly string[]): Promise<string[]> {
  try {
    const ran = await runScript($, 'changed-files.py', [String(since - 2_000), ...dirs])
    return JSON.parse(ran.stdout) as string[]
  } catch {
    return []
  }
}

/** Each Head's uncommitted files and their sha1 when it started, by id: what its report must not call its own edits. */
const editsBefore = new Map<string, Record<string, string>>()

/** The uncommitted files under `dirs` and their sha1, kept for `id`; the first call wins, so a resumed Head keeps its start. */
export async function snapshotChangedFiles($: EngineInterface, id: string, dirs: readonly string[]): Promise<Record<string, string>> {
  const kept = editsBefore.get(id)
  if (kept) return kept
  try {
    const ran = await runScript($, 'changed-files.py', ['--snapshot', ...dirs])
    const snapshot = JSON.parse(ran.stdout) as Record<string, string>
    editsBefore.set(id, snapshot)
    return snapshot
  } catch {
    editsBefore.set(id, {})
    return {}
  }
}

export type EditConflicts = {
  /** Snapshot files the Head changed that still differ from git. */
  overwritten: string[]
  /** Snapshot files now back to the committed version, or deleted: edits made before the Head started are gone. */
  reverted: string[]
  /** Tracked files rewritten during the Head that match the committed version: an edit made there while it ran is gone. */
  restored: string[]
  /** Other Heads that ran in this folder, or one inside or holding it, during this Head. */
  alsoRan: string[]
}

/** Writes the snapshot where Python can read it: `runScript` passes no stdin. */
async function snapshotFile($: EngineInterface, id: string, snapshot: Record<string, string>) {
  const temp = (await $.env.get('TMPDIR')) || (await $.env.get('TEMP')) || '/tmp'
  const file = `${temp.replace(/\/$/, '')}/hydra-edits-${id}.json`
  await $.fs.write(file, JSON.stringify(snapshot))
  return file
}

/** What the Head did to edits that were uncommitted before it started, and the Heads that ran beside it. */
export async function compareChangedFiles($: EngineInterface, id: string, head: { cwd: string; startedAt?: number; endedAt?: number }, dirs: readonly string[]): Promise<EditConflicts> {
  const snapshot = editsBefore.get(id) ?? {}
  let edits = { overwritten: [] as string[], reverted: [] as string[], restored: [] as string[] }
  // Runs with an empty snapshot too: a clean tree at the start can still lose an edit made while the Head ran.
  let file: string | undefined
  try {
    file = await snapshotFile($, id, snapshot)
    const since = head.startedAt ?? (await $.clock.now())
    const ran = await runScript($, 'changed-files.py', ['--compare', file, String(since), ...dirs])
    const parsed = JSON.parse(ran.stdout) as Partial<typeof edits>
    edits = { overwritten: parsed.overwritten ?? [], reverted: parsed.reverted ?? [], restored: parsed.restored ?? [] }
  } catch {
    // No report line beats a wrong one.
  } finally {
    if (file) await $.process.run(['/bin/rm', '-f', file]).catch(() => undefined)
  }
  editsBefore.delete(id)
  return { ...edits, alsoRan: overlappingHeads(await readRuns($), { id, ...head }) }
}
