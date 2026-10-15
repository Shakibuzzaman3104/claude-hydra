/**
 * @author Shakib
 * @since 15/10/26
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { HeadRun, HeadsUsage, HydraMode, LeadWindow } from '../../types'

export const lead = atom({ plugin: 'hydra', key: 'lead' } as const, [])
export const heads = atom({ plugin: 'hydra', key: 'heads' } as const, null)
export const warned = atom({ plugin: 'hydra', key: 'warned' } as const, [])
export const mode = atom({ plugin: 'hydra', key: 'mode' } as const, null)
export const runs = atom({ plugin: 'hydra', key: 'runs' } as const, [])
export const selected = atom({ plugin: 'hydra', key: 'selected' } as const, null)
export const tick = atom({ plugin: 'hydra', key: 'tick' } as const, 0)

/**
 * `read` and `update` of the atoms above, for every other file. The validator reads an atom's key only from a `const` in the
 * file that calls the state library, and follows `$` only into function declarations, so the calls live here.
 */
export async function readLead($: EngineInterface) {
  return read($, lead)
}

export async function readHeads($: EngineInterface) {
  return read($, heads)
}

export async function readWarned($: EngineInterface) {
  return read($, warned)
}

export async function readMode($: EngineInterface) {
  return read($, mode)
}

export async function readRuns($: EngineInterface) {
  return read($, runs)
}

export async function readSelected($: EngineInterface) {
  return read($, selected)
}

export async function readTick($: EngineInterface) {
  return read($, tick)
}

export async function updateLead($: EngineInterface, change: (value: LeadWindow[]) => LeadWindow[]) {
  return update($, lead, change)
}

export async function updateHeads($: EngineInterface, change: (value: HeadsUsage | null) => HeadsUsage | null) {
  return update($, heads, change)
}

export async function updateWarned($: EngineInterface, change: (value: string[]) => string[]) {
  return update($, warned, change)
}

export async function updateMode($: EngineInterface, change: (value: HydraMode | null) => HydraMode | null) {
  return update($, mode, change)
}

export async function updateRuns($: EngineInterface, change: (value: HeadRun[]) => HeadRun[]) {
  return update($, runs, change)
}

export async function updateSelected($: EngineInterface, change: (value: string | null) => string | null) {
  return update($, selected, change)
}

export async function updateTick($: EngineInterface, change: (value: number) => number) {
  return update($, tick, change)
}
