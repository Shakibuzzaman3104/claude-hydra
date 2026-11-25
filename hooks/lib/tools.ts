/**
 * @author Shakib
 * @since 25/11/26
 */
import type { EngineInterface } from 'claude-code'

import { EFFORT_MODES, HEAD_EFFORTS } from './effort'
import { AUTO, ENGINES } from './engines'
import { HUNT_MAX_HEADS } from './hunt'

type ToolDef = Parameters<EngineInterface['tool']['register']>[0]

/** The Lead's Hydra tools, shared by the Claude Code plugin and the Antigravity MCP server. */
export const HEAD_TOOL_DEF: ToolDef = {
  name: 'head',
  description: 'Hydra: run one Head (a cheaper coding agent on Command Code, CodeBuddy, Codex, Antigravity, WorkBuddy or OpenCode, per the person\'s engine setting) headlessly on a self-contained implementation task, or continue an earlier Head with `resume`. Returns how it ended (finished, blocked, out of turns or time, stalled), its report or handoff, cost, the files it edited and any denied calls; with background: true it returns at once and the report arrives as a message. Usable only while the person has Hydra on.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Self-contained spec: goal, exact files, constraints, what done looks like. With `resume`: only the follow-up (what to fix or do next), since the Head still has the rest. Put a build or test command in `check`, not here: a Head told to verify what its sandbox cannot run stalls.' },
      resume: { type: 'string', description: 'Name of an ended Head to continue in its own session, on its engine, model and account, with what it already read and did: for feedback on its work, the next step of the same job, or a Head that ran out of turns or time (raise maxTurns or maxMinutes). `task` is then just the follow-up. Cheaper and better informed than a new Head. Not for Antigravity Heads, nor for unrelated work.' },
      cwd: { type: 'string', description: 'Repo directory to work in; defaults to the session root' },
      engine: { type: 'string', enum: [...ENGINES], description: 'The engine this Head runs on. Required in auto mode; in a fixed-engine session it defaults to that engine, and naming another ready one sends just this Head there. Pick by the task: see the routing guide in the Hydra policy. If the engine is at its usage limit or signed out, Hydra moves the Head to another model or engine on its own, and the report says where it ran.' },
      model: { type: 'string', description: 'Head model id (CodeBuddy, WorkBuddy and Codex ids have no provider prefix; OpenCode takes provider/model); defaults to the Hydra head model. On Codex: gpt-6.1-terra (default) for coding, including hard or multi-file work, gpt-6.1-sol for work that is not code, gpt-6-luna for mechanical or small tasks, gpt-6-astra (most capable, drains the shared allowance about 3x faster than Sol) only for the hardest bug or after Terra failed at high. On CodeBuddy and WorkBuddy: deepseek-v4.1-flash, glm-5.3, kimi-k3, minimax-m3.1-flash, gpt-5.6-terra and the others `codebuddy --help` lists; each model has its own usage limit. On Antigravity: gemini-4-hydrogen (default, low to xhigh, cheapest), gemini-4-neon (low to xhigh: harder work, reviews, research and web search), gemini-4-carbon (deepest long-horizon work, spends the Gemini pool fastest), claude-sonnet-5-5 (normal work on the Claude pool), claude-opus-5-5 (hard work, drains the Claude pool several times faster than Sonnet); gemini-4-argon, gemini-3.8-flash and gpt-oss-120b leave on 30 November 2026. Every Gemini model shares one usage pool and Claude + GPT-OSS another, each charged by token cost. On OpenCode: opencode/deepseek-v4.1-flash-free (free) or any provider/model the person set up.' },
      files: { type: 'array', items: { type: 'string' }, description: 'The files this Head must create or change, relative to cwd, as the task names them. Hydra measures the Head against them: the band shows files written of files named, and the report flags a named file it never changed and any file it changed beyond them. Leave out for a reading job.' },
      maxTurns: { type: 'number', description: 'Turn cap for the Head (default 100; 200 on Codex and Antigravity, where a turn is one tool call). It stops a runaway Head; a Head that hits it writes a handoff. Raise it for wide reads and audits.' },
      addDirs: { type: 'array', items: { type: 'string' }, description: 'Absolute folders outside cwd the Head must read (mockups, briefs, other repos)' },
      writeDirs: { type: 'array', items: { type: 'string' }, description: 'Absolute folders outside cwd the Head may also write to, such as the real location of a symlinked package. Only folders the task must change: never /, the home folder or a folder above the project. Their .git, .commandcode and .env files stay protected.' },
      shell: { type: 'boolean', description: 'Give the Head a shell (off by default). Dangerous commands stay denied: destructive git, rm -r/-f, sudo, network tools, builds and installs. OpenCode Heads never get one.' },
      name: { type: 'string', description: 'Short name to track this Head by, saying what it works on (e.g. prefs-utils, login-tests); lowercase letters, digits and dashes, up to 20. Defaults to one made from the task; made unique with -2, -3.' },
      effort: { type: 'string', enum: [...HEAD_EFFORTS], description: 'Reasoning effort for this Head (default low). Use low when you will check the result, one level up on each retry after a failed check, max first only for subtle work you cannot check. Ignored while the person has fixed a level with /hydra effort=<level>.' },
      maxMinutes: { type: 'number', description: 'Wall-clock limit before the Head is stopped (default 40); it then gets two minutes to write a handoff' },
      check: { type: 'string', description: 'Acceptance check: a shell command Hydra runs in cwd once the Head ends (e.g. ./gradlew testDebugUnitTest --tests LoginViewModelTest). It runs as the person, outside the Head\'s lockdown, so it can build and test what the Head cannot; the Head is told Hydra runs it. On a failure the Head is sent back in the same session with the output, one effort level up, at most twice. A Head that ran out of turns or time after editing is checked too. Scope it to what this Head changes: Heads running in the same cwd share the files. The person is asked once before the first check runs.' },
      checkMinutes: { type: 'number', description: 'Time limit for one run of the check, in minutes (default and maximum 10)' },
      background: { type: 'boolean', description: 'Return at once; the report arrives later as a message. Use for parallel fan-out.' },
      schema: { type: 'object', description: 'A JSON Schema (root type object, with properties) the Head\'s result must match: for findings, lists and verdicts you will merge or count. Hydra asks the Head for one fenced json block, checks it, and sends a reply without usable JSON back to the Head up to twice; the report\'s `json:` line says how it ended. Supported: type, properties, required, items, enum, minItems, maxItems.' },
    },
    required: ['task'],
  },
}

export const HUNT_TOOL_DEF: ToolDef = {
  name: 'hunt',
  description: `Hydra: run a whole phase of Heads as one call and get one merged result back, instead of one report per Head. Every Head starts at once (up to ${HUNT_MAX_HEADS}); with \`schema\` each returns checked JSON; with \`refute\` a second Head on another engine tries to break each result and the author fixes what it broke, with no waiting between Heads. Returns a compact block per Head (status, check, refute verdict, edited files, its data) and the list of Heads that did not finish; every full report is saved to a file you can Read. Calling it again with the same \`name\` reuses the results of Heads whose task did not change and runs only the rest. Usable only while the person has Hydra on.`,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Names the hunt, its Heads and its saved results: lowercase letters, digits and dashes, up to 30 (auth-audit, login-build). Reuse the name to rerun only what failed or changed.' },
      heads: {
        type: 'array',
        description: `1 to ${HUNT_MAX_HEADS} Heads. Each takes the Head tool's own fields: task (required), name (a name ending -fix, -rN or -jsonN is renamed with -h, since those endings name Hydra's own follow-up Heads), engine (required in auto mode), model, effort, files, check, checkMinutes, shell, cwd, addDirs, writeDirs, maxTurns, maxMinutes. Editing Heads must name disjoint files.`,
        items: { type: 'object', properties: { task: { type: 'string' }, name: { type: 'string' }, engine: { type: 'string', enum: [...ENGINES] }, model: { type: 'string' }, effort: { type: 'string', enum: [...HEAD_EFFORTS] }, files: { type: 'array', items: { type: 'string' } }, check: { type: 'string' }, checkMinutes: { type: 'number' }, shell: { type: 'boolean' }, cwd: { type: 'string' }, addDirs: { type: 'array', items: { type: 'string' } }, writeDirs: { type: 'array', items: { type: 'string' } }, maxTurns: { type: 'number' }, maxMinutes: { type: 'number' } }, required: ['task'] },
      },
      shared: { type: 'string', description: 'Text put before every Head\'s task: the project, the hard rules, what a finding must be. Write it once here, not in each task.' },
      cwd: { type: 'string', description: 'Default working folder for Heads that do not set their own cwd.' },
      schema: { type: 'object', description: 'One JSON Schema (root type object, with properties) every Head\'s result must match. Give one whenever you will merge, count or compare the results.' },
      refute: { description: 'true, or { lenses: ["correctness", "edge cases"], fix: true }: after a Head finishes, one Head per lens (at most 3) on another engine tries to break its result and answers holds, broken or unsure. A broken result goes back to its author once (unless fix is false) and is refuted once more. A refuter that fails counts as no verdict, never as broken.' },
      fresh: { type: 'boolean', description: 'Run every Head again, ignoring results saved under this name.' },
      background: { type: 'boolean', description: 'Return at once; the merged result arrives later as a message.' },
    },
    required: ['name', 'heads'],
  },
}

export const CONTROL_TOOL_DEF: ToolDef = {
  name: 'control',
  description: 'Hydra control for the Lead: list the Heads (with their state, turns, time and what they are doing), stop a stuck or wrong Head by id or all of them, clear finished ones from the views, or turn Hydra on/off and set the Head effort, model or engine.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'stop', 'clear', 'on', 'off', 'effort'], description: 'What to do (default list)' },
      id: { type: 'string', description: 'For stop: the Head name (e.g. prefs-utils), a hunt name (stops the hunt and its Heads), or all; default all' },
      effort: { type: 'string', enum: [...EFFORT_MODES], description: 'For on/effort: auto or a fixed level' },
      headModel: { type: 'string', description: 'For on/effort: the model the Heads run on' },
      engine: { type: 'string', enum: [...ENGINES, AUTO], description: 'For on/effort: the CLI Heads run on: commandcode, codebuddy, codex, agy, workbuddy or opencode (beta), or auto to let you pick one per Head' },
      engines: { type: 'array', items: { type: 'string', enum: [...ENGINES] }, description: 'For on/effort with engine auto: the engines you may use (default: all that are ready)' },
    },
  },
}
