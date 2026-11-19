/**
 * @author Shakib
 * @since 19/11/26
 */
import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { findEnvFile, PROJECT_DENY, runRound, SEARCH_DENY, sessionReport } from './engines/commandcode'
import { resetPlatform } from './lib/platform'
import { runRounds } from './lib/rounds'

/** A process whose output is delivered as Command Code's JSON lines. */
const stream = (lines: object[], after?: () => void) => {
  const child = {
    index: 0,
    result: Promise.resolve({ code: 0 }),
    async next() {
      if (this.index < lines.length) return { done: false, value: { stream: 'stdout', text: JSON.stringify(lines[this.index++]) + '\n' } }
      after?.()
      return { done: true, value: undefined }
    },
    async return() { return { done: true, value: undefined } },
  }
  return { env: { get: async () => undefined }, process: { run: async () => ({ stdout: 'Darwin\n', exitCode: 0 }), spawn: () => child } } as unknown as EngineInterface
}

const args = { prompt: 'task', model: 'm', maxTurns: 10, cwd: '/p', addDirs: [] }
const start = (id: string) => ({ type: 'event', event: { type: 'run_start', sessionId: id } })
const end = (text: string) => ({ type: 'event', event: { type: 'run_end', result: { finalText: text } } })

test('parallel streams retain their own session and text even when the result names another session', async () => {
  resetPlatform()
  const seen: string[] = []
  const run = (id: string, other: string) => runRound(stream([start(id), end(`report ${id}`), { type: 'result', sessionId: other, finalText: `report ${other}`, subtype: 'success' }]), args, new AbortController().signal, async () => undefined, async session => { seen.push(session) })
  const [a, b] = await Promise.all([run('a', 'b'), run('b', 'a')])
  expect([a.sessionId, a.finalText, b.sessionId, b.finalText]).toEqual(['a', 'report a', 'b', 'report b'])
  expect(seen.sort()).toEqual(['a', 'b'])
  const unknown = await runRound(stream([{ type: 'result', sessionId: 'other', finalText: 'other report' }]), args, new AbortController().signal, async () => undefined)
  expect([unknown.sessionId, unknown.finalText]).toEqual([undefined, ''])
  resetPlatform()
})

test('a timeout retains the streamed session and resumes it for a handoff', async () => {
  resetPlatform()
  const outer = new AbortController()
  let timeout: (() => void) | undefined
  const resumes: (string | undefined)[] = []
  const ended = await runRounds({
    task: 'task', maxTurns: 10, minutes: 30, outer: outer.signal, turns: () => 0, calls: () => 0, denied: () => [],
    sleep: (_ms, signal) => new Promise<void>((resolve, reject) => { if (!timeout) timeout = resolve; signal.addEventListener('abort', reject, { once: true }) }),
    runRound: async (round, signal) => {
      resumes.push(round.resume)
      if (round.resume) return { finalText: 'handoff', sessionId: round.resume, code: 0, subtype: 'success', errors: '' }
      return runRound(stream([start('own')], () => timeout?.()), { ...args, ...round }, signal, async () => undefined)
    },
  })
  expect(ended.ending).toBe('timeout')
  expect(ended.sessionId).toBe('own')
  expect(ended.round.finalText).toBe('handoff')
  expect(resumes).toEqual([undefined, 'own'])
  resetPlatform()
})

test('session reports request the named transcript and preserve its cost, edits and denials', async () => {
  resetPlatform()
  const requests: string[][] = []
  const $ = { plugin: { root: '/plugin' }, env: { get: async () => undefined }, process: { run: async (argv: string[]) => {
    if (argv[0] === 'uname') return { stdout: 'Darwin\n', exitCode: 0 }
    if (argv.includes('--version')) return { stdout: 'Python 3.12.0', stderr: '', exitCode: 0 }
    requests.push(argv)
    return { stdout: JSON.stringify({ usd: 0.25, files: ['strings.xml'], denied: [{ tool: 'edit_file', target: '.env', text: 'Blocked by permission deny rule' }], toolCalls: 2 }), exitCode: 0 }
  } } } as unknown as EngineInterface
  const report = await sessionReport($, 'own', 123)
  expect(requests[0]?.slice(-3)).toEqual(['--report', 'own', '123'])
  expect(report).toMatchObject({ usd: 0.25, files: ['strings.xml'], denied: [{ target: '.env' }] })
  resetPlatform()
})

test('only exact environment templates leave search enabled', async () => {
  let names = ['.env.example', '.env.sample', '.env.template', '.env.dist']
  const $ = { process: { run: async (argv: string[]) => {
    const excluded = argv.flatMap((arg, i) => arg === '!' && argv[i + 1] === '-name' ? [argv[i + 2]] : [])
    const found = names.find(name => (name === '.env' || name.startsWith('.env.')) && !excluded.includes(name))
    return { stdout: found ? `/p/${found}\n` : '', exitCode: 0 }
  } } } as unknown as EngineInterface
  expect(await findEnvFile($, ['/p'])).toBeUndefined()
  for (const name of ['.env', '.env.local', '.env.production', '.env.example.local']) {
    names = [name]
    expect(await findEnvFile($, ['/p'])).toBe(`/p/${name}`)
  }
  expect(PROJECT_DENY).toContain('Read(.env.*)')
  expect(SEARCH_DENY).toBe('Grep')
})
