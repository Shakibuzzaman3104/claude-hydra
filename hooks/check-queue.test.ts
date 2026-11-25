/**
 * @author Shakib
 * @since 25/11/26
 */
import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { runCheck } from './lib/check'

const deferred = () => {
  let resolve = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const fake = (run: (cwd: string) => Promise<void>) => ({
  env: { get: async () => undefined },
  clock: { now: async () => 0 },
  process: { run: async (argv: string[], options?: { cwd?: string }) => {
    if (argv[0] === 'git') return { exitCode: 0, stdout: argv[2]?.split('/').slice(0, 3).join('/') ?? '', stderr: '' }
    if (argv[0] === 'uname') return { exitCode: 0, stdout: 'Linux', stderr: '' }
    if (argv[0] === 'python3' && argv.includes('--version')) return { exitCode: 0, stdout: 'Python 3.9', stderr: '' }
    if (argv[0] === 'python3') return { exitCode: 0, stdout: JSON.stringify([argv[argv.length - 1]]), stderr: '' }
    await run(options?.cwd ?? '')
    return { exitCode: 0, stdout: 'ok', stderr: '' }
  } },
}) as unknown as EngineInterface

test('checks in one project wait for each other', async () => {
  const firstStarted = deferred()
  const release = deferred()
  const waiting = deferred()
  const started: string[] = []
  const $ = fake(async cwd => {
    started.push(cwd)
    if (started.length === 1) { firstStarted.resolve(); await release.promise }
  })
  const first = runCheck($, 'check', '/projects/one/app', 1)
  await firstStarted.promise
  const second = runCheck($, 'check', '/projects/one/lib', 1, { onWait: async () => waiting.resolve() })
  await waiting.promise
  expect(started).toEqual(['/projects/one/app'])
  release.resolve()
  await Promise.all([first, second])
  expect(started).toEqual(['/projects/one/app', '/projects/one/lib'])
})

test('checks in different projects overlap', async () => {
  const both = deferred()
  const release = deferred()
  let active = 0
  const $ = fake(async () => { active++; if (active === 2) both.resolve(); await release.promise })
  const first = runCheck($, 'check', '/projects/one', 1)
  const second = runCheck($, 'check', '/projects/two', 1)
  await both.promise
  expect(active).toBe(2)
  release.resolve()
  await Promise.all([first, second])
})

test('a thrown check and an aborted waiter release the queue', async () => {
  const started = deferred()
  const release = deferred()
  const waiting = deferred()
  let calls = 0
  const $ = fake(async () => {
    calls++
    if (calls === 1) { started.resolve(); await release.promise; throw new Error('stopped') }
  })
  const first = runCheck($, 'check', '/projects/one', 1)
  await started.promise
  const controller = new AbortController()
  const second = runCheck($, 'check', '/projects/one', 1, { signal: controller.signal, onWait: async () => waiting.resolve() })
  await waiting.promise
  controller.abort()
  const third = runCheck($, 'check', '/projects/one', 1)
  release.resolve()
  const outcomes = await Promise.all([first, second, third])
  expect(outcomes.map(outcome => outcome.kind)).toEqual(['unknown', 'unknown', 'passed'])
  expect(calls).toBe(2)
})
