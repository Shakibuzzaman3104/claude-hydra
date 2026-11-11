/**
 * @author Shakib
 * @since 10/11/26
 */

import { expect, test } from 'claude-code/testing'
import { statusMark } from './lib/format'
import { HYDRA_HELP, SURGE_POLICY, parseHydraArgs } from './lib/policy'
import { SURGE_COLORS, afterChange, afterEdit, afterSubmit, dismiss, findSurges, insertedSpan, isSurgeLive, surgeDecorations, surgeOf, wantsDismissal } from './lib/surge'
import type { SurgeState } from './lib/surge'

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

const edited = (state: SurgeState, texts: string[]): SurgeState => {
  let current = state
  let previous = texts[0] ?? ''
  for (let i = 1; i < texts.length; i++) {
    const text = texts[i] ?? ''
    current = afterEdit(current, { text: previous, cursor: previous.length }, { text, cursor: text.length })
    previous = text
  }
  return current
}

test('backspace right after a live keyword waves it off for the draft', async () => {
  const box = { text: 'rampage', cursor: 7 }
  expect(wantsDismissal(undefined, box, { key: 'backspace' })).toBe(true)
  expect(wantsDismissal(dismiss('rampage'), box, { key: 'backspace' })).toBe(false)
})

test('option+w and the paste glyph wave off a hit, and nothing else does', async () => {
  expect(wantsDismissal(undefined, { text: 'go chimera now', cursor: 10 }, { key: 'w', meta: true })).toBe(true)
  expect(wantsDismissal(undefined, { text: 'go chimera now', cursor: 10 }, undefined, '∑')).toBe(true)
  expect(wantsDismissal(undefined, { text: 'nothing here', cursor: 5 }, { key: 'w', meta: true })).toBe(false)
  expect(wantsDismissal(undefined, { text: 'nothing here', cursor: 5 }, undefined, '∑')).toBe(false)
  expect(wantsDismissal(undefined, { text: 'go rampage', cursor: 3 }, { key: 'backspace' })).toBe(false)
})

test('modified backspace, plain w and an away state decide dismissal', async () => {
  const box = { text: 'rampage', cursor: 7 }
  expect(wantsDismissal(undefined, box, { key: 'backspace', ctrl: true })).toBe(false)
  expect(wantsDismissal(undefined, box, { key: 'backspace', meta: true })).toBe(false)
  expect(wantsDismissal(undefined, box, { key: 'w' })).toBe(false)
  const away = afterChange(dismiss('rampage'), 'older', 'history')
  expect(wantsDismissal(away, box, { key: 'backspace' })).toBe(true)
})

test('typing a deleted letter back turns the keywords live again', async () => {
  expect(edited(dismiss('rampage'), ['rampage', 'rampag', 'rampage'])).toBe(undefined)
})

test('typing a letter then deleting it keeps the draft waved off', async () => {
  expect(edited(dismiss('rampage'), ['rampage', 'rampages', 'rampage'])).toEqual(dismiss('rampage'))
})

test('typing plain words keeps the draft waved off', async () => {
  const steps = ['rampage', ...Array.from({ length: 6 }, (_, i) => `rampage${' hello'.slice(0, i + 1)}`)]
  expect(edited(dismiss('rampage'), steps)).toEqual(dismiss('rampage hello'))
})

test('a whole keyword retyped letter by letter turns it live on the last letter', async () => {
  const steps = ['rampage', ...Array.from({ length: 8 }, (_, i) => `rampage${' chimera'.slice(0, i + 1)}`)]
  expect(edited(dismiss('rampage'), steps.slice(0, -1))).toEqual(dismiss('rampage chimer'))
  expect(edited(dismiss('rampage'), steps)).toBe(undefined)
})

test('pasting a second keyword turns the draft live', async () => {
  expect(edited(dismiss('rampage'), ['rampage', 'rampage x chimera'])).toBe(undefined)
})

test('replacing the whole text with another keyword turns it live', async () => {
  expect(edited(dismiss('rampage'), ['rampage', 'chimera'])).toBe(undefined)
})

test('typing in front of a waved-off word keeps it off at every step', async () => {
  let state = dismiss('rampage')
  let text = 'rampage'
  for (const [at, input] of [[0, 'f'], [1, 'i'], [2, 'x'], [3, ' ']] as const) {
    const after = `${text.slice(0, at)}${input}${text.slice(at)}`
    state = afterEdit(state, { text, cursor: at }, { text: after, cursor: at + input.length })
    text = after
    expect(isSurgeLive(state)).toBe(false)
  }
  expect(text).toBe('fix rampage')
})

test('a span follows a prefix insertion, and a new keyword past it revives', async () => {
  const shifted = afterEdit(dismiss('go rampage now'), { text: 'go rampage now', cursor: 0 }, { text: 'xgo rampage now', cursor: 1 })
  expect(shifted).toEqual({ text: 'xgo rampage now', spans: [{ surge: 'rampage', start: 4, end: 11 }] })
  expect(afterEdit(shifted, { text: 'xgo rampage now', cursor: 15 }, { text: 'xgo rampage now chimera', cursor: 23 })).toBe(undefined)
})

test('deleting inside one waved-off word leaves the other off, and retyping it revives', async () => {
  const deleted = afterEdit(dismiss('rampage and chimera'), { text: 'rampage and chimera', cursor: 1 }, { text: 'rmpage and chimera', cursor: 1 })
  expect(isSurgeLive(deleted)).toBe(false)
  expect(deleted?.spans.length).toBe(1)
  expect(afterEdit(deleted, { text: 'rmpage and chimera', cursor: 1 }, { text: 'rampage and chimera', cursor: 1 })).toBe(undefined)
})

test('deleting the last letter of a non-hit keeps it waved off, and splitting it revives', async () => {
  expect(edited(dismiss('chimerax'), ['chimerax', 'chimera'])).toEqual(dismiss('chimera'))
  expect(edited(dismiss('chimerax'), ['chimerax', 'chimera x'])).toBe(undefined)
})

test('a hit a deletion created stays waved off through a later insertion', async () => {
  const deleted = afterEdit(dismiss('chimerax'), { text: 'chimerax', cursor: 8 }, { text: 'chimera', cursor: 8 })
  expect(isSurgeLive(deleted)).toBe(false)
  const inserted = afterEdit(deleted, { text: 'chimera', cursor: 7 }, { text: 'chimera ok', cursor: 10 })
  expect(isSurgeLive(inserted)).toBe(false)
  expect(inserted?.text).toBe('chimera ok')
})

test('a history recall keeps the stash away, and putting the draft back restores it', async () => {
  const away = afterChange(dismiss('rampage'), 'older', 'history')
  expect(isSurgeLive(away)).toBe(true)
  expect(away).toBeDefined()
  const back = afterChange(away, 'rampage', 'history')
  expect(isSurgeLive(back)).toBe(false)
  expect(back).toEqual(dismiss('rampage'))
})

test('plugin and clear changes revive only on new text', async () => {
  const state = dismiss('rampage')
  for (const kind of ['plugin', 'clear']) {
    expect(afterChange(state, 'go chimera', kind)).toBe(undefined)
    expect(afterChange(state, 'rampage', kind)).toEqual(state)
  }
  expect(afterChange(undefined, 'go chimera', 'plugin')).toBe(undefined)
})

test('an away state ends on an edit or an undo, and still sends its surge', async () => {
  const away = afterChange(dismiss('rampage'), 'older', 'history')
  expect(afterEdit(away, { text: 'older', cursor: 5 }, { text: 'older!', cursor: 6 })).toBe(undefined)
  expect(afterChange(away, 'older', 'undo')).toBe(undefined)
  const sent = afterSubmit(away, 'go chimera', 'composer')
  expect(sent.surge).toBe('chimera')
  expect(sent.state).toBe(undefined)
})

test('an emptied box turns the keywords live for edits and changes', async () => {
  expect(afterEdit(dismiss('rampage'), { text: 'rampage', cursor: 7 }, { text: '   ', cursor: 3 })).toBe(undefined)
  expect(afterChange(dismiss('rampage'), '   ', 'undo')).toBe(undefined)
})

test('submitting a draft clears the state, and live keywords ride only a composer send', async () => {
  const waved = afterSubmit(dismiss('rampage'), 'go chimera', 'composer')
  expect(waved.state).toBe(undefined)
  expect('surge' in waved).toBe(false)
  expect(afterSubmit(undefined, 'go chimera', 'composer')).toEqual({ state: undefined, surge: 'chimera' })
  const plugin = afterSubmit(dismiss('rampage'), 'go chimera', 'plugin')
  expect(plugin.state).toEqual(dismiss('rampage'))
  expect('surge' in plugin).toBe(false)
})

test('insertedSpan finds the typed middle and skips deletions', async () => {
  expect(insertedSpan('abc', 'abXc')).toEqual({ start: 2, end: 3 })
  expect(insertedSpan('abc', 'ac')).toBe(undefined)
  expect(insertedSpan('aa', 'aaa')).toEqual({ start: 2, end: 3 })
})
