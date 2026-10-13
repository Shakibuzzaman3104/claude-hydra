/**
 * @author Shakib
 * @since 06/10/26
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HeadRun, HeadStep, HeadsUsage, HydraMode, LeadWindow } from '../types'

const PANE = 'hydra-usage'
const HEADS_PANE = 'hydra-heads'
const USAGE_COMMAND = 'hydra-usage'
const LIVE_AFTER_END_MS = 60_000
const RUN_HISTORY = 20
const STATUS_KEEP_MS = 7 * 86_400_000
const CONSENT_KEY = 'consent-v1'
const HEAD_TOOL = 'mcp__hydra__head'
const CONTROL_TOOL = 'mcp__hydra__control'
const REFRESH_MS = 120_000
const WARN_AT = 90
const LEADS = ['fable', 'opus', 'sonnet'] as const

/** The CLI a Head runs on. Command Code is the original engine; CodeBuddy runs the same Heads through `codebuddy -p`, Codex through `codex exec`. */
export const ENGINES = ['commandcode', 'codebuddy', 'codex', 'agy'] as const
export type Engine = (typeof ENGINES)[number]
export const DEFAULT_ENGINE: Engine = 'commandcode'
/** The only model Antigravity Heads run on: the person's choice, whatever a Head's `model` says. */
export const AGY_MODEL = 'gemini-3.8-flash'
/** Where Antigravity keeps the sign-in token, relative to the home folder. */
const AGY_TOKEN = '.gemini/antigravity-cli/antigravity-oauth-token'
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

const lead = atom({ plugin: 'hydra', key: 'lead' } as const, [])
const heads = atom({ plugin: 'hydra', key: 'heads' } as const, null)
const warned = atom({ plugin: 'hydra', key: 'warned' } as const, [])
const mode = atom({ plugin: 'hydra', key: 'mode' } as const, null)
const runs = atom({ plugin: 'hydra', key: 'runs' } as const, [])
const selected = atom({ plugin: 'hydra', key: 'selected' } as const, null)
const tick = atom({ plugin: 'hydra', key: 'tick' } as const, 0)

const LEAD_LABELS: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: 'Weekly · all models',
  seven_day_opus: 'Weekly · Opus',
  seven_day_sonnet: 'Weekly · Sonnet',
  seven_day_fable: 'Weekly · Fable',
}

/** Spells out how the Head model rounds the levels it lacks, for models whose levels are known. */
const headLevelsNote = (headModel: string) =>
  /deepseek-v4\.1/i.test(headModel) ? ` ${shortModel(headModel)} takes low, high and max: medium runs as high, xhigh as max.` : ''

const codexEffortRule = (effort: EffortMode, headModel: string) =>
  `- Codex Heads run OpenAI models on the person's ChatGPT plan: \`${headModel}\` by default. Pass \`model\` per Head: \`gpt-6.1-sol\` for multi-file, algorithmic or subtle work, \`gpt-6-luna\` (faster, cheaper) for mechanical edits, renames, boilerplate and small, fully specified tasks.
${
    effort === 'auto'
      ? `- You pick each Head's reasoning \`effort\` (low, medium, high, xhigh or max):
  - \`low\` (the default) for every Head whose result you will check by running something (tests, a build, the app) or, for mechanical edits, by reading the diff, as long as the task text is a full spec.
  - When the check fails, send the Head back one level up with the failure in the task: \`low\`, then \`high\`, then \`max\`. If \`max\` fails too, rewrite the brief or do it yourself.
  - \`max\` first only when you cannot check the result cheaply (nothing to run or test) and the work is subtle: state, cycles, concurrency, an algorithm, or a bug known only by its symptoms.
  - Never raise effort to make up for a vague brief: write the spec first.`
      : `- The person fixed every Head's effort at ${effort} with /hydra effort=${effort}; your \`effort\` field is ignored until they set /hydra effort=auto.`
  }`

const agyEffortRule = (effort: EffortMode) =>
  `- Antigravity Heads always run \`${AGY_MODEL}\` (the person's choice): any \`model\` you pass is ignored. It takes three levels: \`low\`, \`medium\` and \`high\` (\`xhigh\` and \`max\` run as \`high\`).
${
    effort === 'auto'
      ? `- You pick each Head's reasoning \`effort\`:
  - \`low\` (the default) for every Head whose result you will check by running something (tests, a build, the app) or, for mechanical edits, by reading the diff, as long as the task text is a full spec.
  - When the check fails, send the Head back one level up with the failure in the task: \`low\`, then \`medium\`, then \`high\`. If \`high\` fails too, rewrite the brief or do it yourself.
  - \`high\` first only when you cannot check the result cheaply (nothing to run or test) and the work is subtle.
  - Never raise effort to make up for a vague brief: write the spec first.`
      : `- The person fixed every Head's effort at ${effort} with /hydra effort=${effort}; your \`effort\` field is ignored until they set /hydra effort=auto.`
  }`

const effortRule = (effort: EffortMode, headModel: string, engine: Engine = DEFAULT_ENGINE) =>
  engine === 'agy' ? agyEffortRule(effort) : engine === 'codex' ? codexEffortRule(effort, headModel) : effort === 'auto'
    ? `- You pick each Head's reasoning \`effort\`. Measured over 126 Hydra runs (DeepSeek V4.1 Flash, 15 tasks from a rename to a spreadsheet engine): \`low\` passed 95% for 0.7x the cost of \`high\` (95%) and 0.3x \`max\` (98%); \`low\` with a retry one level up on failure passed 100% for less than \`high\` alone. Higher effort mostly buys longer runs, not fewer failures, so:
  - \`low\` (the default) for every Head whose result you will check by running something (tests, a build, the app) or, for mechanical edits, by reading the diff. That includes long, multi-file and algorithmic work, as long as the task text is a full spec.
  - When the check fails, send the Head back one level up with the failure in the task: \`low\`, then \`high\`, then \`max\`. If \`max\` fails too, rewrite the brief or do it yourself.
  - \`max\` first only when you cannot check the result cheaply (nothing to run or test) and the work is subtle: state, cycles, concurrency, an algorithm, or a bug known only by its symptoms.
  - Never raise effort to make up for a vague brief: write the spec first.
  - A level the Head model lacks is raised to its nearest one.${headLevelsNote(headModel)}`
    : `- The person fixed every Head's effort at ${effort} with /hydra effort=${effort}; your \`effort\` field is ignored until they set /hydra effort=auto.`

const lockdownRules = (engine: Engine) =>
  engine === 'agy'
    ? `- Heads run through \`agy -p\` in Antigravity's terminal sandbox with permission rules Hydra writes for each Head: they can write only inside \`cwd\` (and \`writeDirs\`), never \`.git\`, read outside it only the folders you list in \`addDirs\` (and no credential folders), and have no shell unless you pass \`shell: true\` (then a sandboxed shell with no network: destructive git, rm -r/-f, sudo, installs and downloads stay denied or fail). A refused call ends the Head's turn, and Hydra resumes it. Builds and tests are yours.`
    : engine === 'codex'
    ? `- Heads run through \`codex exec\` inside Codex's OS sandbox with a filesystem profile Hydra writes for each Head: they can write only inside \`cwd\` (and \`writeDirs\`), never \`.git\` or \`.env\` files, and read the rest of the disk except credential folders (\`~/.ssh\`, \`~/.aws\`, \`~/.codex\`, \`~/.claude\`…). They always have a shell, but it has no network: installs, \`git push\`, downloads and builds that fetch dependencies fail, and \`git commit\` fails because \`.git\` is read-only. Run those yourself. \`shell\` and \`addDirs\` change nothing for them.`
    : engine === 'codebuddy'
    ? `- Heads run through CodeBuddy's headless mode with permission rules Hydra writes for each Head, plus a write guard that checks real paths: they can edit only inside \`cwd\` (never .git or \`.env\` files), read folders you list in \`addDirs\`, and have no shell unless you pass \`shell: true\` (destructive git, rm -r/-f, sudo, network tools and installs stay denied even then). Builds and tests are yours.`
    : `- Heads run with Command Code's --yolo (its headless mode cannot edit otherwise), locked down by Hydra's deny rules: they can edit only inside \`cwd\` (never .git or \`.env\` files), read folders you list in \`addDirs\`, and have no shell unless you pass \`shell: true\` (destructive git, rm -r/-f, sudo, network tools, builds and installs stay denied even then). Builds and tests are yours.`

const envRule = (engine: Engine) =>
  engine === 'agy'
    ? `- \`.env\` files that exist under \`cwd\`, a \`writeDirs\` or an \`addDirs\` folder when the Head starts are unreadable to it, shell included. One created later is not covered, and other project secrets (\`local.properties\`, keystores, \`google-services.json\`) are readable: do not point a Head at a project where that matters.`
    : engine === 'codex'
    ? `- \`.env\` files anywhere under \`cwd\`, a \`writeDirs\` or an \`addDirs\` folder are unreadable to a Head, shell included (the sandbox refuses the read, so \`grep -r\` skips them too). Other project secrets (\`local.properties\`, keystores, \`google-services.json\`) are readable: do not point a Head at a project where that matters.`
    : engine === 'codebuddy'
    ? `- \`.env\` files are denied to a Head's read, edit and search tools. A Head with \`shell: true\` can still read \`.env\` through a command that does not name it (\`grep -r\`), so avoid shell in projects with real secrets.`
    : `- If the project or an \`addDirs\` folder holds a \`.env\` file, Heads have no search tool: name the exact files in the task. A Head with \`shell: true\` can still read \`.env\` through a command that does not name it (\`grep -r\`), so avoid shell in projects with real secrets.`

/** What each engine is good for, as the Lead's routing guide. Judgement from how they run, not a benchmark, except where it says measured. */
const ROUTES: Record<Engine, string> = {
  codex: `gpt-6.1-sol (pass \`model: "gpt-6-luna"\` for easy work): the strongest coder here. Send it hard, subtle or multi-file work, and anything where the Head should run the tests itself (its shell is sandboxed with no network, so nothing that downloads). Spends the person's ChatGPT plan.`,
  agy: `gemini-3.8-flash only: fast, large context. Send it reading and summarising big areas, docs, boilerplate and bulk, mechanical or simple well-specified edits across many files. No shell unless \`shell: true\`; a refused call ends a round (Hydra resumes it).`,
  codebuddy: `DeepSeek V4.1 Flash: the cheap default. Send it well-specified edits, renames, new tests and small features. Measured: 95% of 126 runs passed at \`low\` effort. Optional shell.`,
  commandcode: `DeepSeek V4.1 Flash, same model as CodeBuddy, with dollar spend tracking. Use it when CodeBuddy is unavailable or its spend limits matter. Optional shell; no search tool when a \`.env\` file is in reach.`,
}

const autoEffortRule = (effort: EffortMode) =>
  effort === 'auto'
    ? `- You pick each Head's reasoning \`effort\` (low, medium, high, xhigh or max; an engine's model rounds to the nearest level it has):
  - \`low\` (the default) for every Head whose result you will check by running something (tests, a build, the app) or, for mechanical edits, by reading the diff, as long as the task text is a full spec.
  - When the check fails, send the Head back with the failure in the task, one step up: a higher effort on the same engine, then a stronger engine.
  - Top effort first only when you cannot check the result cheaply (nothing to run or test) and the work is subtle: state, cycles, concurrency, an algorithm, or a bug known only by its symptoms.
  - Never raise effort to make up for a vague brief: write the spec first.`
    : `- The person fixed every Head's effort at ${effort} with /hydra effort=${effort}; your \`effort\` field is ignored until they set /hydra effort=auto.`

/** The policy lines that differ per engine, one sub-bullet per engine in the pool. */
const perEngine = (pool: readonly Engine[], text: (engine: Engine) => string) => pool.map(engine => `  - ${ENGINE_LABEL[engine]}: ${text(engine).replace(/^- /, '')}`).join('\n')

const autoPolicy = (effort: EffortMode, pool: readonly Engine[]) => `# Hydra mode (on, auto engines)
You are the Lead. Implementation goes to Heads, called through the ${HEAD_TOOL} tool, and you choose the engine for each Head with its \`engine\` field (one of: ${pool.join(', ')}). A call without one is refused.
- Split first, then route each task to the engine that suits it. Tasks on disjoint files can go to different engines in parallel (\`background: true\`).
${pool.map(engine => `  - \`${engine}\` (${ENGINE_LABEL[engine]}): ${ROUTES[engine]}`).join('\n')}
- Routing rules: when unsure, take the cheapest engine in the pool that can do it (${pool.includes('codebuddy') ? 'codebuddy' : pool.includes('commandcode') ? 'commandcode' : pool[0]}); put the hard 20% on the strongest (${pool.includes('codex') ? 'codex' : pool[0]}). A Head that fails its check goes back on the same engine one effort level up, then on a stronger engine. Do not switch engines for a vague brief: rewrite it. Say in your plan which engine each task goes to, and why in a few words.
${autoEffortRule(effort)}
- Plan first: each Head task states the goal, the exact files, the constraints and the acceptance check; a Head sees only the repo and your task text.
- How each engine locks a Head down:
${perEngine(pool, lockdownRules)}
- A Head writes only inside \`cwd\`; a write anywhere else, a symlink pointing out of the project included, is denied. When the task must change a folder outside it (a symlinked package's real location, a sibling repo), pass that folder in \`writeDirs\`, and only that folder.
- About secrets:
${perEngine(pool, envRule)}
- Give every Head a short \`name\` that says what it works on (\`prefs-utils\`, \`login-tests\`): you and the person track, stop and discuss Heads by that name. Without one, Hydra makes one from the task.
- Dependent tasks run in sequence; independent ones in parallel.
- Keep the judgement-heavy part yourself: architecture, tricky bugs, anything under ~20 lines.
- Never trust a Head's report. Read the diff and run the build/tests yourself, then fix it or send the Head back with precise feedback. A report lists the engine, the files the Head edited and every call that was denied.
- You manage the Heads yourself with ${CONTROL_TOOL}: \`list\` shows every Head (one marked NO LIVE PROCESS is stale), \`stop\` ends a stuck, wrong or stale Head (\`id\`, or all), \`clear\` drops finished ones from the views. Stop a Head yourself instead of asking the person to.
- End with what each Head did (and on which engine), what you verified, and the Heads' total cost.`

export const HYDRA_POLICY = (headModel: string, effort: EffortMode, engine: Engine | typeof AUTO = DEFAULT_ENGINE, pool: readonly Engine[] = ENGINES) =>
  engine === AUTO ? autoPolicy(effort, pool) : `# Hydra mode (on)
You are the Lead. Implementation goes to Heads: ${ENGINE_LABEL[engine]} agents on ${headModel}, called through the ${HEAD_TOOL} tool.
${effortRule(effort, headModel, engine)}
- Plan first: split the work into self-contained tasks. Each Head task states the goal, the exact files, the constraints and the acceptance check; a Head sees only the repo and your task text.
${lockdownRules(engine)}
- A Head writes only inside \`cwd\`; a write anywhere else, a symlink pointing out of the project included, is denied. When the task must change a folder outside it (a symlinked package's real location, a sibling repo), pass that folder in \`writeDirs\`, and only that folder.
${envRule(engine)}
- Give every Head a short \`name\` that says what it works on (\`prefs-utils\`, \`login-tests\`): you and the person track, stop and discuss Heads by that name. Without one, Hydra makes one from the task.
- Independent tasks on disjoint files go out as parallel ${HEAD_TOOL} calls with \`background: true\`: each returns at once and its report arrives later as a message from the hydra plugin. Dependent tasks run in sequence.
- Keep the judgement-heavy part yourself: architecture, tricky bugs, anything under ~20 lines.
- Never trust a Head's report. Read the diff and run the build/tests yourself, then fix it or send the Head back with precise feedback. A report lists the files the Head edited and every call that was denied.
- You manage the Heads yourself with ${CONTROL_TOOL}: \`list\` shows every Head (one marked NO LIVE PROCESS is stale), \`stop\` ends a stuck, wrong or stale Head (\`id\`, or all), \`clear\` drops finished ones from the views. Stop a Head yourself instead of asking the person to.
- End with what each Head did, what you verified, and the Heads' total cost.`

const ACTIONS = ['off', 'status', 'help', 'statusline', 'engines'] as const

/** A lone word or an `x=`/`--x` option nobody knows is a typo, never a task. */
export const parseHydraArgs = (args: string) => {
  const words = args.trim().split(/\s+/).filter(Boolean)
  let action: 'on' | (typeof ACTIONS)[number] = 'on'
  let leadModel: string | undefined
  let headModel: string | undefined
  let effort: string | undefined
  let engine: string | undefined
  let engines: string | undefined
  const rest: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    const lower = word.toLowerCase()
    if (i === 0 && (ACTIONS as readonly string[]).includes(lower)) action = lower as (typeof ACTIONS)[number]
    else if (rest.length === 0 && !leadModel && (LEADS as readonly string[]).includes(lower)) leadModel = lower
    else if (rest.length === 0 && lower.startsWith('head=')) headModel = word.slice(5)
    else if (rest.length === 0 && lower === '--head' && words[i + 1]) headModel = words[++i]
    else if (rest.length === 0 && lower.startsWith('engine=')) engine = lower.slice(7)
    else if (rest.length === 0 && lower === '--engine' && words[i + 1]) engine = words[++i]!.toLowerCase()
    else if (rest.length === 0 && lower.startsWith('engines=')) engines = lower.slice(8)
    else if (rest.length === 0 && lower === '--engines' && words[i + 1]) engines = words[++i]!.toLowerCase()
    else if (rest.length === 0 && lower.startsWith('effort=')) effort = lower.slice(7)
    else if (rest.length === 0 && lower === '--effort' && words[i + 1]) effort = words[++i]!.toLowerCase()
    else rest.push(word)
  }
  const first = rest[0] ?? ''
  const unknown = rest.length === 1 || /^[\w-]+=/.test(first) || first.startsWith('--') ? first : undefined
  return { action, leadModel, headModel, effort, ...(engine !== undefined ? { engine } : {}), ...(engines !== undefined ? { engines } : {}), task: unknown ? '' : rest.join(' '), unknown }
}

export const HYDRA_HELP = `🐉 Hydra: Claude leads, Heads (Command Code, CodeBuddy, Codex or Antigravity agents) implement.
  /hydra                 turn Hydra on
  /hydra <task>          turn it on and hand Claude the task
  /hydra off             turn it off
  /hydra status          show what is set
  /hydra effort=<level>  auto (Claude picks per Head) or off, low, medium, high, xhigh, max
  /hydra head=<model>    the model Heads run on
  /hydra engine=<name>   commandcode, codebuddy, codex or agy: the CLI Heads run on; auto lets Claude pick per Head
  /hydra engines=a,b     the engines auto may use (implies engine=auto), e.g. engines=codex,agy,codebuddy
  /hydra engines         which engines are installed and signed in, and what each is for
  /hydra statusline      show Hydra in your status line
  /heads                 watch the Heads work, live
  /${USAGE_COMMAND}           Claude and Head usage`

export const STATUSLINE_HELP = `Hydra writes its line to ~/.claude/hydra/status/<session id>.txt while it is on. To show it, add this before the final printf of your status line script, where $input is the JSON Claude Code passes and $out your line:

session_id=$(printf '%s' "$input" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[A-Za-z0-9-]*"' | head -1 | sed -E 's/.*"([A-Za-z0-9-]*)"$/\\1/')
hydra_file="$HOME/.claude/hydra/status/$session_id.txt"
if [ -n "$session_id" ] && [ -s "$hydra_file" ]; then
  printf '%s\\n%s' "$out" "$(head -1 "$hydra_file")"
else
  printf '%s' "$out"
fi

Then add "refreshInterval": 2 to the statusLine block of ~/.claude/settings.json, so the line appears and clears within 2 seconds of /hydra and /hydra off instead of at your next message.

A full script is in the repo's examples/statusline.sh. Without it, the band above the prompt and /heads show the same.`

export const EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const HEAD_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const EFFORT_MODES = ['auto', ...EFFORTS] as const
export const DEFAULT_EFFORT = 'low'

export type EffortMode = (typeof EFFORT_MODES)[number]

export const isEffort = (value: unknown): value is string => typeof value === 'string' && (EFFORTS as readonly string[]).includes(value)
export const isHeadEffort = (value: unknown): value is (typeof HEAD_EFFORTS)[number] => typeof value === 'string' && (HEAD_EFFORTS as readonly string[]).includes(value)
export const isEffortMode = (value: unknown): value is EffortMode => typeof value === 'string' && (EFFORT_MODES as readonly string[]).includes(value)

/** The session's effort mode; anything else stored there reads as auto. */
export const effortModeOf = (hydra: HydraMode | null) => (isEffortMode(hydra?.effort) ? hydra.effort : 'auto')

/** The person's fixed level wins, any level; under auto the Lead's pick (low to max) does, and low when it gave none. */
export const headEffort = (mode: EffortMode, leadPick: string | undefined) => (mode !== 'auto' ? mode : isHeadEffort(leadPick) ? leadPick : DEFAULT_EFFORT)

/** The model's levels from Command Code's refusal: `Unknown effort "medium". Supported: off, low, high, max.` */
export const supportedEfforts = (errors: string) => {
  const list = /Supported:\s*([a-z, ]+)/i.exec(errors)?.[1]
  return list ? list.split(',').map(level => level.trim()).filter(isEffort) : []
}

/** The nearest level the model takes, rounding up so a Head never thinks less than asked. */
export const nearestEffort = (wanted: string, supported: readonly string[]) => {
  const rank = (level: string) => (EFFORTS as readonly string[]).indexOf(level)
  const sorted = [...supported].sort((a, b) => rank(a) - rank(b))
  return sorted.find(level => rank(level) >= rank(wanted)) ?? sorted.at(-1)
}

export const leadLabel = (kind: string) =>
  LEAD_LABELS[kind] ?? kind.replace(/^seven_day_?/, 'Weekly · ').replace(/_/g, ' ')

export const resetsIn = (iso: string | null | undefined, now: number) => {
  if (!iso) return ''
  const minutes = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days > 0) return `Resets in ${days} d ${hours} hr`
  return hours > 0 ? `Resets in ${hours} hr ${rest} min` : `Resets in ${rest} min`
}

export const barOf = (percent: number, width: number) => {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const colorOf = (percent: number) => (percent >= WARN_AT ? 'red' : percent >= 75 ? 'yellow' : 'blue')

const percentOf = (usd: number, limit: number) => (limit > 0 ? Math.round((usd / limit) * 1000) / 10 : 0)

const shortModel = (model: string) => model.split('/').pop() ?? model

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

export const clockOf = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const two = (n: number) => String(n).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return hours > 0 ? `${hours}:${two(minutes)}:${two(total % 60)}` : `${minutes}:${two(total % 60)}`
}

export const elapsedOf = (run: HeadRun, now: number) => (run.startedAt ? clockOf((run.endedAt ?? now) - run.startedAt) : '–')

export const glyphOf = (run: HeadRun, frame: number) =>
  run.state === 'running' ? SPINNER[frame % SPINNER.length]! : run.state === 'queued' ? '◌' : run.state === 'done' ? '✓' : '✗'

const glyphColor = (run: HeadRun) => (run.state === 'running' ? 'cyan' : run.state === 'done' ? 'green' : run.state === 'failed' ? 'red' : undefined)

/** Running and queued Heads, and any that ended in the last minute, so the band shows how they finished. */
export const isLive = (run: HeadRun, now: number) =>
  run.state === 'running' || run.state === 'queued' || (run.endedAt !== undefined && now - run.endedAt < LIVE_AFTER_END_MS)

export const headsSummary = (list: readonly HeadRun[]) =>
  (['running', 'queued', 'done', 'failed'] as const)
    .map(state => [state, list.filter(run => run.state === state).length] as const)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${state}`)
    .join(' · ')

/** What a Head is doing now, or how it ended. */
export const nowLine = (run: HeadRun) =>
  run.state === 'done' ? `done${run.costUsd !== undefined ? ` · $${run.costUsd.toFixed(4)}` : run.tokens ? ` · ${run.tokens}` : ''}` : run.activity ?? run.state

export type HeadLimits = { fiveHourUsd: number; weeklyUsd: number }

export const CODEBUDDY_NO_SPEND = 'CodeBuddy counts credits, not dollars, so Hydra shows tokens per Head instead of spend.'
export const CODEX_NO_SPEND = 'Codex runs on your ChatGPT plan, not dollars, so Hydra shows tokens per Head instead of spend.'
export const AGY_NO_SPEND = 'Antigravity runs on your Google account quota, not dollars, so Hydra shows tokens per Head instead of spend.'
export const AUTO_NO_SPEND = 'Heads run on engines that count credits, plan usage or quota, not dollars, so Hydra shows tokens per Head instead of spend.'
export const isNoSpend = (error: string | undefined) => error === CODEBUDDY_NO_SPEND || error === CODEX_NO_SPEND || error === AGY_NO_SPEND || error === AUTO_NO_SPEND


/** Shown only while Hydra is on: the Head model and effort, and what Heads spent against their 5-hour and weekly limits. */
export const statusLine = (hydra: HydraMode | null, usage: HeadsUsage | null, limits: HeadLimits) => {
  if (!hydra?.isOn) return undefined
  const parts = [isAuto(hydra)
    ? `🐉 Auto ${poolOf(hydra).join('+')} · ${effortModeOf(hydra)}`
    : `🐉 ${isEngine(hydra.engine) && hydra.engine !== 'commandcode' ? `${ENGINE_LABEL[hydra.engine]} ` : ''}${shortModel(hydra.headModel)} · ${effortModeOf(hydra)}`]
  if (usage && !usage.error) {
    parts.push(`Heads 5h ${spentOf(usage.fiveHour.usd, limits.fiveHourUsd)}`, `7d ${spentOf(usage.weekly.usd, limits.weeklyUsd)}`)
  }
  return parts.join(' | ')
}

/** Spend against a limit, or the spend alone while the person has set no limit (0). */
export const spentOf = (usd: number, limit: number) => (limit > 0 ? `$${usd.toFixed(2)}/$${limit}` : `$${usd.toFixed(2)}`)

/** Where the person's status line command finds this session's Hydra line; empty while Hydra is off. */
export const statusFile = (home: string, sessionId: string) => `${home}/.claude/hydra/status/${sessionId}.txt`

let lastStatus: string | undefined

/**
 * Hydra's line goes to a per-session file that ~/.claude/statusline.sh prints, not to `$.ui.status`, which the
 * engine draws with a `⚠ hydra:` prefix.
 */
async function refreshStatus($: EngineInterface, limits: HeadLimits) {
  const line = statusLine(await read($, mode), await read($, heads), limits) ?? ''
  if (line === lastStatus) return
  const home = await $.env.get('HOME')
  if (!home) return
  await $.fs.write(statusFile(home, await $.session.id()), line ? `${line}\n` : '')
  lastStatus = line
}

/** Deletes other sessions' status files untouched for a week. */
async function sweepStatusFiles($: EngineInterface) {
  const home = await $.env.get('HOME')
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

/** What stops Heads from running on this machine, each with what to run about it. */
async function preflight($: EngineInterface, engine: Engine = DEFAULT_ENGINE): Promise<Preflight> {
  if (preflightPassed.has(engine)) return { problems: [], warnings: [] }
  const works = (argv: string[]) => $.process.run(argv, { timeoutMs: 15_000 }).then(ran => ran.exitCode === 0, () => false)
  if (!(await works(['uname', '-s']))) return { problems: ['Hydra runs on macOS and Linux only for now. On Windows, run Claude Code under WSL.'], warnings: [] }
  const problems: string[] = []
  if (!(await works(['/usr/bin/env', ENGINE_BIN[engine], '--version']))) {
    problems.push(
      engine === 'agy'
        ? 'The Antigravity CLI is not installed. Run `curl -fsSL https://antigravity.google/cli/install.sh | bash` (read the script first if you like), then `agy` once in a terminal to sign in.'
        : engine === 'codex'
        ? 'The Codex CLI is not installed. Run `npm i -g @openai/codex`, then `codex login` in a terminal to sign in.'
        : engine === 'codebuddy'
        ? 'The CodeBuddy CLI is not installed. Run `npm i -g @tencent-ai/codebuddy-code`, then `codebuddy` once in a terminal to sign in.'
        : 'The Command Code CLI is not installed. Run `npm i -g command-code`, then `commandcode` once in a terminal to sign in.',
    )
  }
  if (!(await works(['/usr/bin/env', 'python3', '--version']))) {
    problems.push('python3 is missing; Hydra reads Head transcripts with it. Install it (on macOS: `xcode-select --install`).')
  }
  if (!(await works(['git', '--version']))) problems.push('git is missing. Install it (on macOS: `xcode-select --install`).')
  const home = await $.env.get('HOME')
  if (engine === 'codex' && problems.length === 0 && !(await works(['/usr/bin/env', 'codex', 'login', 'status']))) {
    problems.push('Codex is not signed in. Run `codex login` in a terminal (`codex login --device-auth` on a remote machine), then try again.')
  }
  if (engine === 'agy' && problems.length === 0 && !(home && (await $.fs.exists(`${home}/${AGY_TOKEN}`).catch(() => false)))) {
    problems.push('Antigravity is not signed in. Run `agy` once in a terminal (choose Google OAuth), then try again.')
  }
  const isSignedIn = engine !== 'commandcode' || (home ? await $.fs.exists(`${home}/.commandcode/auth.json`).catch(() => false) : false)
  const warnings = isSignedIn || problems.length > 0 ? [] : ['Command Code looks signed out: run `commandcode` once in a terminal to sign in, or Heads will fail.']
  if (problems.length === 0) preflightPassed.add(engine)
  return { problems, warnings }
}

export const preflightText = (check: Preflight) =>
  [`🐉 Hydra can't start yet:`, ...check.problems.map(problem => `  • ${problem}`), 'Then run /hydra again.'].join('\n')

export const CONSENT_QUESTION = (headModel: string, engine: Engine = DEFAULT_ENGINE) =>
  engine === 'agy'
    ? `Hydra hands each Head's task, and every file the Head reads, to ${AGY_MODEL} through the Antigravity CLI (Google), and Heads edit this project unattended (\`agy -p\` in Antigravity's terminal sandbox, locked down by Hydra's permission rules: writes only inside the project, no .git or existing .env, no network). Turn Hydra on?`
    : engine === 'codex'
    ? `Hydra hands each Head's task, and every file the Head reads, to ${headModel} through Codex (OpenAI, on your ChatGPT plan), and Heads edit this project unattended (\`codex exec\` in Codex's OS sandbox, locked down by Hydra's filesystem profile: writes only inside the project, no .git or .env, no network). Turn Hydra on?`
    : engine === 'codebuddy'
    ? `Hydra hands each Head's task, and every file the Head reads, to ${headModel} through CodeBuddy, and Heads edit this project unattended (CodeBuddy's headless mode, locked down by Hydra's permission rules and write guard: nothing outside the project, no .git or .env, no shell unless Claude asks). Turn Hydra on?`
    : `Hydra hands each Head's task, and every file the Head reads, to ${headModel} through Command Code, and Heads edit this project unattended (Command Code's --yolo, locked down by Hydra: nothing outside the project, no .git or .env, no shell unless Claude asks). Turn Hydra on?`

const CONSENT_YES = 'Turn Hydra on'

const consentKey = (engine: Engine) => (engine === 'commandcode' ? CONSENT_KEY : `${CONSENT_KEY}:${engine}`)

const PROVIDER: Record<Engine, string> = { commandcode: 'DeepSeek', codebuddy: 'DeepSeek', codex: 'OpenAI', agy: 'Google (Gemini)' }

export const AUTO_CONSENT_QUESTION = (engines: readonly Engine[]) =>
  `Hydra will let Claude route Heads across ${engines.map(engine => `${ENGINE_LABEL[engine]} (${PROVIDER[engine]})`).join(', ')}. Each Head's task, and every file it reads, goes to the model of the engine it picks, and Heads edit this project unattended inside that engine's lockdown (writes only in the project, no .git, .env files kept out where the engine can, no network where the engine can block it). Turn Hydra on?`

/** Asks once for every engine in `engines` that has no saved answer; the answers are kept across sessions. */
async function hasConsentAll($: EngineInterface, engines: readonly Engine[], mayAsk: boolean) {
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
async function readyEngines($: EngineInterface, wanted: readonly Engine[]) {
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

/** Asks once, the first time Hydra turns on; the answer is kept across sessions. */
async function hasConsent($: EngineInterface, headModel: string, mayAsk: boolean, engine: Engine = DEFAULT_ENGINE) {
  const key = consentKey(engine)
  if ((await $.store.get(key)) === true) return true
  if (!mayAsk) return false
  const answer = await $.ui.ask(CONSENT_QUESTION(headModel, engine), { options: [CONSENT_YES, 'Not now'], header: 'Hydra' }).catch(() => undefined)
  if (answer !== CONSENT_YES) return false
  await $.store.set(key, true)
  return true
}

async function refreshHeads($: EngineInterface, limits: HeadLimits) {
  const hydra = await read($, mode)
  const engine = engineOf(hydra)
  const hasCommandCode = isAuto(hydra) ? poolOf(hydra).includes('commandcode') : engine === 'commandcode'
  if (!hasCommandCode) {
    const measuredAt = await $.clock.now()
    const error = isAuto(hydra) ? AUTO_NO_SPEND : engine === 'agy' ? AGY_NO_SPEND : engine === 'codex' ? CODEX_NO_SPEND : CODEBUDDY_NO_SPEND
    await update($, heads, () => ({ fiveHour: { usd: 0, resetsAt: null }, weekly: { usd: 0, resetsAt: null }, measuredAt, error }))
    await refreshStatus($, limits)
    return
  }
  try {
    const ran = await $.process.run(['/usr/bin/env', 'python3', '-I', `${$.plugin.root}/bin/cc-usage.py`], { timeoutMs: 20_000 })
    const usage = JSON.parse(ran.stdout) as HeadsUsage
    await update($, heads, () => usage)
  } catch (error) {
    const measuredAt = await $.clock.now()
    await update($, heads, () => ({
      fiveHour: { usd: 0, resetsAt: null },
      weekly: { usd: 0, resetsAt: null },
      measuredAt,
      error: String(error).slice(0, 120),
    }))
  }
  await refreshStatus($, limits)
}

async function storeLead($: EngineInterface, windows: readonly LeadWindow[], limits: HeadLimits) {
  await update($, lead, () => windows.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt })))
  for (const w of windows) {
    const mark = `${w.kind}@${w.resetsAt ?? ''}`
    if (w.percentUsed < WARN_AT || (await read($, warned)).includes(mark)) continue
    await update($, warned, list => [...list, mark].slice(-20))
    $.ui.toast(`Claude ${leadLabel(w.kind)} at ${Math.round(w.percentUsed)}% · ${resetsIn(w.resetsAt, await $.clock.now())}`)
  }
  await refreshStatus($, limits)
}

async function setRun($: EngineInterface, id: string, change: Partial<HeadRun> | ((run: HeadRun) => Partial<HeadRun>)) {
  await update($, runs, list => list.map(run => (run.id === id ? { ...run, ...(typeof change === 'function' ? change(run) : change) } : run)))
}

/** The events of Command Code's JSON stream the live view reads. */
export type StreamEvent = { type: string; toolCallId?: string; toolName?: string; input?: Record<string, unknown>; isError?: boolean }

const WATCHED = new Set(['turn_end', 'thinking_start', 'tool_queued', 'tool_running', 'tool_completed', 'tool_denied'])
const EDIT_TOOLS = new Set(['edit_file', 'write_file'])
const MAX_STEPS = 8

/** A short line for a tool call: `edit c.txt`, `search "TODO"`, `$ ls`. */
export const describeTool = (name: string, input: Record<string, unknown> = {}, cwd = '') => {
  const path = String(input.file_path ?? input.path ?? '')
  const at = !path || path === cwd || path === `${cwd}/` ? '.' : relativeTo(cwd, path)
  const verbs: Record<string, string> = { read_file: 'read', edit_file: 'edit', write_file: 'write', read_directory: 'list' }
  if (verbs[name]) return `${verbs[name]} ${at}`
  if (name === 'grep') return `search "${String(input.pattern ?? '')}"`
  if (name === 'glob') return `find ${String(input.pattern ?? '')}`
  if (name === 'shell_command') return `$ ${String(input.command ?? '')}`
  return name.replace(/_/g, ' ')
}

/** Folds one stream event into a Head's live record; `labels` keeps each queued call's line for its later events. */
export const applyEvent = (run: HeadRun, event: StreamEvent, labels: Map<string, string>, cwd: string): Partial<HeadRun> => {
  const label = () => labels.get(event.toolCallId ?? '') ?? describeTool(event.toolName ?? 'tool')
  switch (event.type) {
    case 'thinking_start':
      return { activity: 'thinking' }
    case 'tool_queued':
      labels.set(event.toolCallId ?? '', describeTool(event.toolName ?? 'tool', event.input, cwd))
      return {}
    case 'tool_running':
      return { activity: label() }
    case 'tool_completed':
    case 'tool_denied': {
      const isOk = event.type === 'tool_completed'
      const step: HeadStep = { isOk, text: label() }
      return {
        steps: [...(run.steps ?? []), step].slice(-MAX_STEPS),
        edits: (run.edits ?? 0) + (isOk && !event.isError && EDIT_TOOLS.has(event.toolName ?? '') ? 1 : 0),
        denials: (run.denials ?? 0) + (isOk ? 0 : 1),
      }
    }
    case 'turn_end':
      return { turns: run.turns + 1 }
    default:
      return {}
  }
}

type SessionReport = { usd: number | null; files: string[]; denied: { tool: string; target: string; text: string }[]; toolCalls: number }

/** The session a Head started, found from its transcript when the run ended before reporting it (a timeout, a kill). */
async function findSession($: EngineInterface, since: number, task: string): Promise<string | undefined> {
  try {
    const ran = await $.process.run(['/usr/bin/env', 'python3', '-I', `${$.plugin.root}/bin/cc-usage.py`, '--find', String(since - 5_000), task.slice(0, 100)])
    return (JSON.parse(ran.stdout) as { sessionId: string | null }).sessionId ?? undefined
  } catch {
    return undefined
  }
}

async function sessionReport($: EngineInterface, sessionId: string): Promise<SessionReport> {
  try {
    const ran = await $.process.run(['/usr/bin/env', 'python3', '-I', `${$.plugin.root}/bin/cc-usage.py`, '--report', sessionId])
    return JSON.parse(ran.stdout) as SessionReport
  } catch {
    return { usd: null, files: [], denied: [], toolCalls: 0 }
  }
}

export const DONE_MARK = 'HEAD DONE'
const MAX_ROUNDS = 8
const MAX_PARALLEL = 6
const DEFAULT_MINUTES = 40
const START_RETRIES = 2
const RULES_FILE = '.commandcode/settings.local.json'
const OWNER = 'hydra'

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

/** Shell commands a Head never runs, even when its task turns shell on. */
export const DANGEROUS_SHELL = [
  'Shell(git commit*)', 'Shell(git push*)', 'Shell(git reset*)', 'Shell(git checkout*)', 'Shell(git switch*)',
  'Shell(git restore*)', 'Shell(git stash*)', 'Shell(git clean*)', 'Shell(git rebase*)', 'Shell(git merge*)',
  'Shell(git branch -D*)', 'Shell(git tag*)', 'Shell(gh *)',
  'Shell(rm -r*)', 'Shell(rm -f*)', 'Shell(rm -R*)', 'Shell(sudo*)', 'Shell(su *)', 'Shell(chmod*)', 'Shell(chown*)',
  'Shell(curl*)', 'Shell(wget*)', 'Shell(ssh*)', 'Shell(scp*)', 'Shell(rsync*)', 'Shell(nc *)', 'Shell(open *)',
  'Shell(osascript*)', 'Shell(launchctl*)', 'Shell(defaults write*)', 'Shell(security *)', 'Shell(kill*)', 'Shell(pkill*)',
  'Shell(xcodebuild*)', 'Shell(swift build*)', 'Shell(swift test*)', 'Shell(npm publish*)', 'Shell(npm install*)',
  'Shell(pip install*)', 'Shell(brew *)',
]

/**
 * Inside the project a Head may edit anything except the repo's history, Hydra's own rules and secret files.
 * Shell rules match `.env` only as a path (after a space, `/` or `=`), so `process.env` still runs.
 */
export const PROJECT_DENY = [
  'Edit(/.git/**)', 'Edit(/.commandcode/**)',
  'Read(.env)', 'Read(.env.*)', 'Edit(.env)', 'Edit(.env.*)', 'Shell(* .env*)', 'Shell(*/.env*)', 'Shell(*=.env*)',
]

/** The grep tool ignores Read rules and has no path-scoped deny, so it is denied whole when a `.env` file is in reach. */
export const SEARCH_DENY = 'Grep'

type Permissions = { allow?: string[]; deny?: string[]; additionalDirectories?: string[] }
type GuardHook = { matcher: string; hooks: { type: 'command'; command: string; timeout: number }[] }
type HeadNeeds = { addDirs: readonly string[]; shell: boolean; writeDirs?: readonly string[] }
/** A running Head the rules file is kept for: `key` is `<session id>/<head id>`, `until` when it must have ended. */
export type HeadEntry = HeadNeeds & { key: string; until: number }
type HeadSettings = { managedBy?: string; hydraHeads?: HeadEntry[]; permissions?: Permissions; hooks?: { PreToolUse: GuardHook[] } }

const union = (a: readonly string[] = [], b: readonly string[] = []) => [...new Set([...a, ...b])]

/**
 * Hydra's rules for Heads run under --yolo: deny rules are the only thing yolo honours, so every write outside the
 * project is denied path by path, and shell is denied outright unless a running Head in this project asked for it.
 */
/** The folders outside the project that the running Heads may write to, from every Head's `writeDirs`. */
export const writeDirsOf = (heads: readonly HeadNeeds[]) => heads.reduce<string[]>((dirs, head) => union(dirs, head.writeDirs ?? []), [])

/** What stays protected inside a folder a Head may write to: its history, its Command Code settings and its secrets. */
export const writeDirDeny = (dir: string) => [
  `Edit(/${dir}/.git/**)`, `Edit(/${dir}/.commandcode/**)`,
  `Edit(/${dir}/**/.env)`, `Edit(/${dir}/**/.env.*)`, `Read(/${dir}/**/.env)`, `Read(/${dir}/**/.env.*)`,
]

export const headSettings = (heads: readonly HeadNeeds[], outsideDeny: readonly string[], hasEnvFile = false, guard?: string): HeadSettings => {
  const shell = heads.some(head => head.shell)
  const writeDirs = writeDirsOf(heads)
  return {
    managedBy: OWNER,
    permissions: {
      deny: [
        ...outsideDeny, ...PROJECT_DENY, ...writeDirs.flatMap(writeDirDeny),
        ...(shell ? DANGEROUS_SHELL : ['Shell']), ...(hasEnvFile ? [SEARCH_DENY] : []),
      ],
      additionalDirectories: heads.reduce<string[]>((dirs, head) => union(dirs, [...head.addDirs, ...(head.writeDirs ?? [])]), []),
    },
    ...(guard ? { hooks: { PreToolUse: [{ matcher: 'write|edit', hooks: [{ type: 'command' as const, command: guard, timeout: 10 }] }] } } : {}),
  }
}

const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

/**
 * The write guard Command Code runs before every write and edit: it denies a path whose real location is outside
 * `cwd` and the `writeDirs`, which deny rules cannot express for a new folder (write_file creates missing parents).
 */
export const guardCommand = (pluginRoot: string, cwd: string, writeDirs: readonly string[] = []) =>
  [`/usr/bin/env python3 -I ${shellQuote(`${pluginRoot}/bin/head-guard.py`)}`, ...[cwd, ...writeDirs].map(shellQuote)].join(' ')

const isWithin = (path: string, root: string) => path === root || path.startsWith(`${root.replace(/\/$/, '')}/`)

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

/**
 * The real folders a Head asked to write to outside `cwd`, or why one is refused: it must exist, and must not be
 * `/`, the home folder, a folder above the project or one inside it.
 */
async function resolveWriteDirs($: EngineInterface, cwd: string, dirs: readonly string[]): Promise<{ dirs: string[] } | { refusal: string }> {
  const home = (await $.env.get('HOME')) ?? ''
  const realCwd = (await $.fs.stat(cwd, { resolve: true }).catch(() => undefined))?.realPath ?? cwd
  const resolved: string[] = []
  for (const dir of dirs) {
    if (!dir.startsWith('/')) return { refusal: `writeDirs needs absolute folders; "${dir}" is not one.` }
    const stat = await $.fs.stat(dir, { resolve: true }).catch(() => undefined)
    const real = stat?.realPath
    if (!stat || stat.kind !== 'dir' || !real) return { refusal: `writeDirs: ${dir} is not an existing folder.` }
    if (real === '/' || real === home || isWithin(realCwd, real)) return { refusal: `writeDirs: ${dir} is too broad: it holds the project or your home folder. Name the folder the task changes.` }
    if (isWithin(real, realCwd)) return { refusal: `writeDirs: ${dir} is inside the project, which a Head can write to already.` }
    resolved.push(real)
  }
  return { dirs: union(resolved) }
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
async function writeRules($: EngineInterface, cwd: string): Promise<string | undefined> {
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
  const envFile = await findEnvFile($, [cwd, ...heads.reduce<string[]>((dirs, head) => union(dirs, head.addDirs), []), ...writeDirs])
  if (envFile) searchOff.set(cwd, envFile)
  else searchOff.delete(cwd)
  const outsideDeny = await outsideDenyRules($, [cwd, ...writeDirs])
  const settings = { ...headSettings(heads, outsideDeny, Boolean(envFile), guardCommand($.plugin.root, cwd, writeDirs)), hydraHeads: heads }
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

const gate = createGate(MAX_PARALLEL)

/**
 * Background Heads run in a worker loop that `session.start` owns, on that hook's `$`: a `tool.call` hook's `$`
 * lapses once the call is long over, and a Head spawned under it dies with it. The tool call only queues the job.
 */
type HeadResult = { text: string; isDone: boolean }
/** `reply` hands a foreground call its result; it answers false once that call is gone, and the report goes out as a message. */
type Job = { input: Record<string, unknown>; headModel: string; id: string; engine?: Engine; reply?: (result: HeadResult) => boolean }

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
const controllers = new Map<string, AbortController>()

export const stopReason = (signal: AbortSignal) => (typeof signal.reason === 'string' && signal.reason ? signal.reason : 'stopped')

/**
 * Marks running and queued Heads in `ids` (all of them when `ids` is 'all') as failed with `reason`.
 * Used for Heads that have no live process behind them any more, so the views stop counting.
 */
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'one', 'file', 'files', 'convert', 'add', 'fix', 'make', 'update', 'implement', 'write', 'task', 'goal', 'repo', 'android', 'kotlin', 'java'])
const NAME_MAX = 20

/** Lowercase kebab, letters and digits only, at most 20 characters, cut at a dash. */
export const slugOf = (text: string) => {
  const slug = text
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length <= NAME_MAX) return slug
  const cut = slug.slice(0, NAME_MAX)
  return (cut.includes('-') ? cut.slice(0, cut.lastIndexOf('-')) : cut).replace(/-+$/, '')
}

/** A name from the task: the first source file it names, else its first few meaningful words. */
export const nameFromTask = (task: string) => {
  const file = /([A-Za-z][\w-]*)\.(?:kt|kts|java|ts|tsx|js|jsx|swift|go|py|dart|xml|gradle)\b/.exec(task)?.[1]
  if (file) return slugOf(file)
  const words = (task.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []).filter(word => word.length > 2 && !STOP_WORDS.has(word))
  return slugOf(words.slice(0, 3).join('-')) || 'head'
}

/** The Lead's name, or one from the task, made unique among names already taken this session (`-2`, `-3`…). */
export const headName = (requested: unknown, task: string, taken: ReadonlySet<string>) => {
  const base = (typeof requested === 'string' && slugOf(requested)) || nameFromTask(task)
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const candidate = `${base.slice(0, NAME_MAX - suffix.length).replace(/-+$/, '')}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Waits for a worker-run Head's result by repeatedly awaiting `pause`, which must be a `$` call (a host `sleep`):
 * the engine stops a hook's own clock while a `$` call is in flight, so the wait costs no budget. Ends early on abort.
 */
export const waitForResult = async <T,>(box: { result?: T }, signal: AbortSignal, pause: () => Promise<void>): Promise<T | undefined> => {
  while (box.result === undefined && !signal.aborted) await pause().catch(() => undefined)
  return box.result
}

/** Stops live Heads by id; ones with no process behind them are marked failed at once. Returns those. */
async function stopHeadsNow($: EngineInterface, ids: readonly string[], reason: string, limits: HeadLimits) {
  for (const id of ids) controllers.get(id)?.abort(reason)
  const ghosts = ids.filter(id => !controllers.has(id))
  const now = await $.clock.now()
  if (ghosts.length > 0) await update($, runs, current => stopRuns(current, ghosts, `${reason} (no live process)`, now))
  await refreshStatus($, limits)
  return ghosts
}

/** Names handed out in this module's life, so parallel calls never get the same one before their runs are recorded. */
const usedNames = new Set<string>()

export const stopRuns = (list: readonly HeadRun[], ids: readonly string[] | 'all', reason: string, now: number) =>
  list.map(run =>
    (run.state === 'running' || run.state === 'queued') && (ids === 'all' || ids.includes(run.id))
      ? { ...run, state: 'failed' as const, endedAt: now, activity: reason }
      : run,
  )

/** One line per Head for the Lead: id, state, turns, elapsed, what it is doing, the task's start. */
export const listRuns = (list: readonly HeadRun[], now: number, isLiveProcess: (id: string) => boolean) =>
  list.length === 0
    ? 'No Heads in this session.'
    : list
        .map(run => {
          const ghost = (run.state === 'running' || run.state === 'queued') && !isLiveProcess(run.id) ? ' · NO LIVE PROCESS' : ''
          return `${run.id} · ${run.state}${ghost} · ${run.turns}/${run.maxTurns ?? '?'} turns · ${elapsedOf(run, now)} · ${nowLine(run)} · ${run.task.slice(0, 80)}`
        })
        .join('\n')

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

const backgroundJobs = createJobQueue()

/** Prompts a command hands to the session to submit: a command's own `$` may lapse before the session is idle. */
const pendingPrompts = createQueue<string>()
let isWorkerRunning = false

type Round = { finalText: string; sessionId?: string; subtype?: string; code: number | null; signal?: string; errors: string; startedSession?: string }
type RoundArgs = { prompt: string; model: string; effort?: string; maxTurns: number; resume?: string; cwd: string; addDirs: readonly string[] }

/**
 * Spawns a Head's CLI and feeds each stdout line to `onLine` (which returns true to stop the run early). The stream
 * read is raced against `signal`, so a silent child (a model thinking, a hung CLI) cannot hold a stopped Head open.
 */
async function pump(
  $: EngineInterface,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  onLine: (line: string) => Promise<boolean>,
): Promise<{ errors: string; exit: { code: number | null; signal?: string }; isStopped: boolean }> {
  const child = $.process.spawn({ argv: args, cwd })
  let pending = ''
  let errors = ''
  let isStopped = false
  const aborted = new Promise<'aborted'>(resolve => {
    if (signal.aborted) resolve('aborted')
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true })
  })
  for (;;) {
    const step = await Promise.race([child.next(), aborted])
    if (step === 'aborted') {
      void child.return({ code: null, signal: 'aborted' }).catch(() => undefined)
      break
    }
    if (step.done) break
    const { stream, text } = step.value
    if (stream === 'stderr') {
      errors = (errors + text).slice(-2000)
      continue
    }
    const lines = (pending + text).split('\n')
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
  if (!isStopped && !signal.aborted && (await onLine(pending))) isStopped = true
  const exit = signal.aborted ? { code: null, signal: 'aborted' } : isStopped ? { code: null, signal: 'stopped' } : await child.result.catch(() => ({ code: null, signal: 'lost' }))
  return { errors, exit: { code: exit.code ?? null, signal: 'signal' in exit ? String(exit.signal ?? '') : undefined }, isStopped }
}

async function runRound(
  $: EngineInterface,
  argv: RoundArgs,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => Promise<void>,
): Promise<Round> {
  const args = ['/usr/bin/env', 'commandcode', '-p', argv.prompt, '-m', argv.model, '--max-turns', String(argv.maxTurns),
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

/** CodeBuddy tool names as the names Command Code's stream uses, so one live view reads both engines. */
const BUDDY_TOOLS: Record<string, string> = {
  Read: 'read_file', Edit: 'edit_file', MultiEdit: 'edit_file', NotebookEdit: 'edit_file', Write: 'write_file',
  Bash: 'shell_command', Grep: 'grep', Glob: 'glob', LS: 'read_directory',
}

/** How CodeBuddy words a refused call in headless mode, and how Hydra's write guard words its own. */
const BUDDY_DENIAL = /has been denied|requires approval|permission prompts are not available|blocked by|outside the project|write guard/i

/** What a CodeBuddy Head did, accumulated from its stream: the turns it took, files it edited, calls refused, tokens used. */
export type BuddyState = {
  messages: Set<string>
  calls: Map<string, { tool: string; input: Record<string, unknown> }>
  files: Set<string>
  denied: SessionReport['denied']
  inputTokens: number
  outputTokens: number
}

export const newBuddyState = (): BuddyState => ({ messages: new Set(), calls: new Map(), files: new Set(), denied: [], inputTokens: 0, outputTokens: 0 })

type BuddyBlock = { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean; content?: unknown }
export type BuddyRow = {
  type?: string
  subtype?: string
  session_id?: string
  message?: { id?: string; content?: unknown }
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
  result?: string
  [key: string]: unknown
}

const blockText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(part => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '')).join(' ')
      : ''

/**
 * Folds one line of CodeBuddy's `stream-json` into `state` and returns the live-view events it stands for: a new model
 * message is a turn, a `tool_use` block a queued and running call, a `tool_result` a finished or refused one.
 */
export const foldBuddyRow = (row: BuddyRow, state: BuddyState): StreamEvent[] => {
  const events: StreamEvent[] = []
  const content = row.message?.content
  if (!Array.isArray(content)) return events
  if (row.type === 'assistant') {
    const id = row.message?.id
    if (id && !state.messages.has(id)) {
      state.messages.add(id)
      events.push({ type: 'turn_end' })
    }
    for (const block of content as BuddyBlock[]) {
      if (block.type === 'thinking') events.push({ type: 'thinking_start' })
      if (block.type === 'tool_use' && block.id && block.name) {
        const tool = BUDDY_TOOLS[block.name] ?? block.name.toLowerCase()
        const input = block.input ?? {}
        state.calls.set(block.id, { tool, input })
        events.push({ type: 'tool_queued', toolCallId: block.id, toolName: tool, input }, { type: 'tool_running', toolCallId: block.id, toolName: tool })
      }
    }
  } else if (row.type === 'user') {
    for (const block of content as BuddyBlock[]) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue
      const call = state.calls.get(block.tool_use_id)
      const text = blockText(block.content)
      const isDenied = block.is_error === true && BUDDY_DENIAL.test(text)
      const path = call?.input.file_path ?? call?.input.notebook_path
      if (isDenied) {
        state.denied.push({ tool: call?.tool ?? 'tool', target: String(path ?? call?.input.path ?? call?.input.command ?? ''), text: text.replace(/\s+/g, ' ').trim() })
      } else if (!block.is_error && call && EDIT_TOOLS.has(call.tool) && typeof path === 'string') {
        state.files.add(path)
      }
      events.push({ type: isDenied ? 'tool_denied' : 'tool_completed', toolCallId: block.tool_use_id, toolName: call?.tool, isError: block.is_error === true })
    }
  }
  return events
}

/** Shell commands a CodeBuddy Head never runs: Command Code's list in CodeBuddy's rule syntax, plus `.env` as a path. */
export const BUDDY_SHELL_DENY = [
  ...DANGEROUS_SHELL.map(rule => rule.replace(/^Shell\((.*)\)$/, 'Bash($1)')),
  'Bash(* .env*)', 'Bash(*/.env*)', 'Bash(*=.env*)',
]

/** The built-in tools a CodeBuddy Head gets: files and search, and a shell only when its task asked for one. */
export const buddyTools = (shell: boolean) => ['Read', 'Write', 'Edit', 'Glob', 'Grep', ...(shell ? ['Bash'] : [])].join(',')

const trimSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path)

/**
 * The permission settings one CodeBuddy Head runs with, passed with `--settings` (so no file lands in the project):
 * edits are allowed only under the project and the folders it may write to, `.git` and `.env` files are denied
 * everywhere, a folder it may only read is denied for edits, and the write guard checks each write's real path
 * (a symlink in the project cannot lead out of it, which the path rules alone do not stop).
 */
export const buddySettings = (cwd: string, head: HeadNeeds, guard?: string) => {
  const own = [cwd, ...(head.writeDirs ?? [])].map(trimSlash)
  const extra = union(head.addDirs.map(trimSlash), (head.writeDirs ?? []).map(trimSlash))
  const readOnly = extra.filter(dir => !own.some(root => isWithin(dir, root)))
  return {
    permissions: {
      allow: [...own.flatMap(root => [`Edit(${root}/**)`, `Write(${root}/**)`]), ...extra.map(dir => `Read(${dir}/**)`), ...(head.shell ? ['Bash'] : [])],
      deny: [
        ...own.flatMap(root => [
          `Edit(${root}/.git/**)`, `Write(${root}/.git/**)`,
          `Edit(${root}/**/.env)`, `Edit(${root}/**/.env.*)`, `Write(${root}/**/.env)`, `Write(${root}/**/.env.*)`,
          `Read(${root}/**/.env)`, `Read(${root}/**/.env.*)`,
        ]),
        ...readOnly.flatMap(dir => [`Edit(${dir}/**)`, `Write(${dir}/**)`, `Read(${dir}/**/.env)`, `Read(${dir}/**/.env.*)`]),
        ...(head.shell ? BUDDY_SHELL_DENY : []),
      ],
    },
    ...(guard ? { hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command' as const, command: guard, timeout: 10 }] }] } } : {}),
  }
}

/** CodeBuddy's `--effort` levels: Hydra's `off` is its `minimal`. */
export const buddyEffort = (effort: string) => (effort === 'off' ? 'minimal' : effort)

/**
 * The CodeBuddy command line for one round. `default` permission mode plus the settings file means anything the rules
 * do not allow is refused (headless mode cannot ask), so a Head cannot edit outside its folders or use a tool it was not given.
 * The first round names its session; later rounds resume it.
 */
export const buddyArgs = (a: RoundArgs & { settings: string; shell: boolean; sessionId: string }) => {
  const args = ['/usr/bin/env', 'codebuddy', '-p', a.prompt, '--model', a.model, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'default', '--tools', buddyTools(a.shell), '--settings', a.settings, '--setting-sources', 'local',
    '--max-turns', String(a.maxTurns)]
  for (const dir of a.addDirs) args.push('--add-dir', dir)
  if (a.effort) args.push('--effort', buddyEffort(a.effort))
  args.push(...(a.resume ? ['--resume', a.resume] : ['--session-id', a.sessionId]))
  return args
}

/** 91530 and 421 as `91.5k in / 421 out`. */
export const tokensText = (inputTokens: number, outputTokens: number) => {
  const short = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  return `${short(inputTokens)} in / ${short(outputTokens)} out`
}

/** A session id for a Head's first CodeBuddy round; later rounds resume it. */
const buddySessionId = (id: string, now: number) => `hydra-${id}-${now.toString(36)}`

async function runRoundBuddy(
  $: EngineInterface,
  argv: RoundArgs & { settings: string; shell: boolean; sessionId: string; state: BuddyState },
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => Promise<void>,
): Promise<Round> {
  let result: BuddyRow | null = null
  let started: string | undefined
  let isCapped = false
  const turnsBefore = argv.state.messages.size
  const { errors, exit } = await pump($, buddyArgs(argv), argv.cwd, signal, async line => {
    if (!line.trim().startsWith('{')) return false
    let row: BuddyRow
    try {
      row = JSON.parse(line) as BuddyRow
    } catch {
      return false // A partial or non-JSON line; the result line is what counts.
    }
    if (row.type === 'system' && row.subtype === 'init' && typeof row.session_id === 'string') started = row.session_id
    if (row.type === 'result') {
      result = row
      argv.state.inputTokens += (row.usage?.input_tokens ?? 0) + (row.usage?.cache_creation_input_tokens ?? 0) + (row.usage?.cache_read_input_tokens ?? 0)
      argv.state.outputTokens += row.usage?.output_tokens ?? 0
    }
    for (const event of foldBuddyRow(row, argv.state)) await onEvent(event)
    // CodeBuddy's own --max-turns is loose (a Head ran 13 turns under a cap of 2), so Hydra counts model messages itself.
    if (argv.state.messages.size - turnsBefore > argv.maxTurns) isCapped = true
    return isCapped
  })
  const final = result as BuddyRow | null
  return {
    finalText: String(final?.result ?? ''),
    sessionId: typeof final?.session_id === 'string' ? final.session_id : undefined,
    subtype: isCapped ? 'error_max_turns' : typeof final?.subtype === 'string' ? final.subtype : undefined,
    code: isCapped ? 8 : exit.code,
    signal: exit.signal,
    errors,
    startedSession: started,
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

const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [])

export const relativeTo = (cwd: string, path: string) => {
  const root = cwd.replace(/\/$/, '') + '/'
  return path.startsWith(root) ? path.slice(root.length) : path
}

/** Files written outside the project and outside every folder the Head was let write to. */
export const outsideFiles = (cwd: string, files: readonly string[], writeDirs: readonly string[] = []) =>
  files.filter(file => file.startsWith('/') && ![cwd, ...writeDirs].some(root => isWithin(file, root)))

export const formatReport = (head: {
  id: string; model: string; effort?: string; cwd: string; sessionId?: string; finished: boolean; rounds: number; turns: number;
  usd: number | null; files: string[]; denied: SessionReport['denied']; finalText: string; exit: string; rulesNote?: string; errors?: string
  writeDirs?: readonly string[]; engine?: Engine; tokens?: string
}) => {
  const lines = [
    `head ${head.id} · ${head.model}${head.effort ? ` · effort ${head.effort}` : ''} · ${head.finished ? 'finished' : 'NOT finished'} · exit ${head.exit} · ${head.rounds} round(s) · ${head.turns} turns · ${head.tokens ?? `$${(head.usd ?? 0).toFixed(4)}`}`,
    `session ${head.sessionId ?? 'none'} (${ENGINE_BIN[head.engine ?? DEFAULT_ENGINE]} --resume ${head.sessionId ?? '<id>'}) · cwd ${head.cwd}`,
  ]
  if (head.rulesNote) lines.push(`rules: ${head.rulesNote}`)
  if (head.writeDirs && head.writeDirs.length > 0) lines.push(`may also write: ${head.writeDirs.join(', ')}`)
  const outside = outsideFiles(head.cwd, head.files, head.writeDirs)
  if (outside.length > 0) lines.push(`⚠ WROTE OUTSIDE THE PROJECT (${outside.length}): ${outside.join(', ')}`)
  lines.push(head.files.length > 0 ? `edited (${head.files.length}): ${head.files.map(file => relativeTo(head.cwd, file)).join(', ')}` : 'edited: nothing')
  if (head.denied.length > 0) {
    lines.push(`denied (${head.denied.length}):`, ...head.denied.map(d => `  - ${d.tool} ${relativeTo(head.cwd, d.target)}: ${d.text.slice(0, 140)}`))
  }
  lines.push('--- head report ---', (head.finalText || '(no final report)').trim().slice(-8000))
  if (!head.finished && head.errors?.trim()) lines.push('--- stderr ---', head.errors.trim())
  return lines.join('\n')
}

async function runHead($: EngineInterface, input: Record<string, unknown>, headModel: string, signal: AbortSignal, limits: HeadLimits, id: string, engine: Engine = DEFAULT_ENGINE) {
  const task = String(input.task ?? '').trim()
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : await $.session.root()
  const model = engine === 'agy' ? AGY_MODEL : modelFor(engine, typeof input.model === 'string' && input.model ? input.model : headModel)
  // Codex and Antigravity number no model messages, so their turns are tool calls: a Head needs more of them for the same work.
  const maxTurns = Number(input.maxTurns ?? (engine === 'codex' || engine === 'agy' ? 150 : 60))
  const addDirs = strings(input.addDirs)
  const writeDirs = strings(input.writeDirs)
  const shell = input.shell === true || strings(input.allowShell).length > 0
  const minutes = Number(input.maxMinutes ?? DEFAULT_MINUTES)
  const effort = isHeadEffort(input.effort) ? input.effort : undefined

  const queued: HeadRun = { id, task: task.slice(0, 200), model, state: 'queued', turns: 0, maxTurns, activity: 'waiting for a slot', cwd, engine }
  await update($, runs, list => [...list, queued].slice(-RUN_HISTORY))
  await refreshStatus($, limits)
  await gate.enter()
  if (signal.aborted) {
    gate.leave()
    await setRun($, id, { state: 'failed', endedAt: await $.clock.now(), activity: stopReason(signal) })
    await refreshStatus($, limits)
    return {
      text: formatReport({ id, model, cwd, finished: false, rounds: 0, turns: 0, usd: 0, files: [], denied: [], finalText: '', exit: stopReason(signal), engine }),
      isDone: false,
    }
  }
  const startedAt = await $.clock.now()
  await setRun($, id, { state: 'running', startedAt, activity: 'starting' })
  await update($, tick, () => startedAt)
  try {
    return await runHeadInside($, { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort, engine }, signal, limits, id)
  } finally {
    gate.leave()
  }
}

async function runHeadInside(
  $: EngineInterface,
  head: { task: string; cwd: string; model: string; maxTurns: number; addDirs: string[]; writeDirs: string[]; shell: boolean; minutes: number; effort?: string; engine: Engine },
  outer: AbortSignal,
  limits: HeadLimits,
  id: string,
) {
  const { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort, engine } = head
  if (engine === 'agy') return runAgyHead($, { task, cwd, model, maxTurns, addDirs, writeDirs, shell, minutes, effort }, outer, limits, id)
  if (engine === 'codex') return runCodexHead($, { task, cwd, model, maxTurns, addDirs: union(addDirs, writeDirs), writeDirs, minutes, effort }, outer, limits, id)
  if (engine === 'codebuddy') return runBuddyHead($, { task, cwd, model, maxTurns, addDirs: union(addDirs, writeDirs), writeDirs, shell, minutes, effort }, outer, limits, id)
  const refusal = await joinProject($, cwd, id, { addDirs, writeDirs, shell }, minutes)
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
  const effortNow = async () => headEffort(effortModeOf(await read($, mode)), head.effort)
  const controller = new AbortController()
  outer.addEventListener('abort', () => controller.abort(), { once: true })
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
  const finished = isFinished(round.finalText)
  const isDone = round.code === 0 && round.subtype === 'success' && finished
  const stopped = outer.aborted ? stopReason(outer) : undefined
  await setRun($, id, {
    state: isDone ? 'done' : 'failed', turns, costUsd: report.usd ?? undefined, endedAt: await $.clock.now(),
    files: report.files.map(file => relativeTo(cwd, file)), summary: summaryOf(round.finalText),
    activity: isDone ? undefined : timedOut ? `timed out after ${minutes} min` : stopped ?? 'stopped before HEAD DONE',
  })
  void refreshHeads($, limits)

  const text = formatReport({
    id, model, effort: round.effort, cwd, sessionId, finished, rounds, turns, usd: report.usd, files: report.files, denied: report.denied,
    finalText: round.finalText, exit: timedOut ? `timed out after ${minutes} min` : stopped ?? String(round.code ?? round.signal), errors: round.errors,
    rulesNote, writeDirs: head.writeDirs,
  })
  return { text, isDone }
}

type BuddyHead = { task: string; cwd: string; model: string; maxTurns: number; addDirs: string[]; writeDirs: string[]; shell: boolean; minutes: number; effort?: string }

const BUDDY_SETTINGS_DIR = '.claude/hydra/heads'

/** Writes this Head's permission settings next to Hydra's status files, not in the project. Returns the file's path. */
async function writeBuddySettings($: EngineInterface, cwd: string, id: string, needs: HeadNeeds): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  const dir = `${home}/${BUDDY_SETTINGS_DIR}`
  await $.process.run(['/bin/mkdir', '-p', dir])
  const path = `${dir}/${await $.session.id()}-${id}.json`
  const settings = buddySettings(cwd, needs, guardCommand($.plugin.root, cwd, needs.writeDirs ?? []))
  await $.fs.write(path, JSON.stringify(settings, null, 2) + '\n')
  return path
}

/** Settings files a crashed session left behind: a Head never runs for a day. */
async function sweepBuddySettings($: EngineInterface) {
  const home = await $.env.get('HOME')
  if (!home) return
  const folder = `${home}/${BUDDY_SETTINGS_DIR}`
  const now = await $.clock.now()
  const entries = await $.fs.list(folder).catch(() => [])
  const old = entries.filter(entry => entry.kind === 'file' && entry.name.endsWith('.json') && now - entry.mtimeMs > 86_400_000)
  if (old.length > 0) await $.process.run(['/bin/rm', '-f', ...old.map(entry => `${folder}/${entry.name}`)]).catch(() => undefined)
}

const notStarted = (id: string, model: string, cwd: string, reason: string, engine: Engine = 'codebuddy') => ({
  text: formatReport({
    id, model, cwd, finished: false, rounds: 0, turns: 0, usd: 0, files: [], denied: [], finalText: '',
    exit: 'not started', rulesNote: reason, engine,
  }),
  isDone: false,
})

/** A Head on CodeBuddy: its own permission settings (no shared rules file), then rounds until it reports HEAD DONE. */
async function runBuddyHead($: EngineInterface, head: BuddyHead, outer: AbortSignal, limits: HeadLimits, id: string) {
  const { cwd, model } = head
  const unsupported = /^[A-Za-z]:|^\\\\|\\/.test(cwd) ? `${cwd} is a Windows path, and Hydra's rules use POSIX paths. Run Claude Code under WSL instead.` : undefined
  let settings = ''
  const refusal =
    unsupported ??
    (await writeBuddySettings($, cwd, id, { addDirs: head.addDirs, writeDirs: head.writeDirs, shell: head.shell }).then(
      path => {
        settings = path
        return undefined
      },
      error => `Hydra could not write the Head's permission settings (${String(error).slice(0, 160)}). Check that ~/.claude is writable, then run the Head again.`,
    ))
  if (refusal) {
    await setRun($, id, { state: 'failed', endedAt: await $.clock.now(), activity: refusal })
    await refreshStatus($, limits)
    return notStarted(id, model, cwd, `${refusal} A Head never starts without Hydra's rules.`)
  }
  try {
    return await runBuddyRounds($, head, settings, outer, limits, id)
  } finally {
    await $.process.run(['/bin/rm', '-f', settings]).catch(() => undefined)
  }
}

async function runBuddyRounds($: EngineInterface, head: BuddyHead, settings: string, outer: AbortSignal, limits: HeadLimits, id: string) {
  const { task, cwd, model, maxTurns, addDirs, shell, minutes } = head
  // Read each round, so a /hydra effort change reaches a running Head at its next round.
  const effortNow = async () => headEffort(effortModeOf(await read($, mode)), head.effort)
  const controller = new AbortController()
  outer.addEventListener('abort', () => controller.abort(), { once: true })
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
  const state = newBuddyState()
  const labels = new Map<string, string>()
  const onEvent = async (event: StreamEvent) => {
    if (event.type === 'turn_end') turns++
    await setRun($, id, run => applyEvent(run, event, labels, cwd))
  }
  const roundAt = async (round: { prompt: string; maxTurns: number; resume?: string }) => {
    const effort = await effortNow()
    await setRun($, id, { effort })
    const ran = await runRoundBuddy($, { ...round, model, effort, cwd, addDirs, settings, shell, sessionId: buddySessionId(id, await $.clock.now()), state }, signal, onEvent)
    return { ...ran, effort }
  }

  let round = await roundAt({ prompt: task + HEAD_RULES, maxTurns })
  for (let attempt = 1; !round.sessionId && !signal.aborted && attempt <= START_RETRIES; attempt++) {
    await $.clock.sleep(attempt * 5_000, { signal }).catch(() => undefined)
    round = await roundAt({ prompt: task + HEAD_RULES, maxTurns })
  }
  const sessionId = round.sessionId ?? round.startedSession
  let rounds = 1
  while (!signal.aborted && sessionId && isResumable(round.code) && !isFinished(round.finalText) && rounds < MAX_ROUNDS && turns < maxTurns) {
    const denied = state.denied.map(d => `${d.tool} ${relativeTo(cwd, d.target)}`)
    await setRun($, id, { activity: `resuming (round ${rounds + 1})` })
    round = await roundAt({ prompt: continuePrompt(denied), maxTurns: maxTurns - turns, resume: sessionId })
    rounds++
  }

  timerStop.abort()
  const files = [...state.files]
  const tokens = tokensText(state.inputTokens, state.outputTokens)
  const finished = isFinished(round.finalText)
  const isDone = round.code === 0 && round.subtype === 'success' && finished
  const stopped = outer.aborted ? stopReason(outer) : undefined
  await setRun($, id, {
    state: isDone ? 'done' : 'failed', turns, tokens, endedAt: await $.clock.now(),
    files: files.map(file => relativeTo(cwd, file)), summary: summaryOf(round.finalText),
    activity: isDone ? undefined : timedOut ? `timed out after ${minutes} min` : stopped ?? (round.subtype === 'error_max_turns' ? `stopped at the ${maxTurns}-turn cap` : 'stopped before HEAD DONE'),
  })
  void refreshHeads($, limits)

  const text = formatReport({
    id, model, effort: round.effort, cwd, sessionId, finished, rounds, turns, usd: null, files, denied: state.denied,
    finalText: round.finalText, exit: timedOut ? `timed out after ${minutes} min` : stopped ?? String(round.code ?? round.signal), errors: round.errors,
    writeDirs: head.writeDirs, engine: 'codebuddy', tokens,
  })
  return { text, isDone }
}

/** Codex item types as the tool names Command Code's stream uses, so one live view reads every engine. */
const CODEX_TOOLS: Record<string, string> = { command_execution: 'shell_command', file_change: 'edit_file', web_search: 'web_search' }

/** How a command fails when Codex's sandbox refuses it: the kernel's wording for a blocked read or write. */
const CODEX_DENIAL = /permission denied|read-only file system|operation not permitted|EACCES|EROFS|blocked by/i

type CodexItem = {
  id?: string; type?: string; text?: string; command?: string; exit_code?: number | null; status?: string
  aggregated_output?: string; changes?: { path?: string; kind?: string }[]; server?: string; tool?: string; query?: string
}
export type CodexRow = {
  type?: string
  thread_id?: string
  item?: CodexItem
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { message?: string }
  message?: string
}

/** What a Codex Head did, accumulated from its stream: tool calls (its turns), files named in patches, refused commands, tokens. */
export type CodexState = {
  calls: Map<string, { tool: string; input: Record<string, unknown> }>
  files: Set<string>
  denied: SessionReport['denied']
  turns: number
  inputTokens: number
  outputTokens: number
  finalText: string
  threadId?: string
  failure?: string
  isCompleted: boolean
}

export const newCodexState = (): CodexState => ({ calls: new Map(), files: new Set(), denied: [], turns: 0, inputTokens: 0, outputTokens: 0, finalText: '', isCompleted: false })

const codexToolOf = (item: CodexItem) =>
  item.type === 'mcp_tool_call' ? `${item.server ?? 'mcp'}.${item.tool ?? 'tool'}` : CODEX_TOOLS[item.type ?? '']

/**
 * Folds one line of `codex exec --json` into `state` and returns the live-view events it stands for. Codex does not number
 * model messages, so a turn is one finished tool call (a command, a patch, an MCP or search call).
 */
export const foldCodexRow = (row: CodexRow, state: CodexState): StreamEvent[] => {
  const events: StreamEvent[] = []
  if (row.type === 'thread.started' && typeof row.thread_id === 'string') state.threadId = row.thread_id
  else if (row.type === 'turn.completed') {
    state.isCompleted = true
    state.inputTokens += row.usage?.input_tokens ?? 0
    state.outputTokens += row.usage?.output_tokens ?? 0
  } else if (row.type === 'turn.failed' || row.type === 'error') {
    state.failure = row.error?.message ?? row.message ?? 'Codex reported an error'
  } else if ((row.type === 'item.started' || row.type === 'item.completed') && row.item) {
    const item = row.item
    const isDone = row.type === 'item.completed'
    if (item.type === 'reasoning') events.push({ type: 'thinking_start' })
    else if (item.type === 'agent_message' && isDone && typeof item.text === 'string') state.finalText = item.text
    else {
      const tool = codexToolOf(item)
      const id = item.id
      if (tool && id) {
        if (!state.calls.has(id)) {
          const input: Record<string, unknown> = item.type === 'command_execution' ? { command: item.command ?? '' }
            : item.type === 'file_change' ? { file_path: item.changes?.[0]?.path ?? '' }
            : item.type === 'web_search' ? { pattern: item.query ?? '' } : {}
          state.calls.set(id, { tool, input })
          events.push({ type: 'tool_queued', toolCallId: id, toolName: tool, input }, { type: 'tool_running', toolCallId: id, toolName: tool })
        }
        if (isDone) {
          const call = state.calls.get(id)!
          const output = item.aggregated_output ?? ''
          const isError = item.type === 'command_execution' ? item.exit_code !== 0 && item.exit_code !== null && item.exit_code !== undefined : item.status === 'failed'
          const isDenied = isError && item.type === 'command_execution' && CODEX_DENIAL.test(output)
          if (isDenied) state.denied.push({ tool: call.tool, target: String(item.command ?? ''), text: output.replace(/\s+/g, ' ').trim() })
          else if (!isError && item.type === 'file_change') for (const change of item.changes ?? []) if (change.path) state.files.add(change.path)
          events.push({ type: isDenied ? 'tool_denied' : 'tool_completed', toolCallId: id, toolName: call.tool, isError }, { type: 'turn_end' })
          state.turns++
        }
      }
    }
  }
  return events
}

/** Codex takes low to max; Hydra's `off` is its `low`. */
export const codexEffort = (effort: string) => (effort === 'off' ? 'low' : effort)

/** Secrets folders under the person's home that a Codex Head must not read. */
export const CODEX_SECRET_DIRS = ['.ssh', '.aws', '.gnupg', '.codex', '.claude', '.config/gcloud', '.netrc', '.npmrc', '.git-credentials']

const tomlString = (value: string) => JSON.stringify(value)

/**
 * The filesystem profile one Codex Head runs under, as the inline TOML table for `-c permissions.hydra.filesystem=…`:
 * the whole disk readable, the project and each writeDir writable (Codex keeps `.git` read-only inside them), `.env`
 * files unreadable under every folder the Head may touch, and the person's credential folders unreadable. Everything
 * else, `/tmp` and sibling folders included, is read-only; the shell has no network.
 */
export const codexFilesystem = (cwd: string, head: HeadNeeds, home = '') => {
  const writable = [cwd, ...(head.writeDirs ?? [])].map(trimSlash)
  const roots = union(writable, head.addDirs.map(trimSlash))
  const entries: [string, string][] = [
    ['/', 'read'],
    ...writable.map((dir): [string, string] => [dir, 'write']),
    ...roots.flatMap((dir): [string, string][] => [[`${dir}/**/.env`, 'none'], [`${dir}/**/.env.*`, 'none']]),
    ...(home ? CODEX_SECRET_DIRS.map((dir): [string, string] => [`${home.replace(/\/$/, '')}/${dir}`, 'none']) : []),
  ]
  return `{${entries.map(([path, access]) => `${tomlString(path)}=${tomlString(access)}`).join(',')},glob_scan_max_depth=6}`
}

/**
 * The Codex command line for one round. The shell wrapper closes stdin (otherwise `codex exec` waits for more prompt text),
 * `--ignore-user-config` keeps the person's own Codex settings out of a Head, and `approval_policy="never"` means a refused
 * command simply fails. The first round starts a thread; later rounds `resume` it under the same profile.
 */
export const codexArgs = (a: RoundArgs & { filesystem: string }) => {
  const args = ['/bin/sh', '-c', 'exec "$@" </dev/null', 'sh', '/usr/bin/env', 'codex', 'exec', ...(a.resume ? ['resume'] : []),
    '--json', '-m', a.model, '--skip-git-repo-check', '--ignore-user-config',
    '-c', 'default_permissions="hydra"', '-c', `permissions.hydra.filesystem=${a.filesystem}`, '-c', 'approval_policy="never"']
  if (a.effort) args.push('-c', `model_reasoning_effort=${tomlString(codexEffort(a.effort))}`)
  args.push('--', ...(a.resume ? [a.resume] : []), a.prompt)
  return args
}

async function runRoundCodex(
  $: EngineInterface,
  argv: RoundArgs & { filesystem: string; state: CodexState },
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => Promise<void>,
): Promise<Round> {
  const { state } = argv
  state.finalText = ''
  state.failure = undefined
  state.isCompleted = false
  const turnsBefore = state.turns
  let isCapped = false
  const { errors, exit } = await pump($, codexArgs(argv), argv.cwd, signal, async line => {
    if (!line.trim().startsWith('{')) return false
    let row: CodexRow
    try {
      row = JSON.parse(line) as CodexRow
    } catch {
      return false // A partial or non-JSON line; the thread and turn rows are what count.
    }
    for (const event of foldCodexRow(row, state)) await onEvent(event)
    if (state.turns - turnsBefore > argv.maxTurns) isCapped = true
    return isCapped
  })
  return {
    finalText: state.finalText,
    sessionId: state.threadId,
    subtype: state.failure ? 'error' : isCapped ? 'error_max_turns' : state.isCompleted ? 'success' : undefined,
    code: isCapped ? 8 : exit.code,
    signal: exit.signal,
    errors: [state.failure, errors].filter(Boolean).join('\n').slice(-2000),
  }
}

type CodexHead = { task: string; cwd: string; model: string; maxTurns: number; addDirs: string[]; writeDirs: string[]; minutes: number; effort?: string }

/** The real path of each folder, so the profile's rules match what the sandbox sees through a symlink. */
async function realPaths($: EngineInterface, paths: readonly string[]): Promise<string[]> {
  return Promise.all(paths.map(path => $.process.run(['/usr/bin/env', 'realpath', '--', path], { timeoutMs: 5_000 }).then(ran => (ran.exitCode === 0 && ran.stdout.trim() ? ran.stdout.trim() : path), () => path)))
}

/** Files under `dirs` written since `since` (ms), by the file system's own account: Codex's stream misses what a shell command writes. */
async function changedFiles($: EngineInterface, since: number, dirs: readonly string[]): Promise<string[]> {
  try {
    const ran = await $.process.run(['/usr/bin/env', 'python3', '-I', `${$.plugin.root}/bin/changed-files.py`, String(since - 2_000), ...dirs], { timeoutMs: 30_000 })
    return JSON.parse(ran.stdout) as string[]
  } catch {
    return []
  }
}

/** Empty folders Codex's sandbox leaves in a writable root as mount points for the paths it protects. */
const CODEX_MOUNT_POINTS = ['.agents', '.aws', '.codex']

/** The mount-point folders that do not exist yet in each root: after the Head, the empty ones among them are removed. */
async function missingMountPoints($: EngineInterface, roots: readonly string[]): Promise<string[]> {
  const missing: string[] = []
  for (const root of roots) {
    for (const name of CODEX_MOUNT_POINTS) {
      const path = `${trimSlash(root)}/${name}`
      if (!(await $.fs.exists(path).catch(() => true))) missing.push(path)
    }
  }
  return missing
}

/** A Head on Codex: a filesystem profile on the command line (no file to clean up), then rounds until it reports HEAD DONE. */
async function runCodexHead($: EngineInterface, head: CodexHead, outer: AbortSignal, limits: HeadLimits, id: string) {
  const { cwd, model } = head
  if (/^[A-Za-z]:|^\\\\|\\/.test(cwd)) {
    const refusal = `${cwd} is a Windows path, and Hydra's rules use POSIX paths. Run Claude Code under WSL instead.`
    await setRun($, id, { state: 'failed', endedAt: await $.clock.now(), activity: refusal })
    await refreshStatus($, limits)
    return notStarted(id, model, cwd, `${refusal} A Head never starts without Hydra's rules.`, 'codex')
  }
  const [realCwd] = await realPaths($, [cwd])
  const writeDirs = await realPaths($, head.writeDirs)
  const filesystem = codexFilesystem(realCwd!, { addDirs: await realPaths($, head.addDirs), writeDirs, shell: true }, (await $.env.get('HOME')) ?? '')
  return runCodexRounds($, head, filesystem, outer, limits, id)
}

async function runCodexRounds($: EngineInterface, head: CodexHead, filesystem: string, outer: AbortSignal, limits: HeadLimits, id: string) {
  const { task, cwd, model, maxTurns, minutes } = head
  // Read each round, so a /hydra effort change reaches a running Head at its next round.
  const effortNow = async () => headEffort(effortModeOf(await read($, mode)), head.effort)
  const controller = new AbortController()
  outer.addEventListener('abort', () => controller.abort(), { once: true })
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
  const mountPoints = await missingMountPoints($, [cwd, ...head.writeDirs])
  const state = newCodexState()
  const labels = new Map<string, string>()
  const onEvent = async (event: StreamEvent) => {
    await setRun($, id, run => applyEvent(run, event, labels, cwd))
  }
  const roundAt = async (round: { prompt: string; maxTurns: number; resume?: string }) => {
    const effort = await effortNow()
    await setRun($, id, { effort })
    const ran = await runRoundCodex($, { ...round, model, effort, cwd, addDirs: head.addDirs, filesystem, state }, signal, onEvent)
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
  // `rmdir` only removes an empty folder, so one the Head filled (or another Head is using) stays.
  if (mountPoints.length > 0) await $.process.run(['/bin/rmdir', ...mountPoints]).catch(() => undefined)
  const files = union([...state.files], await changedFiles($, startedAt, [cwd, ...head.writeDirs]))
  const tokens = tokensText(state.inputTokens, state.outputTokens)
  const finished = isFinished(round.finalText)
  const isDone = round.code === 0 && round.subtype === 'success' && finished
  const stopped = outer.aborted ? stopReason(outer) : undefined
  await setRun($, id, {
    state: isDone ? 'done' : 'failed', turns: state.turns, tokens, endedAt: await $.clock.now(),
    files: files.map(file => relativeTo(cwd, file)), summary: summaryOf(round.finalText),
    activity: isDone ? undefined : timedOut ? `timed out after ${minutes} min` : stopped ?? (round.subtype === 'error_max_turns' ? `stopped at the ${maxTurns}-turn cap` : 'stopped before HEAD DONE'),
  })
  void refreshHeads($, limits)

  const text = formatReport({
    id, model, effort: round.effort, cwd, sessionId, finished, rounds, turns: state.turns, usd: null, files, denied: state.denied,
    finalText: round.finalText, exit: timedOut ? `timed out after ${minutes} min` : stopped ?? String(round.code ?? round.signal), errors: round.errors,
    writeDirs: head.writeDirs, engine: 'codex', tokens,
  })
  return { text, isDone }
}

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

/** Gemini 3.8 Flash takes low, medium and high; Hydra's `off` is `low`, `xhigh` and `max` are `high`. */
export const agyEffort = (effort: string) => (effort === 'off' ? 'low' : effort === 'xhigh' || effort === 'max' ? 'high' : effort)

/** Credential folders under the person's home that an Antigravity Head must not read (its own, with the sign-in token, included). */
export const AGY_SECRET_DIRS = [...CODEX_SECRET_DIRS, '.gemini']

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

export const agySettings = (cwd: string, head: HeadNeeds, home = '', envFiles: readonly string[] = [], tempDirs: readonly string[] = []) => {
  const own = [cwd, ...(head.writeDirs ?? [])].map(trimSlash)
  const extra = union(head.addDirs.map(trimSlash), (head.writeDirs ?? []).map(trimSlash))
  return {
    permissions: {
      allow: [...own.map(root => `write_file(${root}/)`), ...extra.map(dir => `read_file(${dir}/)`), ...(head.shell ? ['command(*)'] : [])],
      deny: [
        ...own.map(root => `write_file(${root}/.git/)`),
        ...tempDirs.map(dir => `write_file(${dir}/)`),
        ...envFiles.map(file => `read_file(${file})`),
        ...(home ? AGY_SECRET_DIRS.map(dir => `read_file(${home.replace(/\/$/, '')}/${dir})`) : []),
        ...(head.shell ? AGY_SHELL_DENY : []),
      ],
    },
  }
}

/**
 * The Antigravity command line for one round. The shell wrapper closes stdin, `HOME` points at the Head's own settings folder
 * (there is no flag for settings), and `--sandbox` is what keeps a shell inside the project. Later rounds `--conversation` the first.
 */
export const agyArgs = (a: RoundArgs & { home: string }) => {
  const args = ['/bin/sh', '-c', 'exec "$@" </dev/null', 'sh', '/usr/bin/env', `HOME=${a.home}`, 'agy', '-p', a.prompt,
    '--model', AGY_MODEL, '--sandbox', '--output-format', 'stream-json']
  if (a.effort) args.push('--effort', agyEffort(a.effort))
  // No --add-dir: it turns the project read-only in the sandbox. The permission rules already open the folders the Head may use.
  if (a.resume) args.push('--conversation', a.resume)
  return args
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
  })
  return {
    finalText: state.finalText,
    sessionId: state.conversationId,
    subtype: isCapped ? 'error_max_turns' : state.status === 'SUCCESS' ? 'success' : state.status ? 'error' : undefined,
    code: isCapped ? 8 : exit.code,
    signal: exit.signal,
    errors,
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
 * Makes this Head's `HOME`: its own `settings.json` (the permission rules) and a copy of the sign-in token, under Hydra's folder
 * in `~/.claude`, owner-only. Removed when the Head ends. Returns the folder.
 */
async function writeAgyHome($: EngineInterface, cwd: string, id: string, needs: HeadNeeds): Promise<string> {
  const real = (await $.env.get('HOME')) ?? ''
  const dir = `${real}/${AGY_HOME_DIR}/agy-${await $.session.id()}-${id}`
  const config = `${dir}/.gemini/antigravity-cli`
  await $.process.run(['/bin/mkdir', '-p', config])
  await $.process.run(['/bin/chmod', '700', dir, `${dir}/.gemini`, config])
  await $.process.run(['/bin/cp', '-p', `${real}/${AGY_TOKEN}`, `${config}/antigravity-oauth-token`])
  await writeAgySettings($, dir, cwd, needs)
  return dir
}

/** (Re)writes the Head's rules, looking again for `.env` files: a rule names a file, so each round covers the ones made since the last. */
async function writeAgySettings($: EngineInterface, dir: string, cwd: string, needs: HeadNeeds) {
  const real = (await $.env.get('HOME')) ?? ''
  const roots = [cwd, ...(needs.writeDirs ?? [])]
  const envFiles = await findEnvFiles($, union(roots, needs.addDirs))
  const present: string[] = []
  for (const temp of AGY_TEMP_DIRS) if (await $.fs.exists(temp).catch(() => false)) present.push(temp)
  await $.fs.write(`${dir}/.gemini/antigravity-cli/settings.json`, JSON.stringify(agySettings(cwd, needs, real, envFiles, agyTempDeny(roots, present)), null, 2) + '\n')
}

/** Removes a Head's `HOME` folder; refuses any path that is not one of Hydra's own. */
async function removeAgyHome($: EngineInterface, dir: string) {
  if (dir.includes(`/${AGY_HOME_DIR}/agy-`)) await $.process.run(['/bin/rm', '-rf', dir]).catch(() => undefined)
}

/** Head folders a crashed session left behind: a Head never runs for a day. */
async function sweepAgyHomes($: EngineInterface) {
  const home = await $.env.get('HOME')
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

type AgyHead = { task: string; cwd: string; model: string; maxTurns: number; addDirs: string[]; writeDirs: string[]; shell: boolean; minutes: number; effort?: string }

/** A Head on Antigravity: its own HOME with permission rules, then rounds until it reports HEAD DONE. */
async function runAgyHead($: EngineInterface, head: AgyHead, outer: AbortSignal, limits: HeadLimits, id: string) {
  const { cwd, model } = head
  let home = ''
  const refusal =
    /^[A-Za-z]:|^\\\\|\\/.test(cwd)
      ? `${cwd} is a Windows path, and Hydra's rules use POSIX paths. Run Claude Code under WSL instead.`
      : await writeAgyHome($, cwd, id, { addDirs: head.addDirs, writeDirs: head.writeDirs, shell: head.shell }).then(
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
  const effortNow = async () => headEffort(effortModeOf(await read($, mode)), head.effort)
  const controller = new AbortController()
  outer.addEventListener('abort', () => controller.abort(), { once: true })
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
  const state = newAgyState()
  const labels = new Map<string, string>()
  const onEvent = async (event: StreamEvent) => {
    await setRun($, id, run => applyEvent(run, event, labels, cwd))
  }
  const roundAt = async (round: { prompt: string; maxTurns: number; resume?: string }) => {
    const effort = await effortNow()
    await setRun($, id, { effort })
    await writeAgySettings($, home, cwd, { addDirs, writeDirs: head.writeDirs, shell: head.shell }).catch(() => undefined)
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
  const tokens = tokensText(state.inputTokens, state.outputTokens)
  const finished = isFinished(round.finalText)
  const isDone = round.code === 0 && round.subtype === 'success' && finished
  const stopped = outer.aborted ? stopReason(outer) : undefined
  await setRun($, id, {
    state: isDone ? 'done' : 'failed', turns: state.turns, tokens, endedAt: await $.clock.now(),
    files: files.map(file => relativeTo(cwd, file)), summary: summaryOf(round.finalText),
    activity: isDone ? undefined : timedOut ? `timed out after ${minutes} min` : stopped ?? (round.subtype === 'error_max_turns' ? `stopped at the ${maxTurns}-turn cap` : 'stopped before HEAD DONE'),
  })
  void refreshHeads($, limits)

  const text = formatReport({
    id, model, effort: round.effort, cwd, sessionId, finished, rounds, turns: state.turns, usd: null, files, denied: state.denied,
    finalText: round.finalText, exit: timedOut ? `timed out after ${minutes} min` : stopped ?? String(round.code ?? round.signal), errors: round.errors,
    writeDirs: head.writeDirs, engine: 'agy', tokens,
  })
  return { text, isDone }
}

export const register: Register = (on, options) => {
  const fiveHourUsd = Number(options.headsFiveHourUsd ?? 0) || 0
  const weeklyUsd = Number(options.headsWeeklyUsd ?? 0) || 0
  const plan = String(options.headsPlan ?? '')
  const defaultHead = String(options.headModel ?? 'deepseek/deepseek-v4.1-flash')
  const defaultEffort: EffortMode = isEffortMode(options.headEffort) ? options.headEffort : 'auto'
  const defaultEngine: Engine = isEngine(options.headEngine) ? options.headEngine : DEFAULT_ENGINE
  const limits = { fiveHourUsd, weeklyUsd }

  on('session.start', async ($, e, next) => {
    if (!isWorkerRunning) {
      isWorkerRunning = true
      void (async () => {
        for (;;) {
          const text = await pendingPrompts.next()
          await $.prompt.submit({ text, asUser: true }).catch(() => undefined)
        }
      })()
      void (async () => {
        for (;;) {
          const job = await backgroundJobs.next()
          const controller = new AbortController()
          controllers.set(job.id, controller)
          void runHead($, job.input, job.headModel, controller.signal, limits, job.id, job.engine)
            .catch(async error => {
              const reason = `failed before it reported: ${String(error).slice(0, 300)}`
              const now = await $.clock.now()
              await update($, runs, list => stopRuns(list, [job.id], reason, now))
              await refreshStatus($, limits)
              return { text: `Hydra Head ${job.id} ${reason}`, isDone: false }
            })
            .then(async result => {
              if (!job.reply?.(result)) await $.prompt.submit({ text: `Hydra Head ${job.id} finished.\n${result.text}` })
            })
            .finally(() => controllers.delete(job.id))
        }
      })()
    }
    await $.command.register({ name: USAGE_COMMAND, description: 'Hydra: Claude and Head usage limits', immediate: true })
    await $.command.register({ name: 'heads', description: 'Hydra: watch the Heads work, live (opens without interrupting Claude)', immediate: true })
    await $.command.register({
      name: 'hydra',
      description: 'Turn on Hydra: Claude leads, Heads (Command Code, CodeBuddy, Codex or Antigravity agents) implement',
      argumentHint: '[task] [effort=<level>] [head=<model>] [engine=<name>] | off | status | help',
    })
    await $.tool.register({
      name: 'head',
      description: 'Hydra: run one Head (a cheaper coding agent on Command Code, CodeBuddy, Codex or Antigravity, per the person\'s engine setting) headlessly on a self-contained implementation task. Returns its report, cost, the files it edited and any denied calls; with background: true it returns at once and the report arrives as a message. Usable only while the person has Hydra on.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Self-contained spec: goal, exact files, constraints, acceptance check' },
          cwd: { type: 'string', description: 'Repo directory to work in; defaults to the session root' },
          engine: { type: 'string', enum: [...ENGINES], description: 'Auto mode only (the person ran /hydra engine=auto): the engine this Head runs on, required there. Pick by the task: see the routing guide in the Hydra policy. In a fixed-engine session it must be omitted or match.' },
          model: { type: 'string', description: 'Head model id (CodeBuddy and Codex ids have no provider prefix); defaults to the Hydra head model. On Codex: gpt-6.1-sol for hard or multi-file work, gpt-6-luna for mechanical or small tasks. On Antigravity it is always gemini-3.8-flash.' },
          maxTurns: { type: 'number', description: 'Turn cap for the Head (default 60)' },
          addDirs: { type: 'array', items: { type: 'string' }, description: 'Absolute folders outside cwd the Head must read (mockups, briefs, other repos)' },
          writeDirs: { type: 'array', items: { type: 'string' }, description: 'Absolute folders outside cwd the Head may also write to, such as the real location of a symlinked package. Only folders the task must change: never /, the home folder or a folder above the project. Their .git, .commandcode and .env files stay protected.' },
          shell: { type: 'boolean', description: 'Give the Head a shell (off by default). Dangerous commands stay denied: destructive git, rm -r/-f, sudo, network tools, builds and installs.' },
          name: { type: 'string', description: 'Short name to track this Head by, saying what it works on (e.g. prefs-utils, login-tests); lowercase letters, digits and dashes, up to 20. Defaults to one made from the task; made unique with -2, -3.' },
          effort: { type: 'string', enum: [...HEAD_EFFORTS], description: 'Reasoning effort for this Head (default low). Use low when you will check the result, one level up on each retry after a failed check, max first only for subtle work you cannot check. Ignored while the person has fixed a level with /hydra effort=<level>.' },
          maxMinutes: { type: 'number', description: 'Wall-clock limit before the Head is stopped (default 40)' },
          background: { type: 'boolean', description: 'Return at once; the report arrives later as a message. Use for parallel fan-out.' },
        },
        required: ['task'],
      },
    })
    await $.tool.register({
      name: 'control',
      description: 'Hydra control for the Lead: list the Heads (with their state, turns, time and what they are doing), stop a stuck or wrong Head by id or all of them, clear finished ones from the views, or turn Hydra on/off and set the Head effort, model or engine.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'stop', 'clear', 'on', 'off', 'effort'], description: 'What to do (default list)' },
          id: { type: 'string', description: 'For stop: the Head name (e.g. prefs-utils), or all; default all' },
          effort: { type: 'string', enum: [...EFFORT_MODES], description: 'For on/effort: auto or a fixed level' },
          headModel: { type: 'string', description: 'For on/effort: the model the Heads run on' },
          engine: { type: 'string', enum: [...ENGINES, AUTO], description: 'For on/effort: the CLI Heads run on: commandcode, codebuddy, codex or agy, or auto to let you pick one per Head' },
          engines: { type: 'array', items: { type: 'string', enum: [...ENGINES] }, description: 'For on/effort with engine auto: the engines you may use (default: all that are ready)' },
        },
      },
    })
    $.ui.status(undefined)
    // A reload or restart ends every Head this module was running; say so instead of showing them running forever.
    const startNow = await $.clock.now()
    const stranded = (await read($, runs)).filter(run => (run.state === 'running' || run.state === 'queued') && run.cwd).map(run => run.cwd!)
    for (const cwd of new Set([...stranded, await $.session.root()])) await writeRules($, cwd).catch(() => undefined)
    await update($, runs, list => stopRuns(list, 'all', 'ended by a reload or restart', startNow))
    void sweepStatusFiles($)
    void sweepBuddySettings($)
    void sweepAgyHomes($)
    const usage = await $.session.usage()
    await storeLead($, usage.rateLimits, limits)
    void refreshHeads($, limits)
    $.clock.every(REFRESH_MS, () => void refreshHeads($, limits))
    // The views' clock: stamps the time once a second while some Head is live, and once more after the last one goes quiet.
    let wasLive = false
    $.clock.every(1_000, () => void (async () => {
      const now = await $.clock.now()
      const isAnyLive = (await read($, runs)).some(run => isLive(run, now))
      if (isAnyLive || wasLive) await update($, tick, () => now)
      wasLive = isAnyLive
    })())

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await storeLead($, e.rateLimits, limits)

    return next(e)
  })

  on('command.run', { command: 'hydra' }, async ($, e) => {
    const { action, leadModel, headModel, effort, engine, engines, task, unknown } = parseHydraArgs(e.args)
    const stored = await read($, mode)
    const current = stored ?? { isOn: false, headModel: defaultHead, effort: defaultEffort, engine: defaultEngine }
    const currentEffort = stored ? effortModeOf(stored) : defaultEffort
    const currentEngine = engineOf(stored, defaultEngine)

    if (action === 'help') return { text: HYDRA_HELP }
    if (action === 'statusline') return { text: STATUSLINE_HELP }
    if (action === 'engines') {
      const lines = ['🐉 Engines (what each is for; /hydra engine=auto lets Claude pick per Head):']
      for (const name of ENGINES) {
        const check = await preflight($, name)
        lines.push(`  ${check.problems.length === 0 ? '✓' : '✗'} ${name} (${ENGINE_LABEL[name]}) — ${ROUTES[name]}`, ...check.problems.map(problem => `      ${problem}`))
      }
      if (isAuto(stored) && current.isOn) lines.push(`Now: auto, pool ${poolOf(stored).join(', ')}.`)
      else if (current.isOn) lines.push(`Now: ${engineLabel(current, defaultEngine)}.`)
      return { text: lines.join('\n') }
    }
    if (action === 'status') {
      const model = await $.session.model()
      return { text: current.isOn ? `🐉 Hydra on · Lead ${model} · Head ${current.headModel} on ${engineLabel(current, defaultEngine)} · effort ${currentEffort}` : 'Hydra is off. Turn it on with /hydra.' }
    }
    if (action === 'off') {
      await update($, mode, () => ({ ...current, isOn: false }))
      $.ui.invalidate('tool.describe')
      await refreshStatus($, limits)
      return { text: 'Hydra off. Claude works alone again.' }
    }

    if (unknown) return { text: `Unknown option "${unknown}". A task needs a few words; /hydra help lists the options.` }
    if (effort !== undefined && !isEffortMode(effort)) return { text: `Unknown effort "${effort}". Use auto (the Lead picks low to max per Head) or one of: ${EFFORTS.join(', ')}.` }
    if (engine !== undefined && !isEngine(engine) && engine !== AUTO) return { text: `Unknown engine "${engine}". Use ${[...ENGINES, AUTO].join(', ')}.` }
    const keepsAuto = isAuto(stored) && engine === undefined && engines === undefined
    if (engine === AUTO || engines !== undefined || keepsAuto) {
      const parsed = engines !== undefined ? parseEngineList(engines) : { engines: keepsAuto ? poolOf(stored) : [...ENGINES], bad: [] as string[] }
      if (parsed.bad.length > 0) return { text: `Unknown engine "${parsed.bad[0]}". Use ${ENGINES.join(', ')}.` }
      if (parsed.engines.length === 0) return { text: 'engines= needs at least one of: ' + ENGINES.join(', ') + '.' }
      const ready = await readyEngines($, parsed.engines)
      if (ready.pool.length === 0) return { text: ['🐉 Hydra can\'t start yet: none of those engines is ready.', ...ready.skipped.map(item => `  • ${ENGINE_LABEL[item.engine]}: ${item.problem}`), 'Then run /hydra again.'].join('\n') }
      if (!(await hasConsentAll($, ready.pool, true))) return { text: 'Hydra stays off. Run /hydra when you want Heads to work for Claude.' }
      const nextAuto = { isOn: true, headModel: headModel ?? (isModelFor('commandcode', current.headModel) ? current.headModel : defaultHead), effort: effort ?? currentEffort, engine: AUTO, engines: ready.pool }
      await update($, mode, () => nextAuto)
      $.ui.invalidate('tool.describe')
      await refreshStatus($, limits)
      const autoModel = await $.session.model()
      const autoHint = leadModel && !autoModel.toLowerCase().includes(leadModel) ? ` Run /model ${leadModel} to switch the Lead.` : ''
      const left = ready.skipped.map(item => `\n⚠ ${ENGINE_LABEL[item.engine]} left out: ${item.problem}`).join('')
      const autoEffort = nextAuto.effort === 'auto' ? 'effort auto (Lead picks low to max)' : `effort ${nextAuto.effort}`
      const autoText = `🐉 Hydra on · Lead ${autoModel} · Heads on ${engineLabel(nextAuto, defaultEngine)}, Claude picks the engine per Head · ${autoEffort}. /heads to watch, /hydra engines for what each is for, /hydra off to stop.${autoHint}${left}${ready.warnings.map(warning => `\n⚠ ${warning}`).join('')}`
      if (task) {
        if (isWorkerRunning) pendingPrompts.push(task)
        else return { text: autoText, context: [task] }
      }
      return { text: autoText }
    }
    const nextEngine = (engine ?? currentEngine) as Engine
    const next = { isOn: true, headModel: headModelFor(nextEngine, headModel, current.headModel, defaultHead), effort: effort ?? currentEffort, engine: nextEngine }
    const check = await preflight($, next.engine as Engine)
    if (check.problems.length > 0) return { text: preflightText(check) }
    if (!(await hasConsent($, next.headModel, true, next.engine as Engine))) return { text: 'Hydra stays off. Run /hydra when you want Heads to work for Claude.' }
    await update($, mode, () => next)
    $.ui.invalidate('tool.describe')
    await refreshStatus($, limits)
    const model = await $.session.model()
    const switchHint = leadModel && !model.toLowerCase().includes(leadModel) ? ` Run /model ${leadModel} to switch the Lead.` : ''
    const changed = current.isOn && next.effort !== currentEffort ? ' Running Heads switch at their next round.' : ''
    const effortText = next.effort === 'auto' ? 'effort auto (Lead picks low to max)' : `effort ${next.effort}`
    const warnings = check.warnings.map(warning => `\n⚠ ${warning}`).join('')
    const text = `🐉 Hydra on · Lead ${model} · Head ${next.headModel} on ${ENGINE_LABEL[nextEngine]} · ${effortText}. /heads to watch, /hydra off to stop.${changed}${switchHint}${warnings}`

    // A command's `context` only rides along with the next prompt; submitting the task starts the Lead's turn now.
    if (task) {
      if (isWorkerRunning) pendingPrompts.push(task)
      else return { text, context: [task] }
    }

    return { text }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const hydra = await read($, mode)
    if (!hydra?.isOn) return composed

    return { sections: [...composed.sections, { id: 'hydra:policy', text: HYDRA_POLICY(hydra.headModel, effortModeOf(hydra), isAuto(hydra) ? AUTO : engineOf(hydra, defaultEngine), poolOf(hydra)), scope: 'session' as const }] }
  })

  on('tool.describe', { tool: HEAD_TOOL }, async ($, e, next) => {
    const described = await next(e)

    return { ...described, isDeferred: !(await read($, mode))?.isOn }
  })

  on('tool.call', { tool: HEAD_TOOL }, async ($, e, next) => {
    const hydra = await read($, mode)
    if (!hydra?.isOn) return { deny: 'Hydra is off. The person turns it on with /hydra.' }
    if (!String(e.task ?? '').trim()) return { deny: 'A Head needs a task.' }
    if (e.effort !== undefined && !isHeadEffort(e.effort)) return { deny: 'effort must be low, medium, high, xhigh or max.' }
    const cwd = typeof e.cwd === 'string' && e.cwd ? e.cwd : await $.session.root()
    const writable = await resolveWriteDirs($, cwd, strings(e.writeDirs))
    if ('refusal' in writable) return { deny: writable.refusal }
    const routed = resolveHeadEngine(hydra, e.engine, defaultEngine)
    if ('deny' in routed) return { deny: routed.deny }
    const engine = routed.engine
    const headModel = headModelFor(engine, undefined, hydra.headModel, defaultHead)
    const asked = typeof e.model === 'string' && e.model ? e.model : undefined
    const input = { ...e, writeDirs: writable.dirs, ...(asked && !isModelFor(engine, asked) ? { model: undefined } : {}) }
    const taken = new Set([...usedNames, ...(await read($, runs)).map(run => run.id)])
    const id = headName(e.name, String(e.task ?? ''), taken)
    usedNames.add(id)
    if (e.background === true) {
      if (!isWorkerRunning) return { deny: 'Hydra is still starting in this session. Try again in a moment, or run this Head without background.' }
      backgroundJobs.push({ input, headModel, id, engine })

      return { result: `Head ${id} started in the background on ${headModel} (${ENGINE_LABEL[engine]}). Its report arrives as a message from the hydra plugin when it finishes.` }
    }
    if (!isWorkerRunning) {
      const { text } = await runHead($, input, headModel, next.signal, limits, id, engine)

      return { result: text }
    }
    // Run on the worker's long-lived `$`, so a cancelled call stops the Head cleanly instead of stranding it as running.
    // The hook waits through `$` calls: a hook's own time is capped at 10 s, and a `$` call in flight does not count.
    const { box, reply } = createReplyBox<HeadResult>(next.signal)
    backgroundJobs.push({ input, headModel, id, engine, reply })
    const result = await waitForResult(box, next.signal, () => $.process.run(['/bin/sleep', '1'], { timeoutMs: 5_000 }).then(() => undefined))

    return { result: result?.text ?? `Head ${id} keeps running in the background after the call was interrupted; its report arrives as a message from the hydra plugin. Stop it with ${CONTROL_TOOL} if it is no longer wanted.` }
  }).catch(($, e, next) => ({ deny: `Hydra: the Head could not run (${next.error.message ?? next.error.kind}). Run /hydra to check the setup.` }))

  on('tool.describe', { tool: CONTROL_TOOL }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  on('tool.call', { tool: CONTROL_TOOL }, async ($, e) => {
    const action = String(e.action ?? 'list')
    const now = await $.clock.now()
    const ids = typeof e.id === 'string' && e.id && e.id !== 'all' ? [e.id] : ('all' as const)
    if (action === 'list') {
      const hydra = await read($, mode)
      const head = hydra?.isOn ? `Hydra on · Head ${hydra.headModel} on ${engineLabel(hydra, defaultEngine)} · effort ${effortModeOf(hydra)}` : 'Hydra off'

      return { result: `${head}\n${listRuns(await read($, runs), now, id => controllers.has(id))}` }
    }
    if (action === 'stop') {
      const list = await read($, runs)
      const targets = list.filter(run => (run.state === 'running' || run.state === 'queued') && (ids === 'all' || ids.includes(run.id)))
      if (targets.length === 0) return { result: `No running or queued Head${ids === 'all' ? '' : ` ${ids[0]}`}.` }
      const ghosts = await stopHeadsNow($, targets.map(run => run.id), 'stopped by the Lead', limits)

      return { result: `Stopping ${targets.map(run => run.id).join(', ')}.${ghosts.length > 0 ? ` ${ghosts.join(', ')} had no live process and were marked failed.` : ''}` }
    }
    if (action === 'clear') {
      await update($, runs, list => list.filter(run => run.state === 'running' || run.state === 'queued'))

      return { result: 'Cleared finished and failed Heads from the views.' }
    }
    const stored = await read($, mode)
    const current = stored ?? { isOn: false, headModel: defaultHead, effort: defaultEffort, engine: defaultEngine }
    if (action === 'off') {
      await update($, mode, () => ({ ...current, isOn: false }))
    } else if ((action === 'on' || action === 'effort') && (String(e.engine) === AUTO || Array.isArray(e.engines) || (isAuto(stored) && e.engine === undefined))) {
      const listed = Array.isArray(e.engines) ? parseEngineList(e.engines.map(String).join(',')) : undefined
      if (listed && (listed.bad.length > 0 || listed.engines.length === 0)) return { deny: `engines must be some of: ${ENGINES.join(', ')}.` }
      const wanted = listed ? listed.engines : isAuto(stored) ? poolOf(stored) : [...ENGINES]
      const effort = typeof e.effort === 'string' ? e.effort : undefined
      if (effort !== undefined && !isEffortMode(effort)) return { deny: `effort must be auto or one of: ${EFFORTS.join(', ')}.` }
      let pool: Engine[] = wanted
      if (action === 'on' || listed) {
        const ready = await readyEngines($, wanted)
        if (ready.pool.length === 0) return { deny: ['No requested engine is ready:', ...ready.skipped.map(item => `${item.engine}: ${item.problem}`)].join(' ') }
        if (!(await hasConsentAll($, ready.pool, false))) return { deny: 'The person turns Hydra on with /hydra the first time: it asks them to agree to sending code to the Head models.' }
        pool = ready.pool
      }
      const headModel = typeof e.headModel === 'string' && e.headModel ? e.headModel : isModelFor('commandcode', current.headModel) ? current.headModel : defaultHead
      await update($, mode, () => ({ isOn: action === 'on' ? true : current.isOn, headModel, effort: effort ?? effortModeOf(stored), engine: AUTO, engines: pool }))
    } else if (action === 'on' || action === 'effort') {
      if (e.engine !== undefined && !isEngine(e.engine)) return { deny: `engine must be one of: ${[...ENGINES, AUTO].join(', ')}.` }
      const engine = isEngine(e.engine) ? e.engine : engineOf(stored, defaultEngine)
      if (action === 'on') {
        const check = await preflight($, engine)
        if (check.problems.length > 0) return { deny: preflightText(check) }
        if (!(await hasConsent($, current.headModel, false, engine))) return { deny: 'The person turns Hydra on with /hydra the first time: it asks them to agree to sending code to the Head model.' }
      }
      const effort = typeof e.effort === 'string' ? e.effort : undefined
      if (effort !== undefined && !isEffortMode(effort)) return { deny: `effort must be auto or one of: ${EFFORTS.join(', ')}.` }
      const headModel = headModelFor(engine, typeof e.headModel === 'string' && e.headModel ? e.headModel : undefined, current.headModel, defaultHead)
      await update($, mode, () => ({ isOn: action === 'on' ? true : current.isOn, headModel, effort: effort ?? effortModeOf(stored), engine }))
    } else {
      return { deny: `Unknown action "${action}". Use list, stop, clear, on, off or effort.` }
    }
    $.ui.invalidate('tool.describe')
    await refreshStatus($, limits)
    const hydra = await read($, mode)

    return { result: hydra?.isOn ? `Hydra on · Head ${hydra.headModel} on ${engineLabel(hydra, defaultEngine)} · effort ${effortModeOf(hydra)}` : 'Hydra off.' }
  }).catch(($, e, next) => ({ deny: `Hydra control failed (${next.error.message ?? next.error.kind}).` }))

  on('command.run', { command: 'heads' }, async $ => {
    await $.ui.open({ id: HEADS_PANE, title: 'Heads' })

    return { text: 'Heads pane opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const now = await read($, tick)
    const frame = Math.floor(now / 1000)
    const live = (await read($, runs)).filter(run => isLive(run, now))
    if (live.length === 0) return next(e)
    const isRouted = isAuto(await read($, mode))
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>🐉 Hydra </Text>
          <Text dimColor>{headsSummary(live)} · /heads for detail</Text>
        </Box>
        {live.map(run => (
          <Box key={run.id}>
            <Text color={glyphColor(run)}>{glyphOf(run, frame)} </Text>
            <Text bold>{run.id} </Text>
            {isRouted && <Text color="cyan">{(run.engine ?? '').padEnd(11)} </Text>}
            <Text dimColor>{(run.effort ?? '').padEnd(5)} </Text>
            <Text color={glyphColor(run)}>{barOf(run.maxTurns ? (run.turns / run.maxTurns) * 100 : 0, 8)}</Text>
            <Text dimColor> {String(run.turns).padStart(2)}/{run.maxTurns ?? '?'} {elapsedOf(run, now).padStart(5)} </Text>
            <Text wrap="truncate-end" dimColor={run.state !== 'running'}>{nowLine(run)}</Text>
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: HEADS_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await read($, tick)
    const frame = Math.floor(now / 1000)
    const hydra = await read($, mode)
    const list = [...(await read($, runs))].reverse()
    const pick = await read($, selected)
    const chosen = list.find(run => run.id === pick) ?? list.find(run => run.state === 'running') ?? list[0]
    const at = chosen ? list.indexOf(chosen) : -1
    const pickAt = (index: number) => {
      const target = list[Math.max(0, Math.min(list.length - 1, index))]
      if (target) void update($, selected, () => target.id)
    }
    const barWidth = Math.max(10, Math.min(30, e.props.bodyColumns - 24))

    return (
      <Box flexDirection="column">
        <Text bold>🐉 Hydra · {hydra?.isOn ? `${engineLabel(hydra, defaultEngine)} · ${shortModel(hydra.headModel)} · effort ${effortModeOf(hydra)}` : 'off'}</Text>
        <Text dimColor>{list.length > 0 ? `${headsSummary(list)} · 1-9 or j/k to pick a Head, s to stop it` : 'No Heads in this session yet. Claude starts them once Hydra is on (/hydra).'}</Text>
        {list.length > 1 && (
          <Box>
            <Button key="next-head" plain hotkey="j" label="next" onPress={() => pickAt(at + 1)} />
            <Text> </Text>
            <Button key="prev-head" plain hotkey="k" label="previous" onPress={() => pickAt(at - 1)} />
          </Box>
        )}
        <Box flexDirection="column" marginTop={1}>
          {list.map((run, index) => (
            <Box key={run.id}>
              <Button key={`pick-${run.id}`} plain hotkey={index < 9 ? String(index + 1) : undefined} label={run.id} onPress={() => update($, selected, () => run.id)} />
              <Text color={glyphColor(run)}> {glyphOf(run, frame)} </Text>
              <Text dimColor>{elapsedOf(run, now).padStart(5)} {String(run.turns).padStart(3)}t </Text>
              <Text wrap="truncate-end" bold={run.id === chosen?.id}>{run.task}</Text>
            </Box>
          ))}
        </Box>
        {chosen && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>
              {chosen.id} · {shortModel(chosen.model)}{chosen.effort ? ` · effort ${chosen.effort}` : ''} · {chosen.state} {elapsedOf(chosen, now)}
            </Text>
            <Text dimColor wrap="wrap">{chosen.task}</Text>
            {(chosen.state === 'running' || chosen.state === 'queued') && (
              <Box marginTop={1}>
                <Button key="stop-head" hotkey="s" label={`Stop ${chosen.id}`} onPress={() => stopHeadsNow($, [chosen.id], 'stopped from /heads', limits)} />
              </Box>
            )}
            <Box marginTop={1}>
              <Text>turn {chosen.turns}/{chosen.maxTurns ?? '?'} </Text>
              <Text color={glyphColor(chosen)}>{barOf(chosen.maxTurns ? (chosen.turns / chosen.maxTurns) * 100 : 0, barWidth)}</Text>
            </Box>
            <Text dimColor>
              {chosen.edits ?? 0} edits · {chosen.denials ?? 0} denied{chosen.costUsd !== undefined ? ` · $${chosen.costUsd.toFixed(4)}` : chosen.tokens ? ` · ${chosen.tokens}` : ''}
            </Text>
            <Box marginTop={1}>
              <Text color={glyphColor(chosen)}>{glyphOf(chosen, frame)} </Text>
              <Text wrap="truncate-end">{nowLine(chosen)}</Text>
            </Box>
            {(chosen.steps ?? []).map((step, index) => (
              <Box key={`step-${index}`}>
                <Text color={step.isOk ? 'green' : 'red'}>  {step.isOk ? '✓' : '✗'} </Text>
                <Text wrap="truncate-end" dimColor={step.isOk}>{step.text}{step.isOk ? '' : ' (denied)'}</Text>
              </Box>
            ))}
            {chosen.files && chosen.files.length > 0 && (
              <Box marginTop={1}>
                <Text wrap="wrap">edited ({chosen.files.length}): {chosen.files.join(', ')}</Text>
              </Box>
            )}
            {chosen.summary && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Report</Text>
                <Text dimColor wrap="wrap">{chosen.summary}</Text>
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
  })

  on('command.run', { command: USAGE_COMMAND }, async $ => {
    await refreshHeads($, limits)
    await $.ui.open({ id: PANE, title: 'Usage' })

    return { text: 'Usage pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const width = Math.max(10, Math.min(40, (e.viewport?.columns ?? 50) - 6))
    const windows = await read($, lead)
    const usage = await read($, heads)
    const hydra = await read($, mode)
    const recent = await read($, runs)

    const row = (label: string, percent: number, detail: string) => (
      <Box flexDirection="column" marginBottom={1}>
        <Box justifyContent="space-between">
          <Text>{label}</Text>
          <Text dimColor>
            {detail} {Math.round(percent)}%
          </Text>
        </Box>
        <Text color={colorOf(percent)}>{barOf(percent, width)}</Text>
      </Box>
    )

    const spend = (label: string, usd: number, limit: number, resetsAt: string | null) =>
      limit > 0 ? (
        row(`${label} limit · $${limit.toFixed(2)}`, percentOf(usd, limit), `$${usd.toFixed(2)} ${resetsIn(resetsAt, now)}`)
      ) : (
        <Box key={label} justifyContent="space-between">
          <Text>{label}</Text>
          <Text dimColor>${usd.toFixed(2)} spent</Text>
        </Box>
      )

    return (
      <Box flexDirection="column">
        <Text bold color="#D97757">✳ Lead · Claude</Text>
        {windows.length === 0 && <Text dimColor>No reading yet: limits arrive with the first reply on a subscription.</Text>}
        {windows.map(w => row(leadLabel(w.kind), w.percentUsed, resetsIn(w.resetsAt, now)))}

        <Text bold>⌘ Heads · {engineLabel(hydra, defaultEngine)}</Text>
        <Text dimColor>{plan ? `Plan · ${plan} · ` : ''}estimated from local session costs</Text>
        {!usage && <Text dimColor>Reading Head usage…</Text>}
        {usage?.error && <Text color={isNoSpend(usage.error) ? undefined : 'red'} dimColor={isNoSpend(usage.error)} wrap="wrap">{usage.error}</Text>}
        {usage && !usage.error && spend('5-hour', usage.fiveHour.usd, fiveHourUsd, usage.fiveHour.resetsAt)}
        {usage && !usage.error && spend('Weekly', usage.weekly.usd, weeklyUsd, usage.weekly.resetsAt)}
        {usage && !usage.error && (fiveHourUsd <= 0 || weeklyUsd <= 0) && (
          <Box marginBottom={1}>
            <Text dimColor wrap="wrap">Set your Command Code plan's limits in /config (the Hydra rows) to see how close you are.</Text>
          </Box>
        )}

        <Text bold>🐉 Hydra · {hydra?.isOn ? `on · Head ${hydra.headModel} on ${engineLabel(hydra, defaultEngine)} · effort ${effortModeOf(hydra)}` : 'off'}</Text>
        {recent.length > 0 && <Text dimColor>{headsSummary(recent)} · /heads to watch them</Text>}
      </Box>
    )
  })
}
