/**
 * @author Shakib
 * @since 15/10/26
 */
import type { HydraMode } from '../../types'

/**
 * The CLI a Head runs on. Command Code is the original engine; CodeBuddy runs the same Heads through `codebuddy -p`, Codex through
 * `codex exec`. WorkBuddy is the CodeBuddy CLI pointed at the WorkBuddy app's product config; OpenCode (beta) runs `opencode run`.
 */
export const ENGINES = ['commandcode', 'codebuddy', 'codex', 'agy', 'workbuddy', 'opencode'] as const
export type Engine = (typeof ENGINES)[number]
export const DEFAULT_ENGINE: Engine = 'commandcode'
/**
 * Antigravity's models by base id: the levels each takes and the usage pool it draws on. Claude and GPT-OSS share one pool;
 * Gemini Flash and Gemini 4 Argon each have their own weekly one (no 5-hour window), so one pool's limit leaves the others free.
 */
export const AGY_MODELS = {
  'gemini-3.8-flash': { levels: ['low', 'medium', 'high'], pool: 'gemini' },
  'gemini-4-argon': { levels: ['low', 'medium', 'high'], pool: 'argon' },
  'claude-sonnet-5-5': { levels: ['low', 'medium', 'high'], pool: 'claude' },
  'claude-opus-5-5': { levels: ['low', 'medium', 'high'], pool: 'claude' },
  'gpt-oss-120b': { levels: ['medium'], pool: 'claude' },
} as const satisfies Record<string, { levels: readonly string[]; pool: string }>
export type AgyModel = keyof typeof AGY_MODELS
export type AgyPool = (typeof AGY_MODELS)[AgyModel]['pool']
export const AGY_POOL_LABEL: Record<AgyPool, string> = { gemini: 'Gemini Flash', argon: 'Gemini 4 Argon', claude: 'Claude + GPT-OSS' }
/** Antigravity Heads' default model: the cheap, fast one. */
export const AGY_MODEL: AgyModel = 'gemini-3.8-flash'
/** `gemini-4-argon-high` or `google/gemini-4-argon` is `gemini-4-argon`; undefined when Antigravity has no such model. */
export const agyBaseOf = (model: string): AgyModel | undefined => {
  const base = model.replace(/^google\//i, '').replace(/-(low|medium|high)$/i, '').toLowerCase()
  return Object.hasOwn(AGY_MODELS, base) ? (base as AgyModel) : undefined
}
/** The id `agy --model` takes: the base with its level built in (agy refuses `--effort` beside it); no level is `low`, and one the model lacks is its middle one. */
export const agyModelId = (model: string, effort?: string) => {
  const base = agyBaseOf(model) ?? AGY_MODEL
  const levels: readonly string[] = AGY_MODELS[base].levels
  const wanted = !effort || effort === 'off' || effort === 'auto' ? 'low' : effort === 'xhigh' || effort === 'max' ? 'high' : effort
  const level = wanted && levels.includes(wanted) ? wanted : levels.includes('medium') ? 'medium' : levels[0]!
  return `${base}-${level}`
}
export const agyPoolOf = (model: string): AgyPool => AGY_MODELS[agyBaseOf(model) ?? AGY_MODEL].pool
/** Where Antigravity keeps the sign-in token, relative to the home folder. */
export const AGY_TOKEN = '.gemini/antigravity-cli/antigravity-oauth-token'
export const isEngine = (value: unknown): value is Engine => typeof value === 'string' && (ENGINES as readonly string[]).includes(value)
export const ENGINE_LABEL: Record<Engine, string> = { commandcode: 'Command Code', codebuddy: 'CodeBuddy', codex: 'Codex', agy: 'Antigravity', workbuddy: 'WorkBuddy', opencode: 'OpenCode' }
/** The executable each engine starts: WorkBuddy Heads run the CodeBuddy CLI. */
export const ENGINE_BIN: Record<Engine, string> = { commandcode: 'commandcode', codebuddy: 'codebuddy', codex: 'codex', agy: 'agy', workbuddy: 'codebuddy', opencode: 'opencode' }
/** OpenCode's free DeepSeek model: it needs no account, so a new user can try Hydra at no cost. */
export const OPENCODE_MODEL = 'opencode/deepseek-v4.1-flash-free'
/** WorkBuddy Heads' own CodeBuddy config folder (sign-in, settings, transcripts), relative to the home folder: apart from the WorkBuddy app's and plain CodeBuddy's. */
export const WORKBUDDY_CONFIG = '.claude/hydra/workbuddy-cli'
/** The product definition the WorkBuddy app writes when the person signs in to it (endpoint, sign-in flow, models), relative to the home folder. */
export const WORKBUDDY_PRODUCT = '.workbuddy-ai/cache/acc-product-config-v3.json'
/**
 * The environment that turns the CodeBuddy CLI into WorkBuddy: its own config folder (`configDir`, an account's, else
 * `WORKBUDDY_CONFIG`), the app's product file through `ACC_PRODUCT_CONFIG_PATH` (read by CodeBuddy but not documented by
 * Tencent), and CodeBuddy's memory, session summaries, prompt suggestions, cron, IDE and browser MCP switched off.
 */
export const workbuddyEnv = (home: string, configDir?: string): Record<string, string> => ({
  CODEBUDDY_CONFIG_DIR: configDir ?? `${home}/${WORKBUDDY_CONFIG}`,
  ACC_PRODUCT_CONFIG_PATH: `${home}/${WORKBUDDY_PRODUCT}`,
  CODEBUDDY_DISABLE_AUTO_MEMORY: '1',
  CODEBUDDY_CODE_DISABLE_SESSION_SUMMARY: '1',
  CODEBUDDY_PROMPT_SUGGESTION_DISABLED: '1',
  CODEBUDDY_DISABLE_CRON: '1',
  CODEBUDDY_DISABLE_IDE: '1',
  CODEBUDDY_DISABLE_BROWSER_MCP: '1',
})
/** The Head model a session gets when it switches to an engine whose models differ from the one it had. */
export const ENGINE_MODEL: Partial<Record<Engine, string>> = { codex: 'gpt-6.1-sol', agy: AGY_MODEL, workbuddy: 'deepseek-v4.1-flash', opencode: OPENCODE_MODEL }
/** Codex Heads run OpenAI's models (not Antigravity's GPT-OSS) and Antigravity Heads `AGY_MODELS`; every other engine runs the person's configured Head model (DeepSeek by default). */
const MODEL_FAMILY: Partial<Record<Engine, RegExp>> = { codex: /^(openai\/)?(gpt(?!-oss)|o\d|codex)/i, agy: /^(google\/)?gemini/i }
/**
 * OpenCode takes any `provider/model` the person set up in it, except Command Code's `deepseek/…` ids (OpenCode has no
 * `deepseek` provider unless the person added one, and the configured Head model uses that prefix). `opencode/…` ids are
 * OpenCode's own models, which no other engine runs.
 */
const OPENCODE_ID = /^(?!deepseek\/)[a-z0-9][\w.-]*\/\S+$/i
const OPENCODE_ONLY = /^opencode\//i
export const isModelFor = (engine: Engine, model: string) => {
  if (engine === 'opencode') return OPENCODE_ID.test(model)
  if (engine === 'agy') return agyBaseOf(model) !== undefined
  const family = MODEL_FAMILY[engine]
  return family ? family.test(model) : !OPENCODE_ONLY.test(model) && agyBaseOf(model) === undefined && !Object.values(MODEL_FAMILY).some(other => other.test(model))
}
/** The Head model after the person picks `engine`: their explicit `requested` one, else the current one if the engine can run it, else the engine's own default. */
export const headModelFor = (engine: Engine, requested: string | undefined, current: string, configured: string) =>
  requested ?? (isModelFor(engine, current) ? current : (ENGINE_MODEL[engine] ?? (isModelFor(engine, configured) ? configured : current)))

/** The session's engine; anything else stored there (`auto` included) reads as `fallback`. */
export const engineOf = (hydra: HydraMode | null, fallback: Engine = DEFAULT_ENGINE): Engine => (isEngine(hydra?.engine) ? hydra.engine : fallback)

/** In auto mode the Lead picks an engine for each Head from a pool, instead of the whole session running on one. */
export const AUTO = 'auto'
export const isAuto = (hydra: HydraMode | null) => hydra?.engine === AUTO
/** The engines an auto session may use: the stored pool (in `ENGINES` order), else all of them. */
export const poolOf = (hydra: HydraMode | null): Engine[] => {
  const stored = new Set((hydra?.engines ?? []).filter(isEngine))
  return stored.size > 0 ? ENGINES.filter(engine => stored.has(engine)) : [...ENGINES]
}
export const engineLabel = (hydra: HydraMode | null, fallback: Engine = DEFAULT_ENGINE) =>
  isAuto(hydra) ? `Auto (${poolOf(hydra).map(engine => ENGINE_LABEL[engine]).join(' + ')})` : ENGINE_LABEL[engineOf(hydra, fallback)]

/** `a,b` or `a b` as engine names; `bad` holds what is not an engine. */
export const parseEngineList = (text: string) => {
  const names = [...new Set(text.toLowerCase().split(/[\s,+]+/).filter(Boolean))]
  return { engines: names.filter(isEngine), bad: names.filter(name => !isEngine(name)) }
}

/**
 * The engine one Head runs on. A fixed session runs everything on its engine; an auto session needs the Lead to name one
 * from the pool, so the choice is deliberate.
 */
export const resolveHeadEngine = (hydra: HydraMode | null, requested: unknown, fallback: Engine = DEFAULT_ENGINE): { engine: Engine } | { deny: string } => {
  if (!isAuto(hydra)) {
    const engine = engineOf(hydra, fallback)
    if (requested === undefined || requested === engine) return { engine }
    return { deny: `Heads run on ${ENGINE_LABEL[engine]} in this session. Only /hydra engine=auto lets you choose an engine per Head.` }
  }
  const pool = poolOf(hydra)
  if (requested === undefined) return { deny: `Auto mode: name the engine for this Head in \`engine\` (${pool.join(', ')}).` }
  if (!isEngine(requested)) return { deny: `engine must be one of: ${pool.join(', ')}.` }
  if (!pool.includes(requested)) return { deny: `${requested} is not in this session's pool (${pool.join(', ')}). The person adds it with /hydra engines=…` }
  return { engine: requested }
}

/** CodeBuddy, WorkBuddy, Codex and Antigravity model ids carry no provider prefix: `deepseek/deepseek-v4.1-flash` is `deepseek-v4.1-flash` there. Command Code and OpenCode keep it. */
export const modelFor = (engine: Engine, model: string) => (engine === 'commandcode' || engine === 'opencode' ? model : model.split('/').pop() || model)
