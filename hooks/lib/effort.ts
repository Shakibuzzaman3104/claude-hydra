/**
 * @author Shakib
 * @since 15/10/26
 */
import type { HydraMode } from '../../types'

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
