/**
 * @author Shakib
 * @since 15/10/26
 */
import type { EngineInterface } from 'claude-code'

import { effortModeOf, headEffort, nearestEffort, supportedEfforts } from '../lib/effort'
import { applyEvent, formatReport, relativeTo } from '../lib/format'
import type { HeadLimits, SessionReport, StreamEvent } from '../lib/format'
import { HEAD_RULES, MAX_ROUNDS, START_RETRIES, compareChangedFiles, continuePrompt, isFinished, isResumable, pump, refreshHeads, refreshStatus, setRun, snapshotChangedFiles, stopReason, summaryOf } from '../lib/runtime'
import type { Round, RoundArgs } from '../lib/runtime'
import { DANGEROUS_SHELL, SECRET_PATHS, guardCommand, isWithin, trimSlash, union } from '../lib/safety'
import type { HeadNeeds } from '../lib/safety'
import { homeOf, runScript } from '../lib/platform'
import { baseName } from '../lib/protect'
import type { Guarded } from '../lib/protect'
import { readMode } from '../lib/state'

const RULES_FILE = '.commandcode/settings.local.json'
const OWNER = 'hydra'

const WATCHED = new Set(['turn_end', 'thinking_start', 'tool_queued', 'tool_running', 'tool_completed', 'tool_denied'])

/** The session a Head started, found from its transcript when the run ended before reporting it (a timeout, a kill). */
async function findSession($: EngineInterface, since: number, task: string): Promise<string | undefined> {
  try {
    const ran = await runScript($, 'cc-usage.py', ['--find', String(since - 5_000), task.slice(0, 100)])
    return (JSON.parse(ran.stdout) as { sessionId: string | null }).sessionId ?? undefined
  } catch {
    return undefined
  }
}

async function sessionReport($: EngineInterface, sessionId: string): Promise<SessionReport> {
  try {
    const ran = await runScript($, 'cc-usage.py', ['--report', sessionId])
    return JSON.parse(ran.stdout) as SessionReport
  } catch {
    return { usd: null, files: [], denied: [], toolCalls: 0 }
  }
}

/**
 * Inside the project a Head may edit anything except the repo's history, Hydra's own rules and secret files.
 * Shell rules match `.env` only as a path (after a space, `/` or `=`), so `process.env` still runs.
 */
export const PROJECT_DENY = [
  'Edit(/.git/**)', 'Edit(/.commandcode/**)', 'Edit(.hydraignore)', 'Shell(* .hydraignore*)', 'Shell(*/.hydraignore*)', 'Shell(*=.hydraignore*)',
  'Read(.env)', 'Read(.env.*)', 'Edit(.env)', 'Edit(.env.*)', 'Shell(* .env*)', 'Shell(*/.env*)', 'Shell(*=.env*)',
]

/** The grep tool ignores Read rules and has no path-scoped deny, so it is denied whole when a `.env` file is in reach. */
export const SEARCH_DENY = 'Grep'

type Permissions = { allow?: string[]; deny?: string[]; additionalDirectories?: string[] }
type GuardHook = { matcher: string; hooks: { type: 'command'; command: string; timeout: number }[] }

/** A running Head the rules file is kept for: `key` is `<session id>/<head id>`, `until` when it must have ended. */
export type HeadEntry = HeadNeeds & { key: string; until: number }
type HeadSettings = { managedBy?: string; hydraHeads?: HeadEntry[]; permissions?: Permissions; hooks?: { PreToolUse: GuardHook[] } }

/**
 * Hydra's rules for Heads run under --yolo: deny rules are the only thing yolo honours, so every write outside the
 * project is denied path by path, and shell is denied outright unless a running Head in this project asked for it.
 */
/** The folders outside the project that the running Heads may write to, from every Head's `writeDirs`. */
export const writeDirsOf = (heads: readonly HeadNeeds[]) => heads.reduce<string[]>((dirs, head) => union(dirs, head.writeDirs ?? []), [])

/** What stays protected inside a folder a Head may write to: its history, its Command Code settings and its secrets. */
export const writeDirDeny = (dir: string) => [
  `Edit(/${dir}/.git/**)`, `Edit(/${dir}/.commandcode/**)`, `Edit(/${dir}/**/.hydraignore)`,
  `Edit(/${dir}/**/.env)`, `Edit(/${dir}/**/.env.*)`, `Read(/${dir}/**/.env)`, `Read(/${dir}/**/.env.*)`,
]

/**
 * The person's credential folders, denied to the read tool (and to shell commands that name them): under --yolo a
 * Command Code Head can otherwise read any file on the disk. Its grep tool ignores Read rules, which is why it is
 * denied whole whenever a `.env` file is in reach; a credential folder outside the project is beyond its search root.
 * The shell rules name the folder under home (`/Users/me/.aws`, `~/.aws`, `$HOME/.aws`), so a project's own `.docker`
 * folder stays usable.
 */
export const secretReadDeny = (home: string) => {
  const base = trimSlash(home)
  if (!base || base === '/') return []
  return SECRET_PATHS.flatMap(dir => [
    `Read(/${base}/${dir})`, `Read(/${base}/${dir}/**)`, `Shell(*${base}/${dir}*)`, `Shell(*~/${dir}*)`, `Shell(*$HOME/${dir}*)`, `Shell(*\${HOME}/${dir}*)`,
  ])
}

/** The paths `.hydraignore` names, kept from every tool as `.env` files are: read, edit, and shell lines that name them. */
export const guardedDeny = (paths: readonly string[]) => [
  ...paths.flatMap(path => [`Read(/${path})`, `Read(/${path}/**)`, `Edit(/${path})`, `Edit(/${path}/**)`]),
  ...[...new Set(paths.map(baseName))].flatMap(name => [`Shell(* ${name}*)`, `Shell(*/${name}*)`, `Shell(*=${name}*)`]),
]

/** Every running Head's `.hydraignore` matches. */
export const guardedOf = (heads: readonly HeadNeeds[]) => heads.reduce<string[]>((paths, head) => union(paths, head.guarded?.paths ?? []), [])

export const headSettings = (heads: readonly HeadNeeds[], outsideDeny: readonly string[], hasEnvFile = false, guard?: string, home = ''): HeadSettings => {
  const shell = heads.some(head => head.shell)
  const writeDirs = writeDirsOf(heads)
  const guarded = guardedOf(heads)
  return {
    managedBy: OWNER,
    permissions: {
      deny: [
        ...outsideDeny, ...PROJECT_DENY, ...writeDirs.flatMap(writeDirDeny), ...secretReadDeny(home), ...guardedDeny(guarded),
        ...(shell ? DANGEROUS_SHELL : ['Shell']), ...(hasEnvFile || guarded.length > 0 ? [SEARCH_DENY] : []),
      ],
      additionalDirectories: heads.reduce<string[]>((dirs, head) => union(dirs, [...head.addDirs, ...(head.writeDirs ?? [])]), []),
    },
    ...(guard ? { hooks: { PreToolUse: [{ matcher: 'write|edit', hooks: [{ type: 'command' as const, command: guard, timeout: 10 }] }] } } : {}),
  }
}

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
export async function writeRules($: EngineInterface, cwd: string): Promise<string | undefined> {
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
  const envFile = (await findEnvFile($, [cwd, ...heads.reduce<string[]>((dirs, head) => union(dirs, head.addDirs), []), ...writeDirs])) ?? guardedOf(heads)[0]
  if (envFile) searchOff.set(cwd, envFile)
  else searchOff.delete(cwd)
  const outsideDeny = await outsideDenyRules($, [cwd, ...writeDirs])
  const settings = { ...headSettings(heads, outsideDeny, Boolean(envFile), guardCommand($.plugin.root, cwd, writeDirs), await homeOf($)), hydraHeads: heads }
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

async function runRound(
  $: EngineInterface,
  argv: RoundArgs,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => Promise<void>,
): Promise<Round> {
  const args = ['commandcode', '-p', argv.prompt, '-m', argv.model, '--max-turns', String(argv.maxTurns),
    '--output-format', 'json', '--skip-onboarding', '--yolo', '--trust']
  for (const dir of argv.addDirs) args.push('--add-dir', dir)
  if (argv.effort) args.push('--effort', argv.effort)
  if (argv.resume) args.push('--resume', argv.resume)
  let result: Record<string, unknown> | null = null
  const { errors, exit } = await pump($, args, argv.cwd, signal, async line => {
    if (!line.trim().startsWith('{')) return false
    try {
      const row = JSON.parse(line) as { type?: string; event?: StreamEvent }
      if (row.type === 'result') result = row as Record<string, unknown>
      if (row.event && WATCHED.has(row.event.type)) await onEvent(row.event)
    } catch {
      // A partial or non-JSON line from the CLI; the final result line is what counts.
    }
    return false
  })
  const final = result as Record<string, unknown> | null
  return {
    finalText: String(final?.finalText ?? ''),
    sessionId: typeof final?.sessionId === 'string' ? final.sessionId : undefined,
    subtype: typeof final?.subtype === 'string' ? final.subtype : undefined,
    code: exit.code,
    signal: exit.signal,
    errors,
  }
}

/** Runs a round at `effort`; if the model refuses that level, reruns once at its nearest supported one. */
async function runRoundAt(
  $: EngineInterface,
  argv: RoundArgs,
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

/** A Head on Command Code: the project's shared rules file, then rounds until it reports HEAD DONE. */
export async function runCommandCodeHead(
  $: EngineInterface,
  head: { task: string; cwd: string; model: string; maxTurns: number; addDirs: string[]; writeDirs: string[]; shell: boolean; minutes: number; effort?: string; guarded?: Guarded },
  outer: AbortSignal,
  limits: HeadLimits,
  id: string,
) {
  const { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort, guarded } = head
  const refusal = await joinProject($, cwd, id, { addDirs, writeDirs, shell, guarded }, minutes)
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
  await snapshotChangedFiles($, id, [cwd, ...head.writeDirs])
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
  const endedAt = await $.clock.now()
  const edits = await compareChangedFiles($, id, { cwd, startedAt, endedAt }, [cwd, ...head.writeDirs])
  const finished = isFinished(round.finalText)
  const isDone = round.code === 0 && round.subtype === 'success' && finished
  const stopped = outer.aborted ? stopReason(outer) : undefined
  await setRun($, id, {
    state: isDone ? 'done' : 'failed', turns, costUsd: report.usd ?? undefined, endedAt,
    files: report.files.map(file => relativeTo(cwd, file)), summary: summaryOf(round.finalText),
    activity: isDone ? undefined : timedOut ? `timed out after ${minutes} min` : stopped ?? 'stopped before HEAD DONE',
  })
  void refreshHeads($, limits)

  const text = formatReport({
    id, model, effort: round.effort, cwd, sessionId, finished, rounds, turns, usd: report.usd, files: report.files, denied: report.denied,
    finalText: round.finalText, exit: timedOut ? `timed out after ${minutes} min` : stopped ?? String(round.code ?? round.signal), errors: round.errors,
    rulesNote, writeDirs: head.writeDirs,
    reverted: edits.reverted, restored: edits.restored, overwritten: edits.overwritten, alsoRan: edits.alsoRan,
  })
  return { text, isDone, failure: isDone ? undefined : round.errors }
}
