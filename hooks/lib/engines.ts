/**
 * @author Shakib
 * @since 15/10/26
 */
import type { HydraMode } from '../../types'

/** The CLI a Head runs on. Command Code is the original engine; CodeBuddy runs the same Heads through `codebuddy -p`, Codex through `codex exec`. */
export const ENGINES = ['commandcode', 'codebuddy', 'codex', 'agy'] as const
export type Engine = (typeof ENGINES)[number]
export const DEFAULT_ENGINE: Engine = 'commandcode'
/** The only model Antigravity Heads run on: the person's choice, whatever a Head's `model` says. */
export const AGY_MODEL = 'gemini-3.8-flash'
/** Where Antigravity keeps the sign-in token, relative to the home folder. */
export const AGY_TOKEN = '.gemini/antigravity-cli/antigravity-oauth-token'
export const isEngine = (value: unknown): value is Engine => typeof value === 'string' && (ENGINES as readonly string[]).includes(value)
export const ENGINE_LABEL: Record<Engine, string> = { commandcode: 'Command Code', codebuddy: 'CodeBuddy', codex: 'Codex', agy: 'Antigravity' }
export const ENGINE_BIN: Record<Engine, string> = { commandcode: 'commandcode', codebuddy: 'codebuddy', codex: 'codex', agy: 'agy' }
/** The Head model a session gets when it switches to an engine whose models differ from the one it had. */
export const ENGINE_MODEL: Partial<Record<Engine, string>> = { codex: 'gpt-6.1-sol', agy: 'gemini-3.8-flash' }
/** Codex Heads run OpenAI's models and Antigravity Heads Google's; every other engine runs the person's configured Head model (DeepSeek by default). */
const MODEL_FAMILY: Partial<Record<Engine, RegExp>> = { codex: /^(openai\/)?(gpt|o\d|codex)/i, agy: /^(google\/)?gemini/i }
export const isModelFor = (engine: Engine, model: string) => {
  const family = MODEL_FAMILY[engine]
  return family ? family.test(model) : !Object.values(MODEL_FAMILY).some(other => other.test(model))
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

/** CodeBuddy, Codex and Antigravity model ids carry no provider prefix: `deepseek/deepseek-v4.1-flash` is `deepseek-v4.1-flash` there. */
export const modelFor = (engine: Engine, model: string) => (engine === 'commandcode' ? model : model.split('/').pop() || model)
