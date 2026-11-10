/**
 * @author Shakib
 * @since 11/11/26
 */
import { expect, test } from 'claude-code/testing'

import { DEFAULT_LENS, HUNT_MAX_HEADS, VERDICT_SCHEMA, fixTask, formatHunt, headKey, parseHunt, refuteTask, runHunt, statusOf, verdictOf } from './lib/hunt'
import type { HeadCall, HeadOutcome, HeadRan, HuntPlan, HuntSteps } from './lib/hunt'

const ran = (extra: Partial<HeadRan> = {}): HeadRan => ({ engine: 'author', isDone: true, files: [], summary: 'done', isResumable: true, ...extra })
const plan = (extra: Partial<HuntPlan> = {}): HuntPlan => ({ name: 'hunt', shared: '', heads: [{ name: 'one', task: 'work' }], fresh: false, ...extra })
const outcome = (extra: Partial<HeadOutcome> = {}): HeadOutcome => ({ name: 'one', engine: 'author', status: 'done', isCached: false, files: [], summary: 'done', ...extra })
const fake = (p: HuntPlan, answers: Record<string, HeadRan | Promise<HeadRan> | Error> = {}) => {
  const calls: HeadCall[] = []
  const saved: string[] = []
  const steps: HuntSteps = {
    plan: p, cache: {},
    runHead: async call => { calls.push(call); const answer = answers[call.name]; if (answer instanceof Error) throw answer; return answer ? await answer : ran() },
    refuterEngine: () => 'reviewer',
    save: async key => { saved.push(key) },
    isAborted: () => false,
  }
  return { steps, calls, saved }
}
const broken = { verdict: 'broken', problems: [{ file: 'a', line: 2, problem: 'wrong', severity: 'high' }], checked: ['a'] }

test('the parser reports invalid hunt names and head lists', async () => {
  expect(parseHunt({ heads: [] })).toEqual({ deny: 'A hunt needs a `name`: lowercase letters, digits and dashes, up to 30 (it names the Heads and the cache).' })
  expect(parseHunt({ name: 'bad!', heads: [] })).toEqual({ deny: 'A hunt needs a `name`: lowercase letters, digits and dashes, up to 30 (it names the Heads and the cache).' })
  expect(parseHunt({ name: 'x', heads: [] })).toEqual({ deny: '`heads` must list 1 to 24 Heads, each with a `task`.' })
  expect(parseHunt({ name: 'x', heads: [null] })).toEqual({ deny: '`heads` must list 1 to 24 Heads, each with a `task`.' })
  expect(parseHunt({ name: 'x', heads: Array.from({ length: HUNT_MAX_HEADS + 1 }, () => ({})) })).toEqual({ deny: 'A hunt takes at most 24 Heads; split it into two hunts.' })
  expect(parseHunt({ name: 'x', heads: [{ task: ' ' }] })).toEqual({ deny: 'Head 1 has no `task`.' })
})

test('head names are normalized unique and avoid reserved endings', async () => {
  expect(parseHunt({ name: 'x', heads: [{ task: 'x', name: 'bad!' }] })).toEqual({ deny: 'Head 1: `name` must be lowercase letters, digits and dashes, up to 20.' })
  expect(parseHunt({ name: 'x', heads: [{ task: 'x', name: 'X-1' }, { task: 'y' }] })).toEqual({ plan: { name: 'x', shared: '', heads: [{ name: 'x-1', task: 'x' }, { name: 'x-2', task: 'y' }], fresh: false } })
  expect(parseHunt({ name: 'x', heads: [{ task: 'x' }, { task: 'y', name: 'X-1' }] })).toEqual({ deny: 'Two Heads are named "x-1"; names must differ.' })
  for (const name of ['a-fix', 'a-r12', 'a-json', 'a-json2']) expect(parseHunt({ name: 'x', heads: [{ name, task: 'x' }] })).toEqual({ deny: `Head 1: the name "${name}" ends like one of the hunt's own follow-up Heads (-fix, -r1, -json); pick another.` })
  expect(parseHunt({ name: 'abcdefghijklmnopq', heads: [{ task: 'x' }] })).toMatchObject({ plan: { heads: [{ name: 'abcdefghijklmnop-1' }] } })
})

test('the parser copies usable fields and handles refute and fresh', async () => {
  const input = { name: ' X ', shared: ' context ', heads: [{ task: ' work ', engine: ' e ', model: ' ', effort: ' high ', check: ' test ', cwd: ' /p ', files: [' a ', '', 1], addDirs: [' '], writeDirs: [' b '], shell: true, checkMinutes: 2, maxTurns: -1, maxMinutes: 3 }], refute: { lenses: [' a ', 'a', 'b'], fix: false }, fresh: true }
  expect(parseHunt(input)).toEqual({ plan: { name: 'x', shared: 'context', heads: [{ name: 'x-1', task: 'work', engine: 'e', effort: 'high', check: 'test', cwd: '/p', files: ['a'], writeDirs: ['b'], shell: true, checkMinutes: 2, maxMinutes: 3 }], refute: { lenses: ['a', 'b'], fix: false }, fresh: true } })
  expect(parseHunt({ name: 'x', heads: [{ task: 'x' }], refute: true })).toMatchObject({ plan: { refute: { lenses: [DEFAULT_LENS], fix: true } } })
  expect(parseHunt({ name: 'x', heads: [{ task: 'x' }], refute: {} })).toMatchObject({ plan: { refute: { lenses: [DEFAULT_LENS], fix: true } } })
  expect(parseHunt({ name: 'x', heads: [{ task: 'x' }], refute: false })).toEqual({ plan: { name: 'x', shared: '', heads: [{ name: 'x-1', task: 'x' }], fresh: false } })
  expect(parseHunt({ name: 'x', heads: [{ task: 'x' }], refute: 1 })).toEqual({ deny: '`refute` must be true or { lenses, fix }.' })
  expect(parseHunt({ name: 'x', heads: [{ task: 'x' }], refute: { lenses: ['a', 'b', 'c', 'd'] } })).toEqual({ deny: '`refute.lenses` takes at most 3.' })
  expect(parseHunt({ name: 'x', heads: [{ task: 'x' }], schema: 2 })).toEqual({ deny: '`schema`: schema must be an object.' })
})

test('job keys are stable and include the task context schema and engine', async () => {
  const p = plan()
  const h = p.heads[0]!
  const key = headKey(p, h)
  expect(key).toEqual(headKey(plan(), { ...h }))
  expect(/^one:[0-9a-f]{8}$/.test(key)).toBe(true)
  for (const other of [headKey(p, { ...h, task: 'other' }), headKey({ ...p, shared: 'context' }, h), headKey({ ...p, schema: { type: 'object' } }, h), headKey(p, { ...h, engine: 'e' })]) expect(other === key).toBe(false)
})

test('status distinguishes all endings and invalid results', async () => {
  expect(statusOf(ran({ check: 'failed' }), false)).toBe('failed')
  expect(statusOf(ran(), true)).toBe('invalid')
  expect(statusOf(ran({ data: {} }), true)).toBe('done')
  expect(statusOf(ran({ isDone: false, ending: 'blocked' }), false)).toBe('blocked')
  for (const ending of ['capped', 'timeout', 'stalled']) expect(statusOf(ran({ isDone: false, ending }), false)).toBe('unfinished')
  expect(statusOf(ran({ isDone: false }), false)).toBe('failed')
})

test('verdicts require usable answers and concrete problems', async () => {
  expect(verdictOf([undefined, {}])).toEqual({ verdict: 'none', problems: [] })
  expect(verdictOf([{ verdict: 'broken', problems: [] }])).toEqual({ verdict: 'unsure', problems: [] })
  expect(verdictOf([{ verdict: 'holds' }, undefined])).toEqual({ verdict: 'holds', problems: [] })
  expect(verdictOf([{ verdict: 'holds' }, { verdict: 'unsure' }])).toEqual({ verdict: 'unsure', problems: [] })
  const problems = Array.from({ length: 20 }, (_, i) => ({ problem: `p${i}` }))
  const result = verdictOf([{ verdict: 'broken', problems: [...problems, problems[0]] }])
  expect(result.verdict).toBe('broken')
  expect(result.problems.length).toBe(15)
  expect(verdictOf([broken, broken]).problems).toEqual(broken.problems)
  expect(result.problems[0]).toEqual({ problem: 'p0', severity: 'medium' })
})

test('prompts describe the work and concrete review problems', async () => {
  expect(refuteTask({ name: 'a', task: 'work' }, 'context', ran({ files: ['a'], data: { x: 1 } }), 'security')).toContain('Context:\ncontext\n\nThe task it was given:\nwork')
  expect(fixTask(broken.problems)).toContain('- [high] a:2: wrong')
})

test('heads run independently and return in plan order', async () => {
  let finish: (value: HeadRan) => void = () => {}
  const slow = new Promise<HeadRan>(resolve => { finish = resolve })
  const p = plan({ heads: [{ name: 'slow', task: 's' }, { name: 'fast', task: 'f' }], refute: { lenses: ['correctness'], fix: false } })
  const f = fake(p, { slow, 'fast-r1': ran({ data: { verdict: 'holds' } }) })
  const pending = runHunt(f.steps)
  await Promise.resolve()
  await Promise.resolve()
  expect(f.calls.map(call => call.name)).toContain('fast-r1')
  finish(ran())
  const result = await pending
  expect(result.outcomes.map(item => item.name)).toEqual(['slow', 'fast'])
  expect(f.calls.find(call => call.name === 'fast-r1')).toMatchObject({ engine: 'reviewer', schema: VERDICT_SCHEMA, effort: 'medium' })
})

test('failures are isolated and only done results are saved', async () => {
  const p = plan({ heads: [{ name: 'one', task: 'a' }, { name: 'two', task: 'b' }] })
  const f = fake(p, { one: new Error('oops') })
  f.steps.save = async key => { f.saved.push(key); throw new Error('save') }
  const result = await runHunt(f.steps)
  expect(result.missing).toEqual(['one'])
  expect(result.outcomes[0]?.summary).toContain('could not run: Error: oops')
  expect(result.outcomes[1]?.status).toBe('done')
  expect(f.saved.length).toBe(1)
})

test('cache hits skip calls while fresh and broken entries run again', async () => {
  const p = plan()
  const key = headKey(p, p.heads[0]!)
  const f = fake(p)
  f.steps.cache = { [key]: outcome() }
  expect((await runHunt(f.steps)).outcomes[0]?.isCached).toBe(true)
  expect(f.calls.length).toBe(0)
  f.steps.plan = { ...p, fresh: true }
  await runHunt(f.steps)
  expect(f.calls.length).toBe(1)
  f.steps.plan = p
  f.steps.cache = { [key]: outcome({ refute: { verdict: 'broken', by: [], problems: [], fixRounds: 0, edited: [] } }) }
  await runHunt(f.steps)
  expect(f.calls.length).toBe(2)
})

test('the author receives shared context and schema and an abort starts nothing', async () => {
  const p = plan({ shared: 'context', schema: { type: 'object' } })
  const f = fake(p, { one: ran({ data: {} }) })
  await runHunt(f.steps)
  expect(f.calls[0]).toMatchObject({ task: 'context\n\nwork', schema: p.schema })
  const stopped = fake(p)
  stopped.steps.isAborted = () => true
  expect((await runHunt(stopped.steps)).missing).toEqual(['one'])
  expect(stopped.calls.length).toBe(0)
})

test('missing refuters produce no verdict', async () => {
  const f = fake(plan({ refute: { lenses: ['x'], fix: true } }))
  f.steps.refuterEngine = () => undefined
  expect((await runHunt(f.steps)).outcomes[0]?.refute).toEqual({ verdict: 'none', by: [], problems: [], fixRounds: 0, edited: [] })
})

test('a broken result is fixed once and reviewed again', async () => {
  const p = plan({ heads: [{ name: 'one', task: 'work', check: 'test' }], refute: { lenses: ['x'], fix: true } })
  const f = fake(p, { one: ran({ files: ['a'], cost: '1' }), 'one-r1': ran({ data: broken, files: ['bad'] }), 'one-fix': ran({ files: ['b'], cost: '2' }), 'one-r1b': ran({ data: broken, files: ['bad2'] }) })
  const result = await runHunt(f.steps)
  expect(f.calls.map(call => call.name)).toEqual(['one', 'one-r1', 'one-fix', 'one-r1b'])
  expect(f.calls[2]).toMatchObject({ resume: 'one', check: 'test' })
  expect(result.outcomes[0]).toMatchObject({ files: ['a', 'b'], cost: '1 + 2', refute: { verdict: 'broken', fixRounds: 1, by: ['reviewer'], edited: ['bad', 'bad2'] } })
})

test('fixing requires permission and a resumable author', async () => {
  for (const [fix, isResumable] of [[false, true], [true, false]] as const) {
    const f = fake(plan({ refute: { lenses: ['x'], fix } }), { one: ran({ isResumable }), 'one-r1': ran({ data: broken }) })
    await runHunt(f.steps)
    expect(f.calls.map(call => call.name)).toEqual(['one', 'one-r1'])
  }
})

test('the formatter reports counts data errors and review findings', async () => {
  const text = formatHunt({ name: 'x', outcomes: [outcome({ isCached: true, data: { ok: true }, refute: { verdict: 'broken', by: ['r'], problems: broken.problems, fixRounds: 1, edited: ['oops'] } }), outcome({ name: 'two', status: 'invalid', dataErrors: ['bad'], summary: 'report' })], missing: ['two'] })
  expect(text).toContain('hunt x · 2 Head(s) · 1 done (1 from cache) · 1 refuted · missing: two')
  expect(text).toContain('data: {"ok":true}')
  expect(text).toContain('no usable JSON: bad\nreport')
  expect(text).toContain('⚠ a refuter changed files though told not to: oops')
  expect(text).toContain('open problems:\n- [high] a:2: wrong')
})

test('long formatted results fit and point to the full report', async () => {
  const text = formatHunt({ name: 'x', outcomes: [outcome({ data: 'x'.repeat(5000), reportPath: '/report' })], missing: [] }, 200)
  expect(text.length).toBeLessThanOrEqual(200)
  expect(text).toContain('… cut: read the full report at /report')
})
