/**
 * @author Shakib
 * @since 15/10/26
 */
import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'

import {
  AUTO, ENGINES, ENGINE_LABEL, INSTALL_HINT, WELCOME_LINES, bandLayout, compactNumber, engineMixOf, engineMixText, fitText, onboardingPlan, onlyReadyNote, parseTokens, setupCard,
  spendText, takeWelcome, timelineBar, timelineLayout, timelineRowCount, timelineSpan, totalsLines, totalsOf, HYDRA_HELP,
} from './register'
import type { Engine } from './register'
import type { HeadRun } from '../types'

const base = { task: 't', model: 'm', turns: 0 }
const run = (id: string, extra: Partial<HeadRun>): HeadRun => ({ id, state: 'done', ...base, ...extra })

test('reads a token count back from the text Heads report', async () => {
  expect(parseTokens('91.5k in / 421 out')).toBe(91_921)
  expect(parseTokens('800 in / 12 out')).toBe(812)
  expect(parseTokens('12k in / 0 out')).toBe(12_000)
  expect(parseTokens(undefined)).toBe(0)
  expect(parseTokens('lots')).toBe(0)
  expect(compactNumber(421)).toBe('421')
  expect(compactNumber(1_250)).toBe('1.3k')
  expect(compactNumber(18_200)).toBe('18k')
  expect(compactNumber(1_250_000)).toBe('1.3M')
})

test('adds up the Heads, leaving out what nobody reported', async () => {
  const list = [
    run('a', { engine: 'codex', tokens: '10k in / 500 out', edits: 4, denials: 1, startedAt: 1_000, endedAt: 61_000 }),
    run('b', { engine: 'commandcode', costUsd: 0.0336, edits: 2, startedAt: 31_000, state: 'running' }),
    run('c', { state: 'failed', engine: 'codex' }),
    run('d', { state: 'queued' }),
  ]
  const totals = totalsOf(list, 121_000)
  expect(totals).toMatchObject({ running: 1, queued: 1, done: 1, failed: 1, tokens: 10_500, hasTokens: true, usd: 0.0336, hasUsd: true, edits: 6, denials: 1, wallMs: 120_000 })
  expect(spendText(totals)).toBe('11k tok · $0.0336')
  expect(totalsLines(totals)).toEqual(['1 running · 1 queued · 1 done · 1 failed · 2:00 wall', '6 edits · 1 denied · 11k tok · $0.0336'])

  const none = totalsOf([run('x', { state: 'queued' })], 5)
  expect(none.hasTokens).toBe(false)
  expect(none.hasUsd).toBe(false)
  expect(none.wallMs).toBe(0)
  expect(spendText(none)).toBe('')
  expect(totalsLines(none)).toEqual(['1 queued', '0 edits · 0 denied'])
  expect(totalsOf([], 5).wallMs).toBe(0)
})

test('breaks Heads down per engine, and names the mix only when there is one', async () => {
  const list = [
    run('a', { engine: 'agy', tokens: '1k in / 100 out' }),
    run('b', { engine: 'codex', tokens: '2k in / 200 out' }),
    run('c', { engine: 'codex', costUsd: 0.5 }),
    run('d', {}),
  ]
  const mix = engineMixOf(list, 'commandcode')
  expect(mix.map(item => [item.engine, item.count])).toEqual([['codex', 2], ['commandcode', 1], ['agy', 1]])
  expect(mix[0]).toMatchObject({ tokens: 2_200, usd: 0.5, hasUsd: true })
  expect(engineMixText(list, 'commandcode')).toBe('codex 2 · commandcode 1 · agy 1')
  expect(engineMixText([list[0]!, list[0]!], 'commandcode')).toBe('')
  expect(engineMixText([], 'commandcode')).toBe('')
  // Equal counts keep the order engines are declared in.
  const order = ENGINES.slice(0, 2).map(engine => run(`h-${engine}`, { engine }))
  expect(engineMixOf([...order].reverse()).map(item => item.engine)).toEqual(ENGINES.slice(0, 2))
})

test('lays each Head across the timeline from its start to its end', async () => {
  const list = [
    run('a', { startedAt: 0, endedAt: 50_000 }),
    run('b', { startedAt: 50_000, endedAt: 100_000 }),
    run('c', { state: 'running', startedAt: 75_000 }),
    run('d', { state: 'queued' }),
  ]
  const span = timelineSpan(list, 100_000)
  expect(span).toEqual({ start: 0, end: 100_000 })
  expect(timelineBar(list[0]!, span, 20, 100_000)).toEqual({ before: 0, bar: 10, after: 10 })
  expect(timelineBar(list[1]!, span, 20, 100_000)).toEqual({ before: 10, bar: 10, after: 0 })
  // A running Head's bar reaches the present.
  expect(timelineBar(list[2]!, span, 20, 100_000)).toEqual({ before: 15, bar: 5, after: 0 })
  // A queued one has not started: no bar.
  expect(timelineBar(list[3]!, span, 20, 100_000)).toEqual({ before: 0, bar: 0, after: 20 })

  for (const width of [1, 6, 19, 40]) {
    for (const item of list.slice(0, 3)) {
      const cells = timelineBar(item, span, width, 100_000)
      expect(cells.before + cells.bar + cells.after).toBe(width)
      expect(cells.bar).toBeGreaterThanOrEqual(1)
    }
  }
})

test('draws an instant Head one cell wide and never past the edge', async () => {
  const quick = run('q', { startedAt: 99_990, endedAt: 99_991 })
  const span = timelineSpan([run('s', { startedAt: 0, endedAt: 100_000 }), quick], 100_000)
  expect(timelineBar(quick, span, 30, 100_000)).toEqual({ before: 29, bar: 1, after: 0 })
  // A lone Head that just started still has a span to be drawn on.
  expect(timelineSpan([run('n', { state: 'running', startedAt: 5_000 })], 5_000)).toEqual({ start: 5_000, end: 6_000 })
  expect(timelineSpan([], 7)).toEqual({ start: 7, end: 1_007 })
})

test('fits the timeline and the band rows into 40 columns', async () => {
  for (const columns of [30, 40, 60, 80, 120]) {
    const { nameWidth, barWidth } = timelineLayout(columns)
    // glyph and space, name and space, the bar, a space and the 5-cell elapsed time.
    expect(2 + nameWidth + 1 + barWidth + 6).toBeLessThanOrEqual(Math.max(columns, 2 + nameWidth + 1 + 6 + 6 + 6))
    for (const isRouted of [false, true]) {
      const layout = bandLayout(columns, isRouted)
      // Leave the activity at least a dozen cells, from 40 columns up.
      if (columns >= 40) expect(columns - layout.fixed).toBeGreaterThanOrEqual(12)
      expect(layout.engineWidth > 0).toBe(isRouted)
    }
  }
  expect(timelineLayout(40).barWidth).toBe(18)
  expect(timelineLayout(200).barWidth).toBe(40)
  expect(bandLayout(40, true)).toMatchObject({ showEffort: false, showBar: false, showTurns: false })
  expect(bandLayout(100, true)).toMatchObject({ showEffort: true, showBar: true, showTurns: true })
  expect(timelineRowCount(20, 30)).toBe(4)
  expect(timelineRowCount(8, 30)).toBe(3)
  expect(timelineRowCount(80, 30)).toBe(10)
  expect(timelineRowCount(80, 2)).toBe(2)
  expect(fitText('login-tests-and-more', 10)).toBe('login-tes…')
  expect(fitText('api', 6)).toBe('api   ')
})

test('uses the configured engine when it is ready, else whichever engines are', async () => {
  const [first, second, third] = ENGINES as readonly Engine[]
  // The configured engine is ready: as before, even with others ready.
  expect(onboardingPlan(second!, [first!, second!, third!])).toEqual({ kind: 'fixed', engine: second, isFallback: false })
  expect(onboardingPlan(first!, [first!])).toEqual({ kind: 'fixed', engine: first, isFallback: false })
  // Not ready: one other engine is used alone, several become an auto pool in ENGINES order.
  expect(onboardingPlan(first!, [third!])).toEqual({ kind: 'fixed', engine: third, isFallback: true })
  expect(onboardingPlan(first!, [third!, second!])).toEqual({ kind: 'auto', pool: [second, third] })
  // Auto setting: one ready engine runs alone, two or more are the pool, none shows the setup card.
  expect(onboardingPlan(AUTO, [second!])).toEqual({ kind: 'fixed', engine: second, isFallback: true })
  expect(onboardingPlan(AUTO, [third!, first!])).toEqual({ kind: 'auto', pool: [first, third] })
  expect(onboardingPlan(AUTO, [...ENGINES])).toEqual({ kind: 'auto', pool: [...ENGINES] })
  expect(onboardingPlan(AUTO, [])).toEqual({ kind: 'setup' })
  expect(onboardingPlan(first!, [])).toEqual({ kind: 'setup' })
  expect(onlyReadyNote('codex')).toBe(`Using ${ENGINE_LABEL.codex} (the only engine ready here).`)
})

test('shows a short setup card with the recommended engines first when none is ready', async () => {
  const skipped = ENGINES.map(engine => ({ engine, problem: INSTALL_HINT[engine] }))
  const card = setupCard(skipped)
  const lines = card.split('\n')
  expect(lines.length).toBeLessThanOrEqual(12)
  expect(lines.at(-1)).toBe('Then run /hydra again.')
  for (const engine of ENGINES) expect(card).toContain(ENGINE_LABEL[engine])
  // Each engine says what to run, without repeating "is not installed" per line.
  expect(card).toContain('npm i -g @openai/codex')
  expect(card).not.toContain('is not installed')
  // The recommended engines come first, with why.
  const place = (engine: Engine) => lines.findIndex(line => line.includes(ENGINE_LABEL[engine]))
  expect(card).toContain('Codex (uses your ChatGPT plan)')
  const recommended = ENGINES.filter(engine => engine === 'codex' || (engine as string) === 'opencode')
  const others = ENGINES.filter(engine => !recommended.includes(engine))
  for (const engine of recommended) for (const other of others) expect(place(engine)).toBeLessThan(place(other))
  if ((ENGINES as readonly string[]).includes('opencode')) expect(card).toContain('free models, no account needed')

  // An engine that is installed but signed out keeps its own instruction.
  const mixed = setupCard([{ engine: 'codex', problem: 'Codex is not signed in. Run `codex login` in a terminal, then try again.' }])
  expect(mixed).toContain('Codex is not signed in')
  expect(mixed).toContain(INSTALL_HINT.commandcode.replace(/^The .+? CLI is not installed\. /, ''))

  // One problem shared by every engine (no git) is said once.
  const shared = setupCard(ENGINES.map(engine => ({ engine, problem: 'git is missing. Install it (on macOS: `xcode-select --install`).' })))
  expect(shared.split('\n')).toHaveLength(3)
  expect(shared).toContain('git is missing')
})

/** A `$` with only the plugin store, kept in memory: all `takeWelcome` touches. */
const withStore = (entries: Record<string, unknown> = {}) => {
  const kept = new Map(Object.entries(entries))
  return { store: { get: async (key: string) => kept.get(key), set: async (key: string, value: unknown) => void kept.set(key, value) } } as unknown as EngineInterface
}

test('welcomes a person once, the first time Hydra turns on', async () => {
  const $ = withStore()
  const first = await takeWelcome($)
  expect(first.split('\n').filter(Boolean)).toEqual(WELCOME_LINES)
  expect(WELCOME_LINES).toHaveLength(3)
  expect(first).toContain('/heads')
  expect(first).toContain('/hydra off')
  expect(await takeWelcome($)).toBe('')
  expect(await $.store.get('welcomed-v1')).toBe(true)
})

test('does not welcome someone who was welcomed before', async () => {
  expect(await takeWelcome(withStore({ 'welcomed-v1': true }))).toBe('')
})

test('help lists the engines Hydra has and the first-run behaviour', async () => {
  for (const engine of ENGINES) expect(HYDRA_HELP).toContain(engine)
  expect(HYDRA_HELP).toContain('/hydra                 turn Hydra on, on the engines ready here')
  expect(HYDRA_HELP.split('\n').length).toBeLessThanOrEqual(16)
})

// ---- the views, mounted on both surfaces ----

const NOW = 1_000_000
const scroll = { offset: 0, bodyRows: 40 }

const RUNS: HeadRun[] = [
  run('api-client', { engine: 'codex', model: 'gpt-6.1-sol', effort: 'low', tokens: '91.5k in / 421 out', turns: 14, maxTurns: 150, edits: 4, startedAt: NOW - 240_000, endedAt: NOW - 120_000 }),
  run('prefs-utils', { engine: 'agy', model: 'gemini-3.8-flash', effort: 'medium', tokens: '12k in / 800 out', turns: 9, maxTurns: 150, edits: 3, startedAt: NOW - 200_000, endedAt: NOW - 20_000 }),
  run('login-tests', { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', state: 'running', turns: 7, maxTurns: 150, edits: 5, denials: 1, activity: 'edit LoginViewModelTest.kt', startedAt: NOW - 100_000 }),
  run('flaky-spec', { engine: 'agy', model: 'gemini-3.8-flash', state: 'failed', turns: 2, maxTurns: 150, startedAt: NOW - 50_000, endedAt: NOW - 40_000 }),
  run('docs-pass', { engine: 'commandcode', state: 'queued', maxTurns: 60, costUsd: 0.0336 }),
]

/** Stands in for the engine: the runs, the mode, the views' clock, and the engine's own empty band. */
const serve = (on: On, values: Record<string, unknown>) => {
  on('state.get', ($, e, next) => {
    if (e.plugin === 'hydra' && e.key in values) return Promise.resolve({ value: { value: values[e.key], version: 1 } })
    return next(e)
  })
}

const AUTO_MODE = { isOn: true, headModel: 'gpt-6.1-sol', effort: 'auto', engine: 'auto', engines: ['codex', 'agy', 'commandcode'] }

/** A drawn tree as text lines: a column Box stacks its children, any other Box and a Text run across; a Button shows its label. */
const linesOf = (node: unknown): string[] => {
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (!node || typeof node !== 'object') return []
  const element = node as { type?: string; props?: { label?: string; flexDirection?: string }; children?: unknown[] }
  if (element.type === 'Button') return [element.props?.label ?? '']
  const children = element.children ?? []
  if (element.type === 'Box' && element.props?.flexDirection === 'column') return children.flatMap(linesOf)
  return [children.map(child => linesOf(child).join('')).join('')]
}

const paneProps = (bodyColumns: number) => ({ title: 'Heads', isFocused: true, bodyColumns, placement: 'dock' as const, scroll, view: {} })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`/heads shows the totals, the engine mix and a timeline row per Head (${surface})`, async ($, on) => {
    serve(on, { runs: RUNS, tick: NOW, mode: AUTO_MODE })
    const pane = await $.ui.mount({ plugin: 'hydra', surface, component: 'Pane', requestId: 'hydra-heads', props: paneProps(80) })
    const lines = linesOf(await pane.drawn())
    const text = lines.join('\n')
    expect(text).toContain('1 running · 1 queued · 2 done · 1 failed · 4:00 wall')
    expect(text).toContain('12 edits · 1 denied · 105k tok · $0.0336')
    expect(text).toContain('codex 2 · agy 2 · commandcode 1')
    expect(text).toContain('Timeline')
    expect(text).toContain('4:00 span')
    const rows = lines.filter(line => /[━─┄]/.test(line))
    expect(rows).toHaveLength(RUNS.length)
    // Oldest first; each bar is drawn on the track and ends with the Head's elapsed time.
    expect(rows[0]).toMatch(/^✓ api-client\s+━+─+\s+2:00$/)
    expect(rows[2]).toMatch(/login-tests\s+─+━+\s+1:40$/)
    expect(rows[3]).toMatch(/flaky-spec\s+─+━+─+\s+0:10$/)
    expect(rows[4]).toMatch(/^◌ docs-pass\s+┄+\s+–$/)
    // The per-Head detail and the stop button still work beside it.
    expect(text).toContain('Stop login-tests')
    expect(text).toContain('1-9 or j/k to pick a Head, s to stop it')
    await $.ui.press({ plugin: 'hydra', key: 'pick-flaky-spec', surface })
    const picked = linesOf(await pane.drawn()).join('\n')
    expect(picked).not.toContain('Stop flaky-spec')
    expect(picked).toContain('flaky-spec · gemini-3.8-flash')
  })
}

test('/heads names no engine mix while one engine did all the work, and keeps its timeline inside 40 columns', async ($, on) => {
  serve(on, { runs: RUNS.filter(item => item.engine === 'codex'), tick: NOW, mode: AUTO_MODE })
  const pane = await $.ui.mount({ plugin: 'hydra', surface: 'terminal', component: 'Pane', requestId: 'hydra-heads', props: paneProps(40) })
  const lines = linesOf(await pane.drawn())
  expect(lines.join('\n')).not.toContain('codex 2')
  for (const line of lines.filter(item => /[━─┄]/.test(item))) expect(line.length).toBeLessThanOrEqual(40)
})

test('/heads says there is nothing to show before any Head ran', async ($, on) => {
  serve(on, { runs: [], tick: NOW, mode: null })
  const pane = await $.ui.mount({ plugin: 'hydra', surface: 'terminal', component: 'Pane', requestId: 'hydra-heads', props: paneProps(80) })
  const text = linesOf(await pane.drawn()).join('\n')
  expect(text).toContain('No Heads in this session yet')
  expect(text).not.toContain('Timeline')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the band shows the engine on every row in auto mode, and the live total (${surface})`, async ($, on) => {
    serve(on, { runs: RUNS, tick: NOW, mode: AUTO_MODE })
    const band = await $.ui.mount({
      plugin: 'hydra', surface, component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 100, scroll, view: {} },
    })
    const lines = linesOf(await band.drawn())
    // Live Heads: the running, the queued and the two that ended in the last minute.
    expect(lines[0]).toBe('🐉 Hydra 1 running · 1 queued · 1 done · 1 failed · 13k tok · $0.0336 · /heads for detail')
    expect(lines).toHaveLength(1 + 4)
    const rowOf = (id: string) => lines.find(line => line.includes(id))!
    expect(rowOf('login-tests')).toContain('codex')
    expect(rowOf('prefs-utils')).toContain('agy')
    expect(rowOf('docs-pass')).toContain('commandcode')
    expect(rowOf('login-tests')).toContain('edit LoginViewModelTest.kt')
  })
}

test('the band drops columns, not rows, on a narrow screen', async ($, on) => {
  serve(on, { runs: RUNS, tick: NOW, mode: AUTO_MODE })
  const band = await $.ui.mount({
    plugin: 'hydra', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 40, scroll, view: {} },
  })
  const lines = linesOf(await band.drawn())
  expect(lines).toHaveLength(1 + 4)
  const row = lines.find(line => line.includes('login-tes'))!
  expect(row).toContain('codex')
  expect(row).not.toContain('/150')
  expect(row).not.toContain('█')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`/hydra-usage lists this session's Heads, tokens and dollars per engine (${surface})`, async ($, on) => {
    mock.clock(on, { now: NOW })
    serve(on, { runs: RUNS, tick: NOW, mode: AUTO_MODE })
    const pane = await $.ui.mount({
      plugin: 'hydra', surface, component: 'Pane', requestId: 'hydra-usage',
      props: { title: 'Usage', isFocused: true, bodyColumns: 80, placement: 'dock', scroll, view: {} },
    })
    const lines = linesOf(await pane.drawn())
    expect(lines).toContain('This session')
    const line = (name: string) => lines.find(item => item.startsWith(name) && item.includes('Head'))!
    expect(line(ENGINE_LABEL.codex)).toContain('2 Heads')
    expect(line(ENGINE_LABEL.codex)).toContain('92k tok')
    expect(line(ENGINE_LABEL.agy)).toContain('13k tok')
    expect(line(ENGINE_LABEL.commandcode)).toContain('1 Head · $0.0336')
  })
}
