/**
 * @author Shakib
 * @since 15/10/26
 */
import type { EngineInterface } from 'claude-code'

import { AUTO, ENGINES, ENGINE_LABEL } from './engines'
import type { Engine } from './engines'
import { INSTALL_HINT, preflight, readyEngines } from './runtime'

/** What `/hydra` does when no engine was named: run on one, let Claude pick from several, or help the person get one set up. */
export type OnboardingPlan =
  | { kind: 'fixed'; engine: Engine; /** True when the configured engine was not usable and this one is the only one that is. */ isFallback: boolean }
  | { kind: 'auto'; pool: Engine[] }
  | { kind: 'setup' }

/**
 * `configured` is the `headEngine` setting (or the engine a session already uses), `ready` the engines that passed
 * their checks. A configured engine that is ready is used as it always was; otherwise (it is not, or the setting is
 * auto) one ready engine is used on its own, several become an auto pool, and none means the setup card.
 */
export const onboardingPlan = (configured: Engine | typeof AUTO, ready: readonly Engine[]): OnboardingPlan => {
  if (configured !== AUTO && ready.includes(configured)) return { kind: 'fixed', engine: configured, isFallback: false }
  const pool = ENGINES.filter(engine => ready.includes(engine))
  if (pool.length === 0) return { kind: 'setup' }
  if (pool.length === 1) return { kind: 'fixed', engine: pool[0]!, isFallback: true }
  return { kind: 'auto', pool }
}

export const onlyReadyNote = (engine: Engine) => `Using ${ENGINE_LABEL[engine]} (the only engine ready here).`

/** Engines worth setting up first, with why. An engine Hydra does not have yet is skipped, so this can name ones that arrive later. */
const RECOMMENDED: readonly (readonly [string, string])[] = [
  ['opencode', 'free models, no account needed'],
  ['codex', 'uses your ChatGPT plan'],
]

const MAX_CARD_ENGINES = 9

/** The install line without its "The X CLI is not installed." lead, which the card's heading already says. */
const shortProblem = (problem: string) => problem.replace(/^The .+? CLI is not installed\. /, '')

/** The card shown when no engine is ready: one line per engine, the recommended ones first, ending with what to do next. */
export const setupCard = (skipped: readonly { engine: Engine; problem: string }[]) => {
  const problemOf = (engine: Engine) => skipped.find(item => item.engine === engine)?.problem ?? INSTALL_HINT[engine]
  const problems = new Set(ENGINES.map(problemOf))
  const hints = new Set<string>(Object.values(INSTALL_HINT))
  const [only] = problems
  // One machine-wide problem (no git, no python) is the same on every engine: say it once.
  if (problems.size === 1 && only !== undefined && !hints.has(only)) return ['🐉 Hydra can\'t start yet:', `  • ${only}`, 'Then run /hydra again.'].join('\n')

  const why = new Map(RECOMMENDED)
  const first = RECOMMENDED.map(([name]) => ENGINES.find(engine => engine === name)).filter((engine): engine is Engine => engine !== undefined)
  const order = [...first, ...ENGINES.filter(engine => !first.includes(engine))]
  const lines = order.slice(0, MAX_CARD_ENGINES).map(engine => {
    const reason = why.get(engine)
    return `  • ${ENGINE_LABEL[engine]}${reason ? ` (${reason})` : ''}: ${shortProblem(problemOf(engine))}`
  })
  if (order.length > MAX_CARD_ENGINES) lines.push(`  …and ${order.length - MAX_CARD_ENGINES} more: /hydra engines`)

  return ['🐉 Hydra needs a Head engine and none is ready here. Set up any one:', ...lines, 'Then run /hydra again.'].join('\n')
}

/**
 * Decides what a bare `/hydra` does. A single configured engine is checked on its own first (the common case, one
 * check); only when it is not ready, or the setting is auto, are all engines checked.
 */
export async function planOnboarding($: EngineInterface, configured: Engine | typeof AUTO) {
  if (configured !== AUTO) {
    const check = await preflight($, configured)
    if (check.problems.length === 0) return { plan: onboardingPlan(configured, [configured]), skipped: [], warnings: check.warnings }
  }
  const ready = await readyEngines($, ENGINES)

  return { plan: onboardingPlan(configured, ready.pool), skipped: ready.skipped, warnings: ready.warnings }
}

const WELCOMED_KEY = 'welcomed-v1'

export const WELCOME_LINES = [
  'What happens now: Claude plans and splits the work, then hands the pieces to Heads (cheaper coding agents).',
  '/heads opens a live view of them.',
  '/hydra off stops it any time.',
]

/** The welcome to append to the reply the first time Hydra turns on on this machine, else empty; asking marks it as shown. */
export async function takeWelcome($: EngineInterface) {
  if ((await $.store.get(WELCOMED_KEY)) === true) return ''
  await $.store.set(WELCOMED_KEY, true)

  return `\n${WELCOME_LINES.join('\n')}`
}
