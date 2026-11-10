/**
 * @author Shakib
 * @since 10/11/26
 */

import { expect, test } from 'claude-code/testing'
import { statusMark } from './lib/format'
import { HYDRA_HELP, SURGE_POLICY, parseHydraArgs } from './lib/policy'
import { SURGE_COLORS, findSurges, surgeDecorations, surgeOf } from './lib/surge'

test('finds a lone word in a sentence with its offsets', async () => {
  expect(findSurges('go on a rampage here')).toEqual([{ surge: 'rampage', start: 8, end: 15 }])
})

test('matches surge words case-insensitively', async () => {
  expect(findSurges('RAMPAGE then Chimera')).toEqual([
    { surge: 'rampage', start: 0, end: 7 },
    { surge: 'chimera', start: 13, end: 20 },
  ])
})

test('finds both words in position order', async () => {
  expect(findSurges('go rampage then chimera now')).toEqual([
    { surge: 'rampage', start: 3, end: 10 },
    { surge: 'chimera', start: 16, end: 23 },
  ])
})

test('surgeOf prefers chimera when both words appear', async () => {
  expect(surgeOf('go rampage then chimera now')).toBe('chimera')
})

test('surgeOf is undefined for plain text', async () => {
  expect(surgeOf('just some ordinary words')).toBe(undefined)
})

test('does not treat embedded words or tight punctuation as triggers', async () => {
  const texts = [
    'rampages',
    'chimeras',
    'my_rampage',
    'chimera.ts',
    'src/chimera/x',
    'lib/rampage',
    '\\rampage',
    '--chimera',
    'rampage=1',
    '"chimera"',
    'chimera()',
    '@rampage',
  ]
  for (const text of texts) expect(findSurges(text)).toEqual([])
})

test('counts words followed by sentence punctuation as triggers', async () => {
  for (const text of ['use chimera.', 'chimera, please', 'chimera. Then stop']) {
    expect(findSurges(text).length).toBe(1)
  }
})

test('counts a parenthesised word as a trigger', async () => {
  expect(findSurges('(rampage)')).toEqual([{ surge: 'rampage', start: 1, end: 8 }])
})

test('ignores slash commands and shell lines', async () => {
  expect(findSurges('/hydra rampage')).toEqual([])
  expect(findSurges('  !echo chimera')).toEqual([])
})

test('ignores words inside code spans', async () => {
  expect(findSurges('`rampage and chimera`')).toEqual([])
  expect(findSurges('```\nrampage\n```')).toEqual([])
})

test('counts words after a closed code span', async () => {
  expect(findSurges('`rampage` then chimera')).toEqual([{ surge: 'chimera', start: 15, end: 22 }])
})

test('an unclosed backtick hides the rest of the text', async () => {
  expect(findSurges('`rampage chimera')).toEqual([])
})

test('builds one decoration per letter of each hit', async () => {
  const decorations = surgeDecorations('a rampage b')
  expect(decorations.length).toBe(7)
  expect(decorations[0]).toEqual({ start: 2, end: 3, color: SURGE_COLORS.rampage[0], bold: true })
  expect(decorations[6]).toEqual({ start: 8, end: 9, color: SURGE_COLORS.rampage[1], bold: true })
  for (const decoration of decorations) {
    expect(decoration.end - decoration.start).toBe(1)
    expect(decoration.bold).toBe(true)
  }
})

test('spreads the chimera gradient across the middle stop', async () => {
  const decorations = surgeDecorations('chimera')
  expect(decorations.length).toBe(7)
  expect(decorations[0]!.color).toBe(SURGE_COLORS.chimera[0])
  expect(decorations[3]!.color).toBe(SURGE_COLORS.chimera[1])
  expect(decorations[6]!.color).toBe(SURGE_COLORS.chimera[2])
})

test('builds decorations for every hit', async () => {
  expect(surgeDecorations('rampage chimera').length).toBe(14)
})

test('returns no decorations for plain text', async () => {
  expect(surgeDecorations('nothing to see here')).toEqual([])
})

test('/hydra takes rampage, chimera and calm as its first word and keeps the task', async () => {
  expect(parseHydraArgs('rampage')).toMatchObject({ action: 'on', surge: 'rampage', task: '', unknown: undefined })
  expect(parseHydraArgs('Chimera audit the login flow')).toMatchObject({ surge: 'chimera', task: 'audit the login flow' })
  expect(parseHydraArgs('calm').surge).toBe('calm')
  expect('surge' in parseHydraArgs('fix the rampage bug')).toBe(false)
  expect(HYDRA_HELP).toContain('chimera adds Claude subagents')
})

test('the surge rules name their scope, and only chimera allows Claude subagents', async () => {
  expect(SURGE_POLICY('rampage', 'session')).toContain('# Hydra Rampage (on until /hydra calm)')
  expect(SURGE_POLICY('rampage', 'prompt')).toContain('this prompt only')
  expect(SURGE_POLICY('rampage', 'session')).not.toContain('Agent and Workflow')
  expect(SURGE_POLICY('chimera', 'prompt')).toContain('Agent and Workflow')
  expect(SURGE_POLICY('chimera', 'prompt')).toContain('Finalize, which is yours')
  expect(SURGE_POLICY('rampage', 'session')).toContain('With one engine everything runs on that one account')
})

test('the status mark names a session surge', async () => {
  expect(statusMark({ isOn: true, headModel: 'm' })).toBe('🐉')
  expect(statusMark({ isOn: true, headModel: 'm', surge: 'chimera' })).toBe('🐉 chimera')
  expect(statusMark({ isOn: false, headModel: 'm', surge: 'rampage' })).toBe(undefined)
})
