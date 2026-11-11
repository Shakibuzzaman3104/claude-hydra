/**
 * @author Shakib
 * @since 10/11/26
 */

import type { Surge } from '../../types'

export const SURGES = ['rampage', 'chimera'] as const

export type SurgeHit = { surge: Surge; start: number; end: number }

export type SurgeDecoration = { start: number; end: number; color: string; bold: true }

export const SURGE_COLORS: Record<Surge, readonly string[]> = {
  rampage: ['#ff3b30', '#ff9f0a'],
  chimera: ['#bf5af2', '#30d5c8', '#ffd60a'],
}

const WORD = new RegExp('[\\p{L}\\p{N}_]', 'u')

const ALNUM = new RegExp('[\\p{L}\\p{N}]', 'u')

const codeRanges = (text: string): Array<[number, number]> => {
  const ranges: Array<[number, number]> = []
  let i = 0
  while (i < text.length) {
    if (text.startsWith('```', i)) {
      const close = text.indexOf('```', i + 3)
      if (close === -1) {
        ranges.push([i, text.length])
        break
      }
      ranges.push([i, close + 3])
      i = close + 3
    } else if (text[i] === '`') {
      const close = text.indexOf('`', i + 1)
      if (close === -1) {
        ranges.push([i, text.length])
        break
      }
      ranges.push([i, close + 1])
      i = close + 1
    } else {
      i++
    }
  }
  return ranges
}

const isHit = (text: string, start: number, end: number): boolean => {
  const before = start > 0 ? text[start - 1] : ''
  const after = end < text.length ? text[end] : ''
  if (before && WORD.test(before)) return false
  if (after && WORD.test(after)) return false
  if (before && '\\/.-@#:=$"\'`'.includes(before)) return false
  if (after && '/-=(:"\'`'.includes(after)) return false
  if (text[end] === '.' && ALNUM.test(text[end + 1] ?? '')) return false
  return true
}

/** Finds every trigger occurrence of a surge word, in position order. */
export const findSurges = (text: string): SurgeHit[] => {
  if (/^\s*[/!]/.test(text)) return []
  const lower = text.toLowerCase()
  const code = codeRanges(text)
  const hits: SurgeHit[] = []
  let i = 0
  while (i < lower.length) {
    const surge = SURGES.find((word) => lower.startsWith(word, i))
    if (!surge) {
      i++
      continue
    }
    const start = i
    const end = i + surge.length
    const inCode = code.some(([from, to]) => start >= from && start < to)
    if (!inCode && isHit(text, start, end)) {
      hits.push({ surge, start, end })
      i = end
    } else {
      i++
    }
  }
  return hits
}

/** The winning surge: chimera beats rampage. */
export const surgeOf = (text: string): Surge | undefined => {
  const hits = findSurges(text)
  if (hits.some((hit) => hit.surge === 'chimera')) return 'chimera'
  if (hits.some((hit) => hit.surge === 'rampage')) return 'rampage'
  return undefined
}

/** undefined = keywords live; otherwise the waved-off draft, the keyword spans waved off in it, and isAway while a recalled history entry is shown instead. */
export type SurgeState = { text: string; spans: SurgeHit[]; isAway?: true } | undefined

export type SurgeBox = { text: string; cursor: number }

export type SurgeKey = { key?: string; ctrl?: boolean; meta?: boolean }

const commonPrefix = (before: string, after: string): number => {
  let i = 0
  while (i < before.length && i < after.length && before[i] === after[i]) i++
  return i
}

const commonSuffix = (before: string, after: string): number => {
  let i = 0
  while (i < before.length && i < after.length && before[before.length - 1 - i] === after[after.length - 1 - i]) i++
  return i
}

const splitEdges = (before: string, after: string): { prefix: number; suffix: number } => {
  const prefix = commonPrefix(before, after)
  const suffix = commonSuffix(before.slice(prefix), after.slice(prefix))
  return { prefix, suffix }
}

const carrySpans = (spans: SurgeHit[], before: string, after: string): SurgeHit[] => {
  const { prefix, suffix } = splitEdges(before, after)
  const delta = after.length - before.length
  return spans.flatMap(span => {
    if (span.end <= prefix) return [span]
    if (span.start >= before.length - suffix) return [{ surge: span.surge, start: span.start + delta, end: span.end + delta }]
    return []
  })
}

/** Whether keywords are live for the draft: no state, or a recalled entry shown over a kept stash. */
export const isSurgeLive = (state: SurgeState): boolean => state === undefined || state.isAway === true

/** Whether this key or the paste glyph waves the keywords off for the draft in the box. */
export const wantsDismissal = (state: SurgeState, box: SurgeBox, key?: SurgeKey, inputText?: string): boolean => {
  if (!isSurgeLive(state)) return false
  const keys = key ?? {}
  const hits = findSurges(box.text)
  const isBackspace = keys.key === 'backspace' && !keys.ctrl && !keys.meta && hits.some(hit => hit.end === box.cursor)
  const isWaved = hits.length > 0 && ((keys.key === 'w' && keys.meta === true) || inputText === '∑')
  return isBackspace || isWaved
}

/** The state once the person waved the keywords off for a draft. */
export const dismiss = (text: string): SurgeState => ({ text, spans: findSurges(text) })

/** The middle of `after` that the edit inserted, or undefined when it inserted nothing. */
export const insertedSpan = (before: string, after: string): { start: number; end: number } | undefined => {
  const { prefix, suffix } = splitEdges(before, after)
  const end = after.length - suffix
  return end > prefix ? { start: prefix, end } : undefined
}

/** The state after an edit: live again once a new keyword is typed in or the box empties. */
export const afterEdit = (state: SurgeState, before: SurgeBox, after: SurgeBox): SurgeState => {
  if (state === undefined) return undefined
  if (state.isAway) return undefined
  if (!after.text.trim()) return undefined
  const carried = carrySpans(state.spans, before.text, after.text)
  const fresh = findSurges(after.text).filter(hit => !carried.some(span => span.surge === hit.surge && span.start === hit.start && span.end === hit.end))
  if (insertedSpan(before.text, after.text) !== undefined && fresh.length > 0) return undefined
  return { text: after.text, spans: [...carried, ...fresh] }
}

/** The state after a change no edit carried: a recall is shown away, an undo ends it, plugin and clear drop it. */
export const afterChange = (state: SurgeState, text: string, kind: string): SurgeState => {
  if (state === undefined) return undefined
  if (!text.trim()) return undefined
  if (kind === 'history') {
    if (text === state.text) return { text: state.text, spans: state.spans }
    return { text: state.text, spans: state.spans, isAway: true }
  }
  if (kind === 'plugin' || kind === 'clear') return text === state.text ? state : undefined
  if (state.isAway) return undefined
  return { text, spans: findSurges(text) }
}

/** The state after a submit, and the keyword the sent text carries when it was live. */
export const afterSubmit = (state: SurgeState, text: string, kind: string): { surge?: Surge; state: SurgeState } => {
  if (kind !== 'composer') return { state }
  const surge = isSurgeLive(state) ? surgeOf(text) : undefined
  return surge ? { state: undefined, surge } : { state: undefined }
}

const toRgb = (hex: string): number[] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]

const toHex = (rgb: number[]): string =>
  '#' + rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')

const colorAt = (stops: readonly string[], t: number): string => {
  const pos = t * (stops.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.min(lo + 1, stops.length - 1)
  const f = pos - lo
  const from = toRgb(stops[lo]!)
  const to = toRgb(stops[hi]!)
  return toHex(from.map((channel, c) => Math.round(channel + (to[c]! - channel) * f)))
}

/** One gradient decoration per letter of every hit. */
export const surgeDecorations = (text: string): SurgeDecoration[] => {
  const decorations: SurgeDecoration[] = []
  for (const hit of findSurges(text)) {
    const stops = SURGE_COLORS[hit.surge]
    for (let i = 0; i < 7; i++) {
      decorations.push({
        start: hit.start + i,
        end: hit.start + i + 1,
        color: colorAt(stops, i / 6),
        bold: true,
      })
    }
  }
  return decorations
}
