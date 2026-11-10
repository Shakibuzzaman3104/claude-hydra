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
