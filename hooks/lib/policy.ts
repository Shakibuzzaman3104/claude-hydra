/**
 * @author Shakib
 * @since 15/10/26
 */
import type { EffortMode } from './effort'
import { AGY_MODEL, AUTO, DEFAULT_ENGINE, ENGINES, ENGINE_LABEL } from './engines'
import type { Engine } from './engines'
import { shortModel } from './format'

/** Also declared in register.tsx, where the validator reads the hook matchers and the command name from: keep the two the same. */
export const USAGE_COMMAND = 'hydra-usage'
export const HEAD_TOOL = 'mcp__hydra__head'
export const CONTROL_TOOL = 'mcp__hydra__control'

const LEADS = ['fable', 'opus', 'sonnet'] as const

/** Spells out how the Head model rounds the levels it lacks, for models whose levels are known. */
const headLevelsNote = (headModel: string) =>
  /deepseek-v4\.1/i.test(headModel) ? ` ${shortModel(headModel)} takes low, high and max: medium runs as high, xhigh as max.` : ''

const codexEffortRule = (effort: EffortMode, headModel: string) =>
  `- Codex Heads run OpenAI models on the person's ChatGPT plan: \`${headModel}\` by default. Pass \`model\` per Head: \`gpt-6.1-sol\` for multi-file, algorithmic or subtle work, \`gpt-6-luna\` (faster, cheaper) for mechanical edits, renames, boilerplate and small, fully specified tasks. Some ChatGPT plans offer only \`gpt-6-luna\`: Hydra then runs the Head on it and its report says so in a ⚠ line.
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

const opencodeModelRule = (headModel: string) =>
  `- OpenCode Heads run \`${headModel}\` by default (OpenCode's free DeepSeek model, no account needed). Pass \`model\` as any \`provider/model\` the person set up in OpenCode (\`opencode models\` lists them; providers signed in with \`opencode auth login\` or an API key in the environment work, providers defined only in the person's own OpenCode config file do not). OpenCode Heads take no effort level: \`effort\` is ignored.`

const effortRule = (effort: EffortMode, headModel: string, engine: Engine = DEFAULT_ENGINE) =>
  engine === 'opencode' ? opencodeModelRule(headModel) : engine === 'agy' ? agyEffortRule(effort) : engine === 'codex' ? codexEffortRule(effort, headModel) : effort === 'auto'
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
    ? `- Heads run through \`codex exec\` inside Codex's OS sandbox with a filesystem profile Hydra writes for each Head: they can write only inside \`cwd\` (and \`writeDirs\`), never \`.git\` or \`.env\` files, and read the system, the project, \`addDirs\` folders and toolchain folders (git config, nvm, cargo, gradle…) but nothing else in the home folder: other repos, documents and credential folders are unreadable. Put any other folder a Head must read in \`addDirs\`. They always have a shell, but it has no network: installs, \`git push\`, downloads and builds that fetch dependencies fail, and \`git commit\` fails because \`.git\` is read-only. Run those yourself. \`shell\` changes nothing for them.`
    : engine === 'opencode'
    ? `- OpenCode Heads are BETA, and their lockdown is weaker than the other engines': they run through \`opencode run\` locked down only by OpenCode's own permission rules, which Hydra writes for each Head (no OS sandbox, and no write guard: OpenCode has no hook to run one). They can read the project (never \`.env\` files or credential folders), edit inside \`cwd\` (and \`writeDirs\`), never \`.git\`, \`.env\`, \`.opencode/\`, \`opencode.json\`, \`.claude/\` or \`.codebuddy/\`, read \`addDirs\` folders, and list files with glob. \`cwd\` must be the repository root: Hydra refuses an OpenCode Head in a subfolder of a repository (OpenCode would let it reach the whole repository), and one whose project or granted folders hold symlinks it cannot list or too many to deny; use another engine there. A symlink that leads out, or around a deny, is denied as found when the Head starts. They NEVER have a shell (\`shell: true\` is ignored: OpenCode does not check a shell command's paths, so a shell would escape the project), and have no search tool, web, subagents or code tool. Give them well-specified edits that name the exact files. Builds and tests are yours. Read every OpenCode Head's diff before you trust it.`
    : engine === 'codebuddy' || engine === 'workbuddy'
    ? `- Heads run through CodeBuddy's headless mode with permission rules Hydra writes for each Head, plus a write guard that checks real paths: they can edit only inside \`cwd\` (never .git or \`.env\` files), read folders you list in \`addDirs\`, and have no shell unless you pass \`shell: true\` (destructive git, rm -r/-f, sudo, network tools and installs stay denied even then). Builds and tests are yours.`
    : `- Heads run with Command Code's --yolo (its headless mode cannot edit otherwise), locked down by Hydra's deny rules: they can edit only inside \`cwd\` (never .git or \`.env\` files), read folders you list in \`addDirs\`, and have no shell unless you pass \`shell: true\` (destructive git, rm -r/-f, sudo, network tools, builds and installs stay denied even then). Builds and tests are yours.`

/** `.hydraignore`, said the same way for every engine. */
export const IGNORE_RULE = `- A \`.hydraignore\` (gitignore syntax) at the root of \`cwd\`, a \`writeDirs\` or an \`addDirs\` folder names more files a Head is kept from, as it is from \`.env\`: no reads, edits or search, and shell lines that name them are denied. Hydra matches it with git when the Head starts; a \`.hydraignore\` git cannot read, or one matching more than 200 paths, stops the Head with the reason. A Head may read \`.hydraignore\` but not change it (a change slips through only where an engine cannot block it, and is flagged at the top of the report). On a case-insensitive disk (macOS) an Antigravity Head is refused when a protected name is too long to deny in every letter case: send that task to another engine. When the person mentions secrets in a project without one, suggest one; never write it yourself without asking.`

/** The `check` field: Hydra runs it and retries, so the Lead does not stack its own retries on top. */
export const CHECK_RULE = `- Give a Head a \`check\` (a shell command, scoped to what it changes: one test class, one module's build) whenever there is something to run. Hydra runs it in \`cwd\` once the Head finishes and sends a failing Head back with the output, one effort level up, at most twice. The report's \`check:\` line is Hydra's verdict: ✓ passed, ✗ FAILED (the fix rounds are already spent: rewrite the brief or move up a level or engine, never just resend it) or ? UNKNOWN (the check could not judge the code: run it yourself). A pass is evidence, not a review: still read the diff, and when the report says the check ran code the Head changed (tests, build files), read those changes first. Heads sharing a \`cwd\` see each other's edits, so give a check only to a Head whose result does not depend on another Head still running there.`

const envRule = (engine: Engine) =>
  engine === 'agy'
    ? `- \`.env\` files that exist under \`cwd\`, a \`writeDirs\` or an \`addDirs\` folder when the Head starts are unreadable to it, shell included. One created later is not covered, and other project secrets (\`local.properties\`, keystores, \`google-services.json\`) are readable: do not point a Head at a project where that matters.`
    : engine === 'codex'
    ? `- \`.env\` files anywhere under \`cwd\`, a \`writeDirs\` or an \`addDirs\` folder are unreadable to a Head, shell included (the sandbox refuses the read, so \`grep -r\` skips them too). Other project secrets (\`local.properties\`, keystores, \`google-services.json\`) are readable unless the project's \`.hydraignore\` names them.`
    : engine === 'opencode'
    ? `- \`.env\` and \`.env.*\` files (at any depth, in any letter case) are denied to an OpenCode Head's read and edit tools by name, and it has no search tool or shell to reach them another way. A symlink to one is denied when the Head starts; one made later is not. Other project secrets (\`local.properties\`, keystores, \`google-services.json\`) are readable unless the project's \`.hydraignore\` names them.`
    : engine === 'codebuddy' || engine === 'workbuddy'
    ? `- \`.env\` files are denied to a Head's read, edit and search tools. A Head with \`shell: true\` can still read \`.env\` through a command that does not name it (\`grep -r\`), so avoid shell in projects with real secrets.`
    : `- If the project or an \`addDirs\` folder holds a \`.env\` file, Heads have no search tool: name the exact files in the task. A Head with \`shell: true\` can still read \`.env\` through a command that does not name it (\`grep -r\`), so avoid shell in projects with real secrets.`

/** One line per engine for auto mode, where the pool's full lockdown paragraphs would repeat themselves. */
const LOCKDOWN_BRIEF: Record<Engine, string> = {
  codex: 'OS sandbox: writes only in `cwd`/`writeDirs` (never `.git`), reads the project, `addDirs` and toolchains but nothing else in home, no `.env`; always a shell, never network (no installs, push or commit).',
  agy: 'permission rules + sandbox: writes only in `cwd`/`writeDirs` (never `.git`), reads only `addDirs` outside, no credential folders; shell only with `shell: true`, never network; a refused call ends a round (Hydra resumes it).',
  codebuddy: 'permission rules + write guard: edits only in `cwd`/`writeDirs` (never `.git` or `.env`), reads `addDirs`; shell only with `shell: true` (dangerous commands stay denied).',
  workbuddy: 'permission rules + write guard (the CodeBuddy CLI, through WorkBuddy): edits only in `cwd`/`writeDirs` (never `.git` or `.env`), reads `addDirs`; shell only with `shell: true` (dangerous commands stay denied).',
  opencode: 'BETA, weaker: only the permission rules of OpenCode itself (no OS sandbox, no write guard): edits only in `cwd`/`writeDirs` (never `.git`, `.env`, `.claude/` or OpenCode config), reads the project and `addDirs`; `cwd` must be the repository root (a subfolder is refused); never a shell (`shell` is ignored), no search tool: name exact files.',
  commandcode: '--yolo with deny rules + write guard: edits only in `cwd`/`writeDirs` (never `.git` or `.env`), no credential folders; shell only with `shell: true`; no search tool while a `.env` is in reach (name exact files).',
}

/** What each engine is good for, as the Lead's routing guide. Judgement from how they run, not a benchmark, except where it says measured. */
export const ROUTES: Record<Engine, string> = {
  codex: `gpt-6.1-sol (pass \`model: "gpt-6-luna"\` for easy work): the strongest coder here. Send it hard, subtle or multi-file work, and anything where the Head should run the tests itself (its shell is sandboxed with no network, so nothing that downloads). Spends the person's ChatGPT plan.`,
  agy: `gemini-3.8-flash only: fast, large context. Send it reading and summarising big areas, docs, boilerplate and bulk, mechanical or simple well-specified edits across many files. No shell unless \`shell: true\`; a refused call ends a round (Hydra resumes it).`,
  codebuddy: `DeepSeek V4.1 Flash: the cheap default. Send it well-specified edits, renames, new tests and small features. Measured: 95% of 126 runs passed at \`low\` effort. Optional shell.`,
  workbuddy: `DeepSeek V4.1 Flash, the same DeepSeek model through your WorkBuddy subscription (credits). Send it what you would send CodeBuddy: well-specified edits, renames, new tests and small features. Optional shell.`,
  opencode: `BETA. Free or cheap models (default \`opencode/deepseek-v4.1-flash-free\`, no account needed). No shell and no search tool: name the exact files in the task. Good for well-specified small edits; send anything that needs a shell, tests or a search elsewhere.`,
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


const autoPolicy = (effort: EffortMode, pool: readonly Engine[]) => `# Hydra mode (on, auto engines)
You are the Lead. Implementation goes to Heads, called through the ${HEAD_TOOL} tool, and you choose the engine for each Head with its \`engine\` field (one of: ${pool.join(', ')}). A call without one is refused.
- Split first, then route each task to the engine that suits it. Tasks on disjoint files can go to different engines in parallel (\`background: true\`).
${pool.map(engine => `  - \`${engine}\` (${ENGINE_LABEL[engine]}): ${ROUTES[engine]}`).join('\n')}
- Routing rules: when unsure, take the cheapest engine in the pool that can do it (${pool.includes('codebuddy') ? 'codebuddy' : pool.includes('workbuddy') ? 'workbuddy' : pool.includes('commandcode') ? 'commandcode' : pool[0]}); put the hard 20% on the strongest (${pool.includes('codex') ? 'codex' : pool[0]}). A Head that fails its check goes back on the same engine one effort level up, then on a stronger engine. Do not switch engines for a vague brief: rewrite it. Say in your plan which engine each task goes to, and why in a few words.
${autoEffortRule(effort)}
- Plan first: each Head task states the goal, the exact files, the constraints and the acceptance check; a Head sees only the repo and your task text.
- How each engine locks a Head down (builds and tests are yours):
${pool.map(engine => `  - ${ENGINE_LABEL[engine]}: ${LOCKDOWN_BRIEF[engine]}`).join('\n')}
- A Head writes only inside \`cwd\`; a write anywhere else, a symlink pointing out of the project included, is denied. When the task must change a folder outside it (a symlinked package's real location, a sibling repo), pass that folder in \`writeDirs\`, and only that folder.
- About secrets: \`.env\` files are kept from Heads, but other project secrets (\`local.properties\`, keystores, \`google-services.json\`) are readable unless \`.hydraignore\` names them, and on ${pool.filter(engine => engine === 'codebuddy' || engine === 'workbuddy' || engine === 'commandcode').map(engine => ENGINE_LABEL[engine]).join(' and ') || 'some engines'} a Head with \`shell: true\` can still read a \`.env\` through a command that does not name it. Avoid shell, and keep Heads out of projects where that matters.
${IGNORE_RULE}
- Give every Head a short \`name\` that says what it works on (\`prefs-utils\`, \`login-tests\`): you and the person track, stop and discuss Heads by that name. Without one, Hydra makes one from the task.
- Dependent tasks run in sequence; independent ones in parallel.
- Keep the judgement-heavy part yourself: architecture, tricky bugs, anything under ~20 lines.
- Never trust a Head's report. Read the diff and run the build/tests yourself, then fix it or send the Head back with precise feedback. A report lists the engine, the files the Head edited and every call that was denied.
${CHECK_RULE}
- You manage the Heads yourself with ${CONTROL_TOOL}: \`list\` shows every Head (one marked NO LIVE PROCESS is stale), \`stop\` ends a stuck, wrong or stale Head (\`id\`, or all), \`clear\` drops finished ones from the views. Stop a Head yourself instead of asking the person to.
- A report starting with "all accounts of <engine> are at their usage limit" means that engine cannot take the task now: route it to another engine in the pool.
- End with what each Head did (and on which engine), what you verified, and the Heads' total cost.`

export const HYDRA_POLICY = (headModel: string, effort: EffortMode, engine: Engine | typeof AUTO = DEFAULT_ENGINE, pool: readonly Engine[] = ENGINES) =>
  engine === AUTO ? autoPolicy(effort, pool) : `# Hydra mode (on)
You are the Lead. Implementation goes to Heads: ${ENGINE_LABEL[engine]} agents on ${headModel}, called through the ${HEAD_TOOL} tool.
${effortRule(effort, headModel, engine)}
- Plan first: split the work into self-contained tasks. Each Head task states the goal, the exact files, the constraints and the acceptance check; a Head sees only the repo and your task text.
${lockdownRules(engine)}
- A Head writes only inside \`cwd\`; a write anywhere else, a symlink pointing out of the project included, is denied. When the task must change a folder outside it (a symlinked package's real location, a sibling repo), pass that folder in \`writeDirs\`, and only that folder.
${envRule(engine)}
${IGNORE_RULE}
- Give every Head a short \`name\` that says what it works on (\`prefs-utils\`, \`login-tests\`): you and the person track, stop and discuss Heads by that name. Without one, Hydra makes one from the task.
- Independent tasks on disjoint files go out as parallel ${HEAD_TOOL} calls with \`background: true\`: each returns at once and its report arrives later as a message from the hydra plugin. Dependent tasks run in sequence.
- Keep the judgement-heavy part yourself: architecture, tricky bugs, anything under ~20 lines.
- Never trust a Head's report. Read the diff and run the build/tests yourself, then fix it or send the Head back with precise feedback. A report lists the files the Head edited and every call that was denied.
${CHECK_RULE}
- You manage the Heads yourself with ${CONTROL_TOOL}: \`list\` shows every Head (one marked NO LIVE PROCESS is stale), \`stop\` ends a stuck, wrong or stale Head (\`id\`, or all), \`clear\` drops finished ones from the views. Stop a Head yourself instead of asking the person to.
- End with what each Head did, what you verified, and the Heads' total cost.`

const ACTIONS = ['off', 'status', 'help', 'statusline', 'engines', 'accounts'] as const

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
  // `accounts add codex work`: the rest are that command's words, not a task or a typo.
  const unknown = action === 'accounts' ? undefined : rest.length === 1 || /^[\w-]+=/.test(first) || first.startsWith('--') ? first : undefined
  return { action, leadModel, headModel, effort, ...(engine !== undefined ? { engine } : {}), ...(engines !== undefined ? { engines } : {}), task: unknown ? '' : rest.join(' '), unknown }
}

export const HYDRA_HELP = `🐉 Hydra: Claude leads, Heads (${ENGINES.map(name => ENGINE_LABEL[name]).join(', ')} agents) implement.
  /hydra                 turn Hydra on, on the engines ready here (a short setup card if none is)
  /hydra <task>          turn it on and hand Claude the task
  /hydra off             turn it off
  /hydra status          show what is set
  /hydra effort=<level>  auto (Claude picks per Head) or off, low, medium, high, xhigh, max
  /hydra head=<model>    the model Heads run on
  /hydra engine=<name>   ${ENGINES.join(', ')}: the CLI Heads run on; auto lets Claude pick per Head
  /hydra engines=a,b     the engines auto may use (implies engine=auto), e.g. engines=codex,agy,codebuddy
  /hydra engines         which engines are installed and signed in, and what each is for
  /hydra accounts        several accounts per engine, switched on a usage limit: list, add <engine> [name], remove <engine> <name>, reset
  /hydra statusline      show Hydra in your status line
  /heads                 watch the Heads work, live: totals, a timeline and each Head's steps
  /${USAGE_COMMAND}           Claude and Head usage, and what this session's Heads used per engine`

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

export const CONSENT_QUESTION = (headModel: string, engine: Engine = DEFAULT_ENGINE) =>
  engine === 'agy'
    ? `Hydra hands each Head's task, and every file the Head reads, to ${AGY_MODEL} through the Antigravity CLI (Google), and Heads edit this project unattended (\`agy -p\` in Antigravity's terminal sandbox, locked down by Hydra's permission rules: writes only inside the project, no .git or existing .env, no network). Turn Hydra on?`
    : engine === 'codex'
    ? `Hydra hands each Head's task, and every file the Head reads, to ${headModel} through Codex (OpenAI, on your ChatGPT plan), and Heads edit this project unattended (\`codex exec\` in Codex's OS sandbox, locked down by Hydra's filesystem profile: writes only inside the project, no .git or .env, no network). Turn Hydra on?`
    : engine === 'opencode'
    ? `Hydra hands each Head's task, and every file the Head reads, to ${headModel} through OpenCode (beta), and Heads edit this project unattended (\`opencode run\`: nothing outside the project, no .git or .env, never a shell; a Head runs only at a repository's root, and symlinks it could take out of the project are denied as found when it starts). OpenCode Heads are locked down by OpenCode's own permission rules only (no OS sandbox), so the lockdown is weaker than the other engines'. Turn Hydra on?`
    : engine === 'workbuddy'
    ? `Hydra hands each Head's task, and every file the Head reads, to ${headModel} through WorkBuddy (the CodeBuddy CLI on your WorkBuddy plan, using its credits), and Heads edit this project unattended (CodeBuddy's headless mode, locked down by Hydra's permission rules and write guard: nothing outside the project, no .git or .env, no shell unless Claude asks). Turn Hydra on?`
    : engine === 'codebuddy'
    ? `Hydra hands each Head's task, and every file the Head reads, to ${headModel} through CodeBuddy, and Heads edit this project unattended (CodeBuddy's headless mode, locked down by Hydra's permission rules and write guard: nothing outside the project, no .git or .env, no shell unless Claude asks). Turn Hydra on?`
    : `Hydra hands each Head's task, and every file the Head reads, to ${headModel} through Command Code, and Heads edit this project unattended (Command Code's --yolo, locked down by Hydra: nothing outside the project, no .git or .env, no shell unless Claude asks). Turn Hydra on?`

export const CONSENT_YES = 'Turn Hydra on'

export const CHECK_CONSENT_QUESTION = (check: string) =>
  `Claude asked Hydra to run an acceptance check after a Head finishes: \`${check.slice(0, 200)}\`. Hydra runs it in the project as you, outside the Head's lockdown and without asking again, and that runs code the Head may have just written (tests, build scripts). On a failure the Head is sent back with the check's last output, which goes to its model. Let Hydra run checks like this from now on?`

export const CHECK_CONSENT_YES = 'Run checks'

export const NO_CHECK_CONSENT = 'The person has not agreed to let Hydra run checks. Run the Head without `check` and run the build or tests yourself.'

export const NO_CONSENT = 'The person has not agreed to send code to this engine. They turn it on with /hydra engine=<name> (or engines=…), which asks them.'

export const PROVIDER: Record<Engine, string> = {
  commandcode: 'DeepSeek', codebuddy: 'DeepSeek', codex: 'OpenAI', agy: 'Google (Gemini)', workbuddy: 'DeepSeek (via WorkBuddy)', opencode: 'the model you pick in OpenCode',
}

/** Said in the auto-mode consent question when OpenCode is in the pool. */
export const OPENCODE_WEAKER = 'OpenCode Heads are locked down by OpenCode\'s own permission rules only (no OS sandbox), so the lockdown is weaker than the other engines\'.'

export const AUTO_CONSENT_QUESTION = (engines: readonly Engine[]) =>
  `Hydra will let Claude route Heads across ${engines.map(engine => `${ENGINE_LABEL[engine]} (${PROVIDER[engine]})`).join(', ')}. Each Head's task, and every file it reads, goes to the model of the engine it picks, and Heads edit this project unattended inside that engine's lockdown (writes only in the project, no .git, .env files kept out where the engine can, no network where the engine can block it).${engines.includes('opencode') ? ` ${OPENCODE_WEAKER}` : ''} Turn Hydra on?`
