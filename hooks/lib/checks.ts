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
 * The checks only WorkBuddy and OpenCode need, after their CLI was found: WorkBuddy's product file and sign-in (by
 * existence only; Hydra never reads a credential), and OpenCode's version and providers. `auth list` runs with
 * `--standalone` so the check never starts OpenCode's background service.
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
    const version = await $.process.run([...argv, '--version'], { timeoutMs: 15_000 }).catch(() => undefined)
    const major = majorOf(version?.stdout ?? '')
    if (major !== undefined && major < OPENCODE_MAJOR) warnings.push(opencodeOldWarning(version?.stdout ?? ''))
    const auth = await $.process.run([...argv, 'auth', 'list', '--standalone'], { timeoutMs: 30_000 }).catch(() => undefined)
    if (auth?.exitCode !== 0 || !auth.stdout.trim()) warnings.push(OPENCODE_NO_LOGIN)
  }
  return { problems, warnings }
}
