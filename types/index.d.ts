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

export type HydraMode = { isOn: boolean; headModel: string; effort?: string }

export type HeadRun = {
  id: string
  task: string
  model: string
  state: 'running' | 'done' | 'failed'
  turns: number
  costUsd?: number
}

declare module 'claude-code' {
  interface PluginState {
    hydra: {
      lead: LeadWindow[]
      heads: HeadsUsage | null
      warned: string[]
      mode: HydraMode | null
      runs: HeadRun[]
    }
  }
}
