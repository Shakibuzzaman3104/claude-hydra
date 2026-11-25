/**
 * @author Shakib
 * @since 25/11/26
 */
import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { codexArgs, codexEffort, codexFilesystem, foldCodexRow, newCodexState } from './engines/codex'
import { commandOf, resetPlatform } from './lib/platform'

test('limits Codex effort to supported levels', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) expect(codexEffort(effort)).toBe(effort)
  for (const effort of ['off', '', 'unknown']) expect(codexEffort(effort)).toBe('low')
  expect(codexEffort('ultra')).toBe('max')
  expect(codexArgs({ prompt: 'work', model: 'gpt-6', maxTurns: 1, cwd: '/app', addDirs: [], effort: 'ultra', filesystem: '{}' }).join(' ')).toContain('model_reasoning_effort="max"')
})

test('distinguishes failed commands from refused calls', () => {
  const state = newCodexState()
  const failed = foldCodexRow({ type: 'item.completed', item: { id: '1', type: 'command_execution', command: 'go test ./cmd/api', status: 'failed', exit_code: 1, aggregated_output: 'mkdir /tmp/wfpg: operation not permitted' } }, state)
  expect(failed.map(event => event.type)).toContain('tool_completed')
  expect(failed.map(event => event.type)).not.toContain('tool_denied')
  expect(state.denied).toEqual([{ tool: 'sandbox', target: 'go test ./cmd/api', text: 'mkdir /tmp/wfpg: operation not permitted' }])
  const refused = foldCodexRow({ type: 'item.completed', item: { id: '2', type: 'command_execution', command: 'cat secret', status: 'declined', exit_code: null, aggregated_output: 'approval rejected' } }, state)
  expect(refused.map(event => event.type)).toContain('tool_denied')
  expect(state.denied.map(entry => entry.tool)).toEqual(['sandbox', 'shell_command'])
  foldCodexRow({ type: 'item.completed', item: { id: '3', type: 'command_execution', command: 'cat nope', status: 'failed', exit_code: 1, aggregated_output: 'cat: nope: No such file or directory' } }, state)
  expect(state.denied).toHaveLength(2)
})

test('grants only the supplied skill folders read access', () => {
  const profile = codexFilesystem('/home/me/app', { addDirs: [], writeDirs: [], shell: true }, '/home/me', ['.agents/skills', '.codex/skills'])
  expect(profile).toContain('"/home/me/.agents/skills"="read"')
  expect(profile).toContain('"/home/me/.codex/skills"="read"')
  expect(profile).toContain('"/home/me/.codex"="none"')
  expect(profile).not.toContain('"/home/me/.codex/skills"="write"')
})

test('finds the newest packaged Codex when PATH fails and caches it', async () => {
  resetPlatform()
  let pathWorks = true
  const calls: string[] = []
  const root = '/home/me/.codex/packages'
  const $ = {
    env: { get: async (name: string) => name === 'HOME' ? '/home/me' : '' },
    process: { run: async (argv: string[]) => {
      calls.push(argv.join(' '))
      return { exitCode: argv[0] === 'codex' && !pathWorks ? 1 : 0, stdout: argv[0] === 'uname' ? 'Darwin' : '', stderr: '' }
    } },
    fs: {
      list: async (path: string) => path === root ? [{ name: 'pkg', kind: 'dir' }] : path === `${root}/pkg/releases` ? [
        { name: '0.99.0-arm', kind: 'dir' }, { name: '0.166.0-arm', kind: 'dir' }, { name: '0.163.0-arm', kind: 'dir' },
      ] : [],
      exists: async (path: string) => path.endsWith('/bin/codex'),
    },
  } as unknown as EngineInterface
  expect(await commandOf($, 'codex')).toEqual(['codex'])
  pathWorks = false
  const newest = `${root}/pkg/releases/0.166.0-arm/bin/codex`
  expect(await commandOf($, 'codex')).toEqual([newest])
  const count = calls.length
  expect(await commandOf($, 'codex')).toEqual([newest])
  expect(calls.length).toBe(count)
  resetPlatform()
})
