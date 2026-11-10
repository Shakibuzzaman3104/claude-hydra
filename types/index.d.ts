/**
 * @author Shakib
 * @since 06/10/26
 */
export type LeadWindow = { kind: string; percentUsed: number; resetsAt?: string }

export type HeadsWindow = { usd: number; resetsAt: string | null }

export type HeadsUsage = {
  fiveHour: HeadsWindow
  weekly: HeadsWindow
  measuredAt: number
  error?: string
}

/** A thorough mode on top of Hydra: `rampage` fans out Heads only, `chimera` adds Claude subagents. */
export type Surge = 'rampage' | 'chimera'

export type HydraMode = { isOn: boolean; headModel: string; effort?: string; /** Set by /hydra rampage or /hydra chimera for the session; a keyword typed in a prompt does not set it. */ surge?: Surge; /** The CLI Heads run on: 'commandcode' (default), 'codebuddy', 'codex', 'agy', 'workbuddy' or 'opencode'; 'auto' lets the Lead pick one per Head from `engines`. */ engine?: string; /** The engines an auto session may use. */ engines?: string[]; /** The person chose this engine or pool (engine=, engines=): it survives /hydra off, and an auto pool is not widened. */ pinned?: boolean }

export type HeadStep = { isOk: boolean; text: string }

/**
 * How a Head's run ended: `done` (it reported HEAD DONE), `blocked` (it reported HEAD BLOCKED), `stalled` (it kept replying
 * without acting or finishing), `capped` (out of turns or rounds), `timeout`, `stopped` (by the Lead or the person) or
 * `error` (the CLI or the engine failed).
 */
export type Ending = 'done' | 'blocked' | 'stalled' | 'capped' | 'timeout' | 'stopped' | 'error'

export type HeadRun = {
  id: string
  task: string
  model: string
  state: 'queued' | 'running' | 'done' | 'failed'
  turns: number
  costUsd?: number
  tokens?: string
  effort?: string
  maxTurns?: number
  startedAt?: number
  endedAt?: number
  activity?: string
  steps?: HeadStep[]
  edits?: number
  denials?: number
  cwd?: string
  engine?: string
  /** The tool_use_id of the call that started this run, so its transcript row can find it. */
  callId?: string
  /** The engine account the Head runs on, as `<engine>/<name>`; set only for engines with extra accounts. */
  account?: string
  files?: string[]
  /** The files the Lead named for this Head to create or change, relative to `cwd`: what its progress is measured against. */
  expected?: string[]
  /** The files it has written so far, relative to `cwd`, as its tool calls complete. */
  touched?: string[]
  /** Turns of this Head's earlier runs (before a fix round, or a move to another account or route); `turns` counts the run under way. */
  earlierTurns?: number
  /** Each edited file's size of change (`+3 −1`, `new`), by its path relative to `cwd`. */
  stats?: Record<string, string>
  summary?: string
  ending?: Ending
  /** Its acceptance check: the try Hydra is on (from 1) and how it stands. */
  check?: { tries: number; state: 'running' | 'fixing' | 'passed' | 'failed' | 'unknown' }
  /** When each run of the check and each fix round began, for the timeline. */
  marks?: { at: number; kind: 'check' | 'fix' }[]
  /** The engine's session id, kept so the Lead can continue this Head with `resume`. */
  sessionId?: string
  /** What the Head was granted, reused when it is resumed. */
  addDirs?: string[]
  writeDirs?: string[]
  shell?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    hydra: {
      lead: LeadWindow[]
      heads: HeadsUsage | null
      warned: string[]
      mode: HydraMode | null
      runs: HeadRun[]
      selected: string | null
      /** The views' clock, in ms: stamped once a second while a Head is live. */
      tick: number
    }
  }
}
