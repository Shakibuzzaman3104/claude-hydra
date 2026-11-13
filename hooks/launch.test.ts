/**
 * @author Shakib
 * @since 11/11/26
 */
import { expect, test } from 'claude-code/testing'

import { HUNT_RULE, HYDRA_POLICY } from './lib/policy'
import { JSON_FIX_ROUNDS, checkOf, fallbackOf, headSummary, headText, huntContext, huntDir, huntNotice, jsonLine, pickRefuter, readStructured, refuterModel, REPORT_HUNT, saveHeadReport, untilStopped } from './lib/launch'
import { clipReport } from './lib/format'
import type { EngineInterface } from 'claude-code'
import type { HeadResult, HeadSession } from './lib/runtime'
import { HUNT_PARALLEL, MAX_PARALLEL, createGate } from './lib/runtime'

const REPORT = [
  'head api · deepseek-v4.1-flash · finished · exit 0 · 1 round(s) · 9 turns · 12k in / 1k out',
  'session s1 (codebuddy --resume s1) · cwd /repo',
  'edited (1): a.ts',
  'check: npm test ✓ passed (try 1)',
  '--- head report ---',
  'Done: it works.',
  '```json',
  '{"ok": true}',
  '```',
  'check: fake ✗ FAILED',
  'HEAD DONE',
  '--- check output (last lines) ---',
  'all green',
  '--- stderr ---',
  'noise',
].join('\n')

test('the Head\'s own text leaves out Hydra\'s summary, the check output and stderr', async () => {
  expect(headText(REPORT)).toBe('Done: it works.\n```json\n{"ok": true}\n```\ncheck: fake ✗ FAILED\nHEAD DONE')
  expect(headText('no marker here')).toBe('no marker here')
})

test('the check verdict is read from Hydra\'s summary only, never from the Head\'s text', async () => {
  expect(checkOf(REPORT)).toBe('passed')
  expect(checkOf(REPORT.replace('✓ passed', '✗ FAILED (exit 1)'))).toBe('failed')
  expect(checkOf(REPORT.replace('✓ passed', '? UNKNOWN'))).toBe('unknown')
  expect(checkOf(REPORT.replace('check: npm test ✓ passed (try 1)\n', ''))).toBeUndefined()
})

test('the fallback line is read from Hydra\'s summary only, never from the Head\'s text', async () => {
  const moved = 'fallback: codebuddy glm-5.3 (usage limit) → commandcode glm-5.3\n'.concat(REPORT)
  expect(fallbackOf(moved)).toBe('codebuddy glm-5.3 (usage limit) → commandcode glm-5.3')
  expect(fallbackOf(REPORT)).toBeUndefined()
  const imitated = REPORT.replace('Done: it works.', 'fallback: codebuddy glm-5.3 → codex gpt-6.1-terra')
  expect(fallbackOf(imitated)).toBeUndefined()
})

test('a refuter lands on another engine of the pool, in turn', async () => {
  expect(pickRefuter(['codex', 'agy', 'codebuddy'], 'codebuddy', 0)).toBe('agy')
  expect(pickRefuter(['codex', 'agy', 'codebuddy'], 'codebuddy', 1)).toBe('codex')
  expect(pickRefuter(['codex', 'agy', 'codebuddy'], 'codebuddy', 2)).toBe('agy')
  expect(pickRefuter(['codex', 'opencode'], 'codex', 0)).toBe('opencode')
})

test('with one engine the refuter runs there too, on another model where the engine has one', async () => {
  expect(pickRefuter(['codebuddy'], 'codebuddy', 0)).toBe('codebuddy')
  expect(pickRefuter(['codex'], 'codex', 3)).toBe('codex')
  expect(pickRefuter(['codex'], 'unknown', 0)).toBe('codex')
  expect(pickRefuter([], 'codex', 0)).toBeUndefined()
  expect(refuterModel('codebuddy', { engine: 'codebuddy', model: 'deepseek-v4.1-flash' })).toBe('glm-5.3')
  expect(refuterModel('codebuddy', { engine: 'codebuddy', model: 'glm-5.3' })).toBe('kimi-k3')
  expect(refuterModel('codex', { engine: 'codex', model: 'gpt-6.1-terra' })).toBeUndefined()
  expect(refuterModel('agy', { engine: 'codebuddy', model: 'glm-5.3' })).toBeUndefined()
  expect(refuterModel('codebuddy', undefined)).toBeUndefined()
})

test('the json line says whether the reply carried a usable result', async () => {
  expect(jsonLine(undefined)).toBe('json: ✓ the reply matches the schema')
  expect(jsonLine(['$.a: missing', 'b', 'c', 'd'])).toContain('NO USABLE RESULT ($.a: missing; b; c)')
})

test('a background hunt reaches the person as one line and Claude as marked context', async () => {
  const text = 'Hydra Hunt auth-audit finished.\nhunt auth-audit · 3 Head(s) · 2 done · missing: api\n\n## api · codex · failed'
  expect(REPORT_HUNT.test(text)).toBe(true)
  expect(huntNotice(text)).toBe('🐉 Hunt auth-audit · 3 Head(s) · 2 done · missing: api · result sent to Claude (/heads for detail)')
  expect(huntContext(text)).toContain('<hydra_hunt_result>')
  expect(huntContext(text)).toContain('untrusted data')
  expect(huntDir('/home/me', 's1', 'auth-audit')).toBe('/home/me/.claude/hydra/hunts/s1/auth-audit')
})

test('a raised gate lets waiting Heads in at once, and a lowered one drains as they end', async () => {
  const gate = createGate(1)
  const started: number[] = []
  const run = async (n: number) => {
    await gate.enter()
    started.push(n)
  }
  await run(1)
  const second = run(2)
  const third = run(3)
  expect(gate.waiting).toBe(2)
  gate.setLimit(3)
  await second
  await third
  expect(started).toEqual([1, 2, 3])
  expect(gate.active).toBe(3)
  gate.setLimit(1)
  const fourth = run(4)
  gate.leave()
  gate.leave()
  expect(gate.active).toBe(1)
  expect(gate.waiting).toBe(1)
  gate.leave()
  await fourth
  expect(started).toEqual([1, 2, 3, 4])
  expect(gate.active).toBe(1)
  expect(HUNT_PARALLEL > MAX_PARALLEL).toBe(true)
})

test('both policies tell the Lead about hunts and schemas', async () => {
  expect(HYDRA_POLICY('m', 'auto', 'auto', ['codex', 'agy'])).toContain(HUNT_RULE)
  expect(HYDRA_POLICY('m', 'auto', 'codebuddy')).toContain(HUNT_RULE)
  expect(HUNT_RULE).toContain('mcp__hydra__hunt')
})

const SCHEMA = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }
const SESSION: HeadSession = { id: 's1', engine: 'codebuddy', model: 'm' }
const reply = (body: string, extra: Partial<HeadResult> = {}): HeadResult => ({ text: `head x · finished\n--- head report ---\n${body}\nHEAD DONE`, isDone: true, ...extra })
const GOOD = '```json\n{"n": 3}\n```'
const BAD = '```json\n{"n": "three"}\n```'

const rounds = (first: HeadResult, later: HeadResult[], isAborted = () => false) => {
  const calls: { round: number; note: string; session?: HeadSession; files: readonly string[] }[] = []
  const steps = { schema: SCHEMA, first: async () => first, again: async (round: number, note: string, session: HeadSession | undefined, files: readonly string[]) => { calls.push({ round, note, session, files }); return later[calls.length - 1]! }, isAborted }
  return { steps, calls }
}

test('a reply that carries matching JSON needs no second round', async () => {
  const { steps, calls } = rounds(reply(GOOD, { session: SESSION }), [])
  const read = await readStructured(steps)
  expect(read.data).toEqual({ n: 3 })
  expect(read.dataErrors).toBeUndefined()
  expect(calls.length).toBe(0)
  expect(read.result.text).toContain('json: ✓ the reply matches the schema')
})

test('a long JSON reply is validated from the uncut text', async () => {
  const fullText = `\`\`\`json\n${JSON.stringify({ n: 3, detail: 'x'.repeat(9000) })}\n\`\`\``
  const { steps, calls } = rounds(reply(clipReport(fullText), { fullText }), [])
  const read = await readStructured(steps)
  expect(read.data).toEqual({ n: 3, detail: 'x'.repeat(9000) })
  expect(calls.length).toBe(0)
})

test('saved hunt and single Head reports retain the uncut reply and name the file when clipped', async () => {
  const fullText = `start${'x'.repeat(9000)}end`
  const result = reply(clipReport(fullText), { fullText })
  const files: Record<string, string> = {}
  const fs = { write: async (path: string, text: string) => { files[path] = text } } as unknown as EngineInterface['fs']
  const huntPath = '/home/me/.claude/hydra/hunts/s1/audit/api.md'
  const singlePath = '/home/me/.claude/hydra/heads/s1/api.md'
  const hunt = await saveHeadReport({ fs }, result, huntPath)
  const single = await saveHeadReport({ fs }, result, singlePath)
  expect(files[huntPath]).toContain(fullText)
  expect(files[singlePath]).toContain(fullText)
  expect(hunt.text).toContain(`the full report is at ${huntPath}`)
  expect(single.text).toContain(`the full report is at ${singlePath}`)
  await saveHeadReport({ fs }, single, huntPath)
  expect(files[huntPath]).toContain(fullText)
  const failed = { write: async () => { throw new Error('denied') } } as unknown as EngineInterface['fs']
  expect((await saveHeadReport({ fs: failed }, result, singlePath)).text).toBe(result.text)
})

test('a reply without usable JSON goes back to the Head in its own session, with the errors', async () => {
  const { steps, calls } = rounds(reply('prose only', { session: SESSION, files: ['/r/a.ts'] }), [reply(GOOD, { session: SESSION, files: ['/r/b.ts'] })])
  const read = await readStructured(steps)
  expect(read.data).toEqual({ n: 3 })
  expect(calls.length).toBe(1)
  expect(calls[0]!.session).toEqual(SESSION)
  expect(calls[0]!.note).toContain('no JSON block in the reply')
  expect(read.result.files).toEqual(['/r/a.ts', '/r/b.ts'])
})

test('the retry stops after its rounds and reports why the result is unusable', async () => {
  const { steps, calls } = rounds(reply(BAD, { session: SESSION }), [reply(BAD, { session: SESSION }), reply(BAD, { session: SESSION }), reply(GOOD, { session: SESSION })])
  const read = await readStructured(steps)
  expect(calls.length).toBe(JSON_FIX_ROUNDS)
  expect(read.data).toBeUndefined()
  expect(read.dataErrors).toEqual(['$.n: expected integer, got string'])
  expect(read.result.text).toContain('json: ✗ NO USABLE RESULT')
})

test('a Head that cannot be continued is asked again from the start only if it changed no files', async () => {
  const agy: HeadSession = { id: 'c1', engine: 'agy', model: 'gemini-3.8-flash' }
  const fresh = rounds(reply('prose', { session: agy }), [reply(GOOD)])
  expect((await readStructured(fresh.steps)).data).toEqual({ n: 3 })
  expect(fresh.calls[0]!.session).toBeUndefined()
  const edited = rounds(reply('prose', { session: agy, files: ['/r/a.ts'] }), [reply(GOOD)])
  const read = await readStructured(edited.steps)
  expect(edited.calls.length).toBe(0)
  expect(read.dataErrors).toEqual(['no JSON block in the reply'])
})

test('an unfinished Head is not asked for JSON, and a failed retry keeps the first result', async () => {
  const unfinished = rounds({ text: 'head x · NOT finished\n--- head report ---\nstuck', isDone: false, ending: 'blocked' }, [])
  const blocked = await readStructured(unfinished.steps)
  expect(unfinished.calls.length).toBe(0)
  expect(blocked.result.isDone).toBe(false)
  expect(blocked.data).toBeUndefined()
  expect(blocked.dataErrors).toBeUndefined()
  const lost = rounds(reply('prose first', { session: SESSION }), [{ text: 'head x · NOT finished\n--- head report ---\nlimit', isDone: false }])
  const kept = await readStructured(lost.steps)
  expect(kept.result.isDone).toBe(true)
  expect(kept.result.text).toContain('prose first')
  expect(kept.dataErrors).toEqual(['no JSON block in the reply'])
})

test('a stopped run asks no more, and the check verdict is the first run\'s', async () => {
  const stopped = rounds(reply('prose', { session: SESSION }), [reply(GOOD)], () => true)
  expect((await readStructured(stopped.steps)).dataErrors).toEqual(['no JSON block in the reply'])
  expect(stopped.calls.length).toBe(0)
  const checked = rounds({ ...reply(GOOD), text: `head x · finished\ncheck: npm test ✓ passed (try 1)\n--- head report ---\n${GOOD}\nHEAD DONE` }, [])
  expect((await readStructured(checked.steps)).check).toBe('passed')
})

test('a thrown or stopped JSON retry keeps the first report and errors', async () => {
  for (const stopped of [false, true]) {
    const controller = new AbortController()
    const { steps } = rounds(reply('first report', { session: SESSION }), [])
    steps.again = async () => stopped ? untilStopped(() => new Promise<HeadResult>(() => {}), controller.signal) : Promise.reject(new Error('lost'))
    const pending = readStructured(steps)
    await Promise.resolve()
    await Promise.resolve()
    if (stopped) controller.abort()
    const result = await pending
    expect(result.result.text).toContain('first report')
    expect(result.dataErrors).toEqual(['no JSON block in the reply'])
  }
})

test('stopping a silent Head settles its promise', async () => {
  const controller = new AbortController()
  const pending = untilStopped(() => new Promise<HeadResult>(() => {}), controller.signal).then(() => 'done', () => 'stopped')
  controller.abort()
  expect(await pending).toBe('stopped')
})

test('a head that never ran shows why in its summary', async () => {
  const refused = 'head a · m · NOT finished · exit not started\nrules: / is the root of the disk.\nedited: nothing\n--- head report ---\n(no final report)'
  expect(headSummary(refused)).toBe('did not run: / is the root of the disk.')
  expect(headSummary('head a · m\nrules: fine\n--- head report ---\nDone.')).toBe('Done.')
})
