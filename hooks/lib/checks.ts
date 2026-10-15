/**
 * @author Shakib
 * @since 15/10/26
 */
import type { EngineInterface } from 'claude-code'

import { WORKBUDDY_CONFIG, WORKBUDDY_PRODUCT } from './engines'
import type { Engine } from './engines'
import { commandOf } from './platform'

/** What to run to sign WorkBuddy Heads in: the CodeBuddy CLI in Hydra's WorkBuddy folder, with the app's product file. */
export const WORKBUDDY_LOGIN = `CODEBUDDY_CONFIG_DIR=~/${WORKBUDDY_CONFIG} ACC_PRODUCT_CONFIG_PATH=~/${WORKBUDDY_PRODUCT} codebuddy`

export const WORKBUDDY_NO_PRODUCT = `Install the WorkBuddy app and sign in once; it creates ~/${WORKBUDDY_PRODUCT}.`
export const WORKBUDDY_SIGNED_OUT = `WorkBuddy Heads are not signed in. Run \`${WORKBUDDY_LOGIN}\` in a terminal, type /login and finish signing in, then try again.`

/** The OpenCode version Hydra was built and smoke-tested against: v1 has other flags and config. */
export const OPENCODE_MAJOR = 2

/** `opencode --version` output (`opencode v2.0.18`, `2.0.18`) as its major number, or undefined. */
export const majorOf = (text: string) => {
  const found = /(\d+)\.\d+(?:\.\d+)?/.exec(text)
  return found ? Number(found[1]) : undefined
}

export const opencodeOldWarning = (version: string) =>
  `OpenCode ${version.trim()} is older than v${OPENCODE_MAJOR}, which Hydra was built against: Heads may fail. Run \`opencode upgrade\`.`

export const OPENCODE_NO_LOGIN = 'OpenCode has no provider signed in: Heads can use only its free `opencode/…` models. Run `opencode auth login` for others.'

/**
 * Both names OpenCode reads to skip a project's own config (`opencode.json`, `.opencode/`): v2 reads
 * `OPENCODE_CONFIG_PROJECT_DISABLE` first and falls back to the older `OPENCODE_DISABLE_PROJECT_CONFIG`.
 */
export const OPENCODE_NO_PROJECT_CONFIG = { OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1' } as const

/**
 * The providers `opencode auth list --format json` printed, as `[{ id, connections: [{ type }] }]`: `stored` counts
 * only sign-ins kept in OpenCode's data folder (`credential`), `any` also API keys in the environment. Both false when
 * the output is not that list.
 */
export const opencodeProviders = (stdout: string) => {
  try {
    const rows = JSON.parse(stdout) as unknown
    const connections = Array.isArray(rows) ? rows.flatMap(row => (Array.isArray((row as { connections?: unknown })?.connections) ? (row as { connections: { type?: unknown }[] }).connections : [])) : []
    return { any: connections.length > 0, stored: connections.some(connection => connection?.type === 'credential') }
  } catch {
    return { any: false, stored: false }
  }
}

/**
 * How Hydra runs OpenCode for a check (never for a Head): from the home folder (or the plugin's own folder), outside any
 * project, with project config off, so no project's `opencode.json` or `.opencode/` plugins load into it. OpenCode
 * changes to `$PWD` first, so `PWD` names that folder too. `--standalone` keeps it from starting the background service.
 */
export const opencodeCheckInit = (home: string, pluginRoot: string, env: Record<string, string> = {}) => ({
  cwd: home || pluginRoot, env: { ...env, ...OPENCODE_NO_PROJECT_CONFIG, PWD: home || pluginRoot }, timeoutMs: 30_000,
})

/**
 * The checks only WorkBuddy and OpenCode need, after their CLI was found: WorkBuddy's product file and sign-in (by
 * existence only; Hydra never reads a credential), and OpenCode's version and providers (`opencodeCheckInit`).
 */
export async function engineChecks($: EngineInterface, engine: Engine, home: string): Promise<{ problems: string[]; warnings: string[] }> {
  const problems: string[] = []
  const warnings: string[] = []
  if (engine === 'workbuddy') {
    if (!(home && (await $.fs.exists(`${home}/${WORKBUDDY_PRODUCT}`).catch(() => false)))) problems.push(WORKBUDDY_NO_PRODUCT)
    // CodeBuddy keeps its sign-in in `local_storage` under its config folder: Hydra checks only that something is there.
    const stored = home ? await $.fs.list(`${home}/${WORKBUDDY_CONFIG}/local_storage`).catch(() => []) : []
    if (problems.length === 0 && stored.length === 0) problems.push(WORKBUDDY_SIGNED_OUT)
  }
  if (engine === 'opencode') {
    const argv = await commandOf($, 'opencode')
    const init = opencodeCheckInit(home, $.plugin.root)
    const version = await $.process.run([...argv, '--version'], { ...init, timeoutMs: 15_000 }).catch(() => undefined)
    const major = majorOf(version?.stdout ?? '')
    if (major !== undefined && major < OPENCODE_MAJOR) warnings.push(opencodeOldWarning(version?.stdout ?? ''))
    // Plain `auth list` prints "No authenticated integrations" when there is none, so the JSON form is read instead.
    const auth = await $.process.run([...argv, 'auth', 'list', '--standalone', '--format', 'json'], init).catch(() => undefined)
    if (auth?.exitCode !== 0 || !opencodeProviders(auth.stdout).any) warnings.push(OPENCODE_NO_LOGIN)
  }
  return { problems, warnings }
}
