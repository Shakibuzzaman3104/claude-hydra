/**
 * @author Shakib
 * @since 15/10/26
 */
import type { EngineInterface } from 'claude-code'

import { applyEvent, formatReport, outsideFiles, relativeTo, tokensText } from '../lib/format'
import type { HeadLimits, SessionReport, StreamEvent } from '../lib/format'
import { HEAD_RULES, MAX_ROUNDS, START_RETRIES, changedFiles, compareChangedFiles, continuePrompt, isFinished, isResumable, notStarted, pump, realPaths, refreshHeads, refreshStatus, setRun, snapshotChangedFiles, stopReason, summaryOf } from '../lib/runtime'
import type { IdleLimits, Round } from '../lib/runtime'
import { SECRET_PATHS, isWithin, trimSlash, union } from '../lib/safety'
import type { HeadNeeds } from '../lib/safety'
import { IGNORE_FILE } from '../lib/protect'
import type { Guarded } from '../lib/protect'
import { homeOf, runScript } from '../lib/platform'
import { OPENCODE_NO_PROJECT_CONFIG } from '../lib/checks'

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

type Rule = 'allow' | 'deny'

/** Every upper- and lower-case spelling of `name` (`.git`, `.Git` … `.GIT`): a macOS disk ignores case, OpenCode's rules do not. */
export const caseVariants = (name: string): string[] =>
  [...name].reduce<string[]>((spellings, char) => {
    const forms = /[a-z]/i.test(char) ? [char.toLowerCase(), char.toUpperCase()] : [char]
    return spellings.flatMap(spelling => forms.map(form => spelling + form))
  }, [''])

/**
 * Patterns that match `path` in any letter case, kept few: the first `exact` letters in both cases, every later letter as
 * `?` (any one character in OpenCode's patterns, `/` included). A deny written this way may also catch a few other paths
 * of the same length and shape, which is the safe side. Letters outside ASCII are always `?`.
 */
export const anyCase = (path: string, exact = 2): string[] => {
  let letters = 0
  return [...path].reduce<string[]>((spellings, char) => {
    const isLetter = char.toLowerCase() !== char.toUpperCase()
    const forms = !isLetter ? [char] : /[a-z]/i.test(char) && letters++ < exact ? [char.toLowerCase(), char.toUpperCase()] : ['?']
    return spellings.flatMap(spelling => forms.map(form => spelling + form))
  }, [''])
}

/** A rule's pattern as OpenCode v2 compiles it (its wildcard match): `*` is any text and `?` any one character, `/` included. */
const patternRegex = (pattern: string) => {
  let source = pattern.replace(/\\/g, '/').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  if (source.endsWith(' .*')) source = `${source.slice(0, -3)}( .*)?`
  return new RegExp(`^${source}$`, 's')
}

/** Whether OpenCode v2 matches `path` with `pattern`. */
export const opencodeMatches = (pattern: string, path: string) => patternRegex(pattern).test(path.replace(/\\/g, '/'))

/** The effect OpenCode gives `path` under `rules`: the last matching rule wins. */
export const ruleFor = (rules: Readonly<Record<string, Rule>>, path: string) =>
  Object.entries(rules).reduce<Rule | undefined>((effect, [pattern, rule]) => (opencodeMatches(pattern, path) ? rule : effect), undefined)

/**
 * Ordered rules as the object OpenCode reads. A later duplicate moves to the end, so the last rule still wins. A pattern
 * that reads as an array index (`2024`) would be put first by every JSON object, ahead of the `*` it must follow, so it
 * gets a trailing `*` (a wider deny).
 */
export const rulesOf = (entries: readonly (readonly [string, Rule])[]) => {
  const rules: Record<string, Rule> = {}
  for (const [pattern, rule] of entries) {
    const key = /^(0|[1-9][0-9]*)$/.test(pattern) ? `${pattern}*` : pattern
    delete rules[key]
    rules[key] = rule
  }
  return rules
}

/** A folder or file, and everything below it. */
const below = (path: string) => [path, `${path}/*`]

/** `.git` itself and anything in it, in every letter case, at the top and at any depth or absolute path. */
export const OPENCODE_GIT = caseVariants('.git').flatMap(name => [...below(name), ...below(`*/${name}`)])

/**
 * `.env` and `.env.*` files in every letter case, at any depth: `*` matches `/` and the empty text, so `*.Env` covers
 * `.Env`, `sub/.Env` and `/abs/.Env`, and `*.Env.*` covers `.Env.local` at any depth.
 */
export const OPENCODE_ENV = caseVariants('.env').flatMap(name => [`*${name}`, `*${name}.*`])

export const CONFIG_TOO_LARGE = `The OpenCode config for this Head would be too large to pass (the project's symlinks and .hydraignore matches each need rules). Name whole folders in .hydraignore instead of the files in them, or use another engine here.`

/** `.hydraignore` at any depth, in any letter case (`anyCase` keeps the list short): a Head may read it but never change what it keeps from the next one. */
export const OPENCODE_IGNORE = anyCase(IGNORE_FILE).map(spelling => `*${spelling}`)

/**
 * Project files that would run code or change rules after the Head is gone: OpenCode's own project config, and the
 * project settings of Claude Code (the Lead's hooks) and CodeBuddy. A Head never edits them, at any depth. They are
 * denied in lower case only.
 */
export const OPENCODE_PROTECTED = [
  ...['.opencode', '.claude', '.codebuddy'].flatMap(name => [...below(name), ...below(`*/${name}`)]), 'opencode.json*', '*/opencode.json*',
]

const ENV_REGEXES = OPENCODE_ENV.map(patternRegex)
const PROTECTED_REGEXES = [...OPENCODE_ENV, ...OPENCODE_GIT, ...OPENCODE_PROTECTED].map(patternRegex)

/** Whether a real path is a `.env` file or lies where the `.env` rules match, in any letter case. */
const isEnvPath = (path: string) => ENV_REGEXES.some(regex => regex.test(path))

/** Whether a real path lies in `.git` or a protected folder, or is a `.env` or protected file, in any letter case. */
const isProtectedPath = (path: string) => {
  const lower = path.toLowerCase()
  return PROTECTED_REGEXES.some(regex => regex.test(lower))
}

/** A symlink under the project or a granted folder, and its real target, both absolute. */
export type FoundLink = { path: string; target: string }

/** The symlinks an OpenCode Head is kept from, by absolute path: for reads, and for edits. */
export type LinkDenies = { read: string[]; edit: string[] }

/** More symlinks to deny than this and an OpenCode Head is refused: the rules for them would make its config too large. */
export const OPENCODE_LINK_CAP = 100

/** The folders an OpenCode Head may write (`cwd` first) and those it may only read, without trailing slashes. */
const grantsOf = (cwd: string, head: HeadNeeds) => {
  const writable = [cwd, ...(head.writeDirs ?? [])].map(trimSlash)
  const readOnly = head.addDirs.map(trimSlash).filter(dir => !writable.some(root => isWithin(dir, root)))
  return { writable, readOnly }
}

/**
 * The symlinks an OpenCode Head must be kept from. OpenCode checks a path as written, so a link is an alias for its
 * target that no rule on the target's own path catches. A link is denied for reads when its target is outside every
 * folder the Head may read or is a `.env` file, and for edits when its target is outside every folder it may write,
 * inside a read-only one, or in `.git` or a protected folder. A link that leads to a folder above itself (`a -> .`), or to
 * a folder holding a denied link or a read-only folder, is denied too: through it, `a/link-out/x` would get around the
 * deny on `link-out`. Stops early once more than `limit` links are denied for edits.
 */
export const linkDenies = (links: readonly FoundLink[], cwd: string, head: HeadNeeds, limit = OPENCODE_LINK_CAP): LinkDenies => {
  const { writable, readOnly } = grantsOf(trimSlash(cwd), head)
  const readable = [...writable, ...readOnly]
  const read = new Set<string>()
  const edit = new Set<string>()
  const holds = (target: string, denied: Iterable<string>) => [...denied].some(path => path !== target && isWithin(path, target))
  const guarded = (head.guarded?.paths ?? []).map(path => path.toLowerCase())
  const isGuarded = (target: string) => guarded.some(path => isWithin(target.toLowerCase(), path) || isWithin(path, target.toLowerCase()))
  for (let isChanged = true; isChanged && edit.size <= limit;) {
    isChanged = false
    for (const { path, target } of links) {
      const isAlias = isWithin(path, target)
      if (!read.has(path) && (isAlias || isEnvPath(target) || isGuarded(target) || !readable.some(root => isWithin(target, root)) || holds(target, read))) {
        read.add(path)
        isChanged = true
      }
      const isUnwritable = !writable.some(root => isWithin(target, root)) || readOnly.some(root => isWithin(target, root)) || isProtectedPath(target)
      if (!edit.has(path) && (isAlias || isUnwritable || read.has(path) || holds(target, [...edit, ...readOnly]))) {
        edit.add(path)
        isChanged = true
      }
    }
  }
  return { read: [...read].sort(), edit: [...edit].sort() }
}

/**
 * The patterns OpenCode compares with an absolute `path`, in any letter case. A path under `cwd` is matched relative to
 * it, so it is written that way. A path under a granted folder outside keeps that folder's exact spelling
 * (`external_directory` refuses any other) and the rest in any case. Anything else stays exact.
 */
const spellingsOf = (path: string, cwd: string, roots: readonly string[]) => {
  if (path !== cwd && isWithin(path, cwd)) return anyCase(path.slice(cwd.length + 1))
  const root = roots.filter(dir => dir !== path && isWithin(path, dir)).sort((a, b) => b.length - a.length)[0]
  return root ? anyCase(path.slice(root.length + 1)).map(rest => `${root}/${rest}`) : [path]
}

/**
 * The OpenCode config one Head runs with (`OPENCODE_CONFIG`), in the legacy `permission` form that v2 still honours.
 * Everything is denied by default and every key Hydra cares about is explicit; nothing is `ask`, because headless
 * `opencode run` rejects an ask and aborts the whole run. A Head may read anything in the project except `.env` files,
 * edit inside the project and its `writeDirs` (never `.git`, `.env` or the protected config folders), list files with
 * `glob` and keep a todo list; `.git` and `.env` are denied in every letter case. `external_directory` keeps it inside:
 * only `writeDirs` and `addDirs` folders are reachable outside `cwd`, and a folder it may only read is denied for edits,
 * in its cwd-relative spelling when it lies in the project. `cwd` must be the project's VCS root (`projectRootRefusal`),
 * because OpenCode matches every path under that root relative to `cwd`, without `external_directory`. The `denied`
 * symlinks (`linkDenies`) are denied by their own paths, in any letter case. `shell` is never given, whatever the Head
 * asked for: OpenCode does not check a command's paths. The credential folders and files in the home folder
 * (`SECRET_PATHS`) are denied for reads, globs and edits by absolute path too.
 */
export const opencodeConfig = (cwd: string, head: HeadNeeds, denied: LinkDenies = { read: [], edit: [] }, home = '') => {
  const root = trimSlash(cwd)
  const { writable, readOnly } = grantsOf(root, head)
  const outside = union(writable.slice(1), readOnly).filter(dir => !isWithin(dir, root))
  const each = (patterns: readonly string[], rule: Rule) => patterns.map(pattern => [pattern, rule] as const)
  const deny = (paths: readonly string[]) => each(paths.flatMap(path => spellingsOf(path, root, [...writable, ...readOnly])).flatMap(below), 'deny')
  const secrets = home ? SECRET_PATHS.flatMap(path => below(`${trimSlash(home)}/${path}`)) : []
  const guarded = (head.guarded?.paths ?? []).filter(path => [...writable, ...readOnly].some(dir => isWithin(path, dir)))
  return {
    autoupdate: false,
    share: 'disabled',
    tools: Object.fromEntries(OPENCODE_DENY.map(key => [key, false])),
    permission: {
      '*': 'deny' as Rule,
      read: rulesOf([['*', 'allow'], ...deny(denied.read), ...deny(guarded), ...each(OPENCODE_ENV, 'deny'), ...each(secrets, 'deny')]),
      edit: rulesOf([
        ['*', 'allow'], ...deny(readOnly), ...each(writable.slice(1).flatMap(below), 'allow'), ...deny(denied.edit), ...deny(guarded),
        ...each(OPENCODE_GIT, 'deny'), ...each(OPENCODE_ENV, 'deny'), ...each(OPENCODE_IGNORE, 'deny'), ...each(OPENCODE_PROTECTED, 'deny'), ...each(secrets, 'deny'),
      ]),
      glob: rulesOf([['*', 'allow'], ...each(secrets, 'deny')]),
      todowrite: 'allow' as Rule,
      external_directory: rulesOf([['*', 'deny'], ...each(outside.map(dir => `${dir}/*`), 'allow')]),
      ...Object.fromEntries(OPENCODE_DENY.map(key => [key, 'deny' as Rule])),
    },
  }
}

/** Above this many characters the inline config could pass what one environment variable may hold on Linux (128 KiB). */
export const OPENCODE_CONFIG_LIMIT = 120_000

/**
 * Why an OpenCode Head may not run with these grants (real paths), or undefined. OpenCode's rules are case-sensitive and a
 * macOS disk is not, so a grant that holds a credential folder (an `addDirs` of the home folder holds `~/.ssh`) would let
 * the Head read it as `~/.SSH`: such a grant is refused.
 */
export const opencodeGrantRefusal = (grants: readonly string[], home: string) => {
  const base = trimSlash(home)
  if (!base) return undefined
  for (const grant of grants) {
    const secret = SECRET_PATHS.find(path => isWithin(`${base}/${path}`, trimSlash(grant)))
    if (secret) return `addDirs/writeDirs: ${grant} holds ${base}/${secret}, and OpenCode cannot deny a credential folder in every letter case. Grant a narrower folder.`
  }
  return undefined
}

/**
 * Why an OpenCode Head may not run in `cwd`, or undefined. OpenCode takes the nearest VCS root above `cwd` as the
 * project and matches every path under it relative to `cwd` (`../x`), never as an outside folder, so in a monorepo
 * subfolder the Head could read and write the whole repository. `root` is that VCS root's real path, undefined when
 * there is none (OpenCode then uses `cwd` itself).
 */
export const projectRootRefusal = (cwd: string, root: string | undefined) =>
  root !== undefined && trimSlash(root) !== trimSlash(cwd)
    ? `${cwd} is a subfolder of the repository ${root}, and OpenCode would let the Head reach all of that repository through \`../\` paths. Run OpenCode Heads with \`cwd\` at the repository root, or use another engine.`
    : undefined

/** The folders to scan for symlinks: the project and every granted folder, without one that lies in another. */
export const scanRoots = (cwd: string, grants: readonly string[]) => {
  const all = union([cwd], grants).map(trimSlash)
  return all.filter(dir => !all.some(other => other !== dir && isWithin(dir, other)))
}

/**
 * The links `bin/symlinks.py` found, or why the Head is refused: the scan failed, timed out, was cut short or printed
 * something else. A Head never runs with links Hydra could not see.
 */
export const linkScanResult = (ran: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean } | undefined): { links: FoundLink[] } | { refusal: string } => {
  const why = 'Hydra could not list the symlinks in the project and the granted folders'
  if (!ran) return { refusal: `${why} (the scan failed or took over a minute), so it cannot deny the ones that lead out.` }
  if (ran.exitCode !== 0) return { refusal: `${why}: ${ran.stderr.trim().split('\n')[0]?.slice(0, 200) || `exit ${ran.exitCode}`}.` }
  if (ran.isStdoutTruncated) return { refusal: `${why}: there are too many to read.` }
  try {
    const rows = JSON.parse(ran.stdout) as unknown
    if (Array.isArray(rows) && rows.every(row => Array.isArray(row) && row.length === 2 && row.every(part => typeof part === 'string'))) {
      return { links: (rows as [string, string][]).map(([path, target]) => ({ path, target })) }
    }
  } catch {
    // Falls through to the refusal below.
  }
  return { refusal: `${why}: the scan printed something unexpected.` }
}

/** The refusal when more links must be denied than an OpenCode config can hold. */
export const tooManyLinks = (count: number) =>
  `The project and the granted folders hold more than ${OPENCODE_LINK_CAP} symlinks an OpenCode Head must be kept from (${count} found so far), too many to deny one by one. Use another engine here.`

/**
 * ⚠ lines for files the Head changed whose real path (`real`, in the order of `files`) is inside a `.git` folder, in any
 * letter case, or outside the project and the `writeDirs`: Hydra's rules should have refused both.
 */
export const changeWarnings = (cwd: string, writeDirs: readonly string[], files: readonly string[], real: readonly string[]) =>
  files.flatMap((file, index) => {
    const path = real[index] ?? file
    const name = relativeTo(cwd, file)
    if (path.split('/').some(part => part.toLowerCase() === '.git')) return [`the Head changed ${name}, which is inside a .git folder (${path}): check it, and git's hooks and config, before you run git.`]
    if (path !== file && outsideFiles(cwd, [path], writeDirs).length > 0) return [`the Head changed ${name}, whose real path ${path} is outside the project: check it.`]
    return []
  })

/**
 * The environment one OpenCode Head runs with: its config file (and the same JSON inline, which outranks any config
 * the person's environment names), no project config, no auto-update, and its own empty config home, so the person's
 * `~/.config/opencode` (which can hold provider API keys) is neither loaded nor allowed to the Head as OpenCode's own
 * config folder. The data folder (sign-ins, the free models' access) stays the person's, unless an account sets it.
 * `PWD` is the Head's `cwd`: `opencode run` changes to `$PWD` (inherited from Claude Code) before its own working
 * folder, so without it the Head would work, and be matched, in the Lead's folder instead.
 */
export const opencodeEnv = (cwd: string, configFile: string, configHome: string, config: string, account?: Record<string, string>) => ({
  OPENCODE_CONFIG: configFile,
  OPENCODE_CONFIG_CONTENT: config,
  OPENCODE_CONFIG_DIR: configHome,
  ...OPENCODE_NO_PROJECT_CONFIG,
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  XDG_CONFIG_HOME: configHome,
  ...(account ?? {}),
  PWD: cwd,
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

type OpenCodeHead = { task: string; cwd: string; model: string; maxTurns: number; addDirs: string[]; writeDirs: string[]; minutes: number; env?: Record<string, string>; guarded?: Guarded }

const HEADS_DIR = '.claude/hydra/heads'
const PREFIX = 'opencode-'

/** The folder above `dir`, `/` at the top. */
const parentOf = (dir: string) => dir.replace(/\/[^/]*$/, '') || '/'

/**
 * The real path of the folder OpenCode takes as the project root for `cwd` (its `Project.resolve`): walking up, the first
 * folder holding `.git` (then the top level git names for it) or `.hg`. Undefined `root` when there is none, or when git
 * does not know the `.git` it found (OpenCode then uses `cwd`). A check that cannot run is a `failure`.
 */
async function vcsRootOf($: EngineInterface, cwd: string): Promise<{ root?: string } | { failure: string }> {
  for (let dir = trimSlash(cwd); ; dir = parentOf(dir)) {
    const base = dir === '/' ? '' : dir
    const [hasGit, hasHg] = await Promise.all([`${base}/.git`, `${base}/.hg`].map(path => $.fs.exists(path).catch(() => undefined)))
    if (hasGit === undefined || hasHg === undefined) return { failure: `Hydra could not look for a repository above ${cwd}, so it cannot tell where OpenCode puts the project root.` }
    if (hasGit) {
      const ran = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 10_000 }).catch(() => undefined)
      if (!ran) return { failure: `git did not answer in ${dir}, so Hydra cannot tell where OpenCode puts the project root.` }
      const top = ran.stdout.trim()
      if (ran.exitCode !== 0 || !top) return {}
      return { root: (await realPaths($, [top]))[0] ?? top }
    }
    if (hasHg) return { root: dir }
    if (dir === '/') return {}
  }
}

/** Every symlink under `roots` with its real target (`bin/symlinks.py`), or why the Head is refused. */
async function scanLinks($: EngineInterface, roots: readonly string[]) {
  const ran = await runScript($, 'symlinks.py', roots, 60_000).catch(() => undefined)
  return linkScanResult(ran)
}

type OpenCodeSetup = { cwd: string; addDirs: string[]; writeDirs: string[]; configFile: string; configHome: string; config: string }

/**
 * Everything an OpenCode Head needs before it starts, on real paths, or why it may not start: `cwd` at the project's VCS
 * root, no grant that holds a credential folder, every symlink in the project and the granted folders listed, at most
 * `OPENCODE_LINK_CAP` of them denied, and a config small enough for the environment. Then its files are written.
 */
async function prepareOpenCode($: EngineInterface, head: OpenCodeHead, id: string): Promise<OpenCodeSetup | { refusal: string }> {
  const home = await homeOf($)
  const [cwd = head.cwd, realHome = ''] = await realPaths($, home ? [head.cwd, home] : [head.cwd])
  const addDirs = await realPaths($, head.addDirs)
  const writeDirs = await realPaths($, head.writeDirs)
  const needs = { addDirs, writeDirs, shell: false, guarded: head.guarded }
  const vcs = await vcsRootOf($, cwd)
  if ('failure' in vcs) return { refusal: vcs.failure }
  const refusal = projectRootRefusal(cwd, vcs.root) ?? opencodeGrantRefusal(union(addDirs, writeDirs), realHome)
  if (refusal) return { refusal }
  const scanned = await scanLinks($, scanRoots(cwd, union(writeDirs, addDirs)))
  if ('refusal' in scanned) return scanned
  const denied = linkDenies(scanned.links, cwd, needs)
  if (denied.edit.length > OPENCODE_LINK_CAP) return { refusal: tooManyLinks(denied.edit.length) }
  const config = JSON.stringify(opencodeConfig(cwd, needs, denied, realHome))
  if (config.length > OPENCODE_CONFIG_LIMIT) return { refusal: (head.guarded?.paths.length ?? 0) > 0 ? CONFIG_TOO_LARGE : tooManyLinks(denied.edit.length) }
  return { cwd, addDirs, writeDirs, config, ...(await writeOpenCodeFiles($, home, id, config)) }
}

/** Writes the Head's config file and its empty config home next to Hydra's status files (owner-only), never in the project. */
async function writeOpenCodeFiles($: EngineInterface, home: string, id: string, config: string) {
  const base = `${home}/${HEADS_DIR}/${PREFIX}${await $.session.id()}-${id}`
  const configHome = base
  const configFile = `${base}.json`
  try {
    await $.process.run(['/bin/mkdir', '-p', configHome])
    await $.process.run(['/bin/chmod', '700', configHome])
    await $.fs.write(configFile, config + '\n')
    await $.process.run(['/bin/chmod', '600', configFile])
  } catch (error) {
    await removeOpenCodeFiles($, configHome)
    throw error
  }
  return { configFile, configHome }
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
  const setup: OpenCodeSetup | { refusal: string } = /^[A-Za-z]:|^\\\\|\\/.test(cwd)
    ? { refusal: `${cwd} is a Windows path, and Hydra's rules use POSIX paths. Run Claude Code under WSL instead.` }
    : await prepareOpenCode($, head, id).catch(error => ({
        refusal: `Hydra could not write the Head's OpenCode config (${String(error).slice(0, 160)}). Check that ~/.claude is writable, then run the Head again.`,
      }))
  if ('refusal' in setup) {
    await setRun($, id, { state: 'failed', endedAt: await $.clock.now(), activity: setup.refusal })
    await refreshStatus($, limits)
    return notStarted(id, model, cwd, `${setup.refusal} A Head never starts without Hydra's rules.`, 'opencode', 'unavailable')
  }
  try {
    const real = { ...head, cwd: setup.cwd, addDirs: setup.addDirs, writeDirs: setup.writeDirs }
    return await runOpenCodeRounds($, real, opencodeEnv(setup.cwd, setup.configFile, setup.configHome, setup.config, head.env), outer, limits, id)
  } finally {
    await removeOpenCodeFiles($, setup.configHome)
  }
}

/**
 * The round to run after a silent one was stopped. Once OpenCode has named a session, the retry resumes it with the
 * continue prompt (a fresh run would start a second session while Hydra kept resuming the dead one); before that, the
 * same round runs again.
 */
export const idleRetryRound = (round: { prompt: string; maxTurns: number; resume?: string }, sessionId: string | undefined, denied: string[], turnsUsed: number) =>
  sessionId ? { prompt: continuePrompt(denied), maxTurns: Math.max(1, round.maxTurns - turnsUsed), resume: sessionId } : round

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
  await snapshotChangedFiles($, id, [cwd, ...head.writeDirs])
  const state = newOpenCodeState(cwd)
  const labels = new Map<string, string>()
  const onEvent = async (event: StreamEvent) => {
    await setRun($, id, run => applyEvent(run, event, labels, cwd))
  }
  let hangs = 0
  const deniedCalls = () => state.denied.map(d => `${d.tool} ${relativeTo(cwd, d.target)}`.slice(0, 160))
  // A silent run is stopped by the watchdog and tried once more; a second silence is reported as a hang.
  const roundAt = async (round: { prompt: string; maxTurns: number; resume?: string }) => {
    const turnsBefore = state.turns
    let ran = await runRoundOpenCode($, { ...round, model, cwd, env, state }, signal, onEvent)
    if (ran.signal === 'idle' && !signal.aborted) {
      hangs++
      await setRun($, id, { activity: 'no output from OpenCode, retrying' })
      const retry = idleRetryRound(round, state.sessionId, deniedCalls(), state.turns - turnsBefore)
      ran = await runRoundOpenCode($, { ...retry, model, cwd, env, state }, signal, onEvent)
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
    await setRun($, id, { activity: `resuming (round ${rounds + 1})` })
    round = await roundAt({ prompt: continuePrompt(deniedCalls()), maxTurns: maxTurns - state.turns, resume: sessionId })
    rounds++
  }

  timerStop.abort()
  const files = union([...state.files], await changedFiles($, startedAt, [cwd, ...head.writeDirs]))
  const endedAt = await $.clock.now()
  const edits = await compareChangedFiles($, id, { cwd, startedAt, endedAt }, [cwd, ...head.writeDirs])
  const tokens = tokensText(state.inputTokens, state.outputTokens)
  const finished = isFinished(round.finalText)
  const isDone = round.code === 0 && round.subtype === 'success' && finished
  const stopped = outer.aborted ? stopReason(outer) : undefined
  const hung = round.signal === 'idle'
  await setRun($, id, {
    state: isDone ? 'done' : 'failed', turns: state.turns, tokens, endedAt,
    files: files.map(file => relativeTo(cwd, file)), summary: summaryOf(round.finalText),
    activity: isDone ? undefined : timedOut ? `timed out after ${minutes} min` : stopped ?? (hung ? 'OpenCode hung (no output)' : round.subtype === 'error_max_turns' ? `stopped at the ${maxTurns}-turn cap` : 'stopped before HEAD DONE'),
  })
  void refreshHeads($, limits)

  const warnings = [...new Set(state.flagged), ...changeWarnings(cwd, head.writeDirs, files, await realPaths($, files))]
  if (hangs > 0 && !hung) warnings.push(`OpenCode went silent ${hangs} time(s) and was restarted by Hydra's watchdog; check the files it edited.`)
  const text = formatReport({
    id, model, cwd, sessionId, finished, rounds, turns: state.turns, usd: null, files, denied: state.denied,
    finalText: round.finalText, exit: timedOut ? `timed out after ${minutes} min` : stopped ?? (hung ? 'hung' : String(round.code ?? round.signal)), errors: round.errors,
    writeDirs: head.writeDirs, engine: 'opencode', tokens: state.usd > 0 ? `${tokens} · $${state.usd.toFixed(4)}` : tokens, warnings,
    reverted: edits.reverted, restored: edits.restored, overwritten: edits.overwritten, alsoRan: edits.alsoRan,
  })
  return { text, isDone, failure: isDone ? undefined : round.errors, files }
}
