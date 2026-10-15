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

export type HydraMode = { isOn: boolean; headModel: string; effort?: string; /** The CLI Heads run on: 'commandcode' (default), 'codebuddy', 'codex' or 'agy'; 'auto' lets the Lead pick one per Head from `engines`. */ engine?: string; /** The engines an auto session may use. */ engines?: string[] }

export type HeadStep = { isOk: boolean; text: string }

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
  /** The engine account the Head runs on, as `<engine>/<name>`; set only for engines with extra accounts. */
  account?: string
  files?: string[]
  summary?: string
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
