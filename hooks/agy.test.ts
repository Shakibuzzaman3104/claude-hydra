/**
 * @author Shakib
 * @since 19/11/26
 */
import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { AGY_WATCHDOG, agyHungEnding, agySettings, agyShellLine, agyUntrackedNote, foldAgyRow, newAgyState, writeAgyHome } from './engines/agy'
import { AGY_TOKEN } from './lib/engines'

const HOME = '/Users/me'
const TOKEN = `${HOME}/${AGY_TOKEN}`

/** A `$` for one Head's setup: `files` exist, `git` is what `git ls-files` prints, and `runs` and `writes` record what Hydra did. */
const fake = (files: readonly string[] = [], git = '') => {
  const runs: string[][] = []
  const writes: { path: string; text: string }[] = []
  const $ = {
    env: { get: async (name: string) => (name === 'HOME' ? HOME : undefined) },
    session: { id: async () => 's1' },
    clock: { now: async () => 0 },
    fs: {
      exists: async (path: string) => files.includes(path),
      write: async (path: string, text: string) => void writes.push({ path, text }),
    },
    process: {
      run: async (argv: string[]) => {
        runs.push(argv)
        if (argv[0] === '/usr/bin/find') return { exitCode: 1, stdout: '', stderr: '' }
        if (argv[0] === 'git') return { exitCode: 0, stdout: git, stderr: '' }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  } as unknown as EngineInterface
  return { $, runs, writes }
}

const step = (fields: Record<string, unknown>) => ({ event: 'step_update', step_update: { conversation_id: 'c-1', ...fields } })
const run = (command: string, index = 1, state = 'ACTIVE') => step({
  step_index: index, state, step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: command } },
})

test('denies the command tool to a Head with no shell, and allows it with one', async () => {
  const none = agySettings('/p/app', { addDirs: [], shell: false })
  expect(none.permissions.deny).toContain('command(*)')
  expect(none.permissions.allow).not.toContain('command(*)')

  const shell = agySettings('/p/app', { addDirs: [], shell: true })
  expect(shell.permissions.allow).toContain('command(*)')
  expect(shell.permissions.deny).not.toContain('command(*)')

  // The file a Head runs with carries the same deny.
  const { $, writes } = fake([TOKEN])
  await writeAgyHome($, '/p/app', 'h1', { addDirs: [], shell: false })
  const written = JSON.parse(writes.find(write => write.path.endsWith('/settings.json'))!.text) as { permissions: { deny: string[] } }
  expect(written.permissions.deny).toContain('command(*)')
})

test('prints the command a refused call tried to run, cut to 120 characters', () => {
  const state = newAgyState()
  const command = 'python3 -c "import urllib.request; print(urllib.request.urlopen(\'https://example.com\').read())"'
  foldAgyRow(run(command), state)
  foldAgyRow({ event: 'result', result: { status: 'ERROR', denied_actions: [{ action: 'run_command', display_name: 'RunCommand' }] } }, state)

  expect(state.denied).toHaveLength(1)
  expect(state.denied[0]!.target).toBe(command)
  expect(state.denied[0]!.text).toContain(command.slice(0, 120))

  const long = newAgyState()
  const wide = `ls -1 ${'a'.repeat(200)}`
  foldAgyRow(run(wide), long)
  foldAgyRow({ event: 'result', result: { status: 'ERROR', denied_actions: [{ action: 'run_command' }] } }, long)
  expect(long.denied[0]!.text).toContain(wide.slice(0, 120))
  expect(long.denied[0]!.text).not.toContain(wide.slice(0, 121))
})

test('lists the shell commands a Head ran, in its report line', () => {
  const state = newAgyState()
  foldAgyRow(run('ls -1 public'), state)
  foldAgyRow(run('ls -1 public', 1, 'DONE'), state)
  foldAgyRow(run('python3 -c "print(1)"', 2), state)
  foldAgyRow(run('python3 -c "print(1)"', 2, 'DONE'), state)

  expect(state.shell).toEqual(['ls -1 public', 'python3 -c "print(1)"'])
  expect(agyShellLine(state.shell)).toBe('shell: 2 commands: ls -1 public; python3 -c "print(1)"')
  expect(agyShellLine(['ls'])).toBe('shell: 1 command: ls')
  expect(agyShellLine([])).toBe('')
})

test('stops a silent run after 10 minutes as stalled, naming the call it hung on', () => {
  expect(AGY_WATCHDOG).toEqual({ firstMs: 300_000, idleMs: 600_000 })
  expect(agyHungEnding({ signal: 'idle' }, 'error', '$ git show HEAD')).toEqual({
    ending: 'stalled', activity: 'stalled: no output for 10 min on $ git show HEAD',
  })
  // A run that ended on its own is never relabelled, and a stop for another reason is left alone.
  expect(agyHungEnding({ signal: 'idle' }, 'done')).toEqual({ ending: 'done' })
  expect(agyHungEnding({ signal: 'aborted' }, 'stopped')).toEqual({ ending: 'stopped' })

  // The call in flight is the one a watchdog stop names; a finished one is not.
  const state = newAgyState()
  foldAgyRow(run('git show HEAD', 1, 'DONE'), state)
  expect(state.pending).toBeUndefined()
  foldAgyRow(run('git show HEAD~1', 2), state)
  expect(state.pending).toMatchObject({ tool: 'shell_command', input: { command: 'git show HEAD~1' } })
})

test('tells a Head about the untracked files its search may miss, up to 30', async () => {
  const { $, runs } = fake([], 'src/a.ts\nsrc/b.ts\n')
  expect(await agyUntrackedNote($, '/p/app')).toBe(
    'Untracked files (git sees them; Antigravity\'s file search may miss them, so open them by path): src/a.ts, src/b.ts',
  )
  expect(runs).toContainEqual(['git', '-C', '/p/app', 'ls-files', '--others', '--exclude-standard'])

  const many = Array.from({ length: 35 }, (_, i) => `f${i}.ts`).join('\n')
  const note = await agyUntrackedNote(fake([], many).$, '/p/app')
  expect(note).toContain('f29.ts')
  expect(note).not.toContain('f30.ts')
  expect(note).toContain('(and 5 more)')

  // Outside a repository, or with nothing untracked, the prompt gets no line.
  expect(await agyUntrackedNote(fake([], '').$, '/p/app')).toBe('')
  const outside = { process: { run: async () => ({ exitCode: 128, stdout: '', stderr: 'not a git repository' }) } } as unknown as EngineInterface
  expect(await agyUntrackedNote(outside, '/p/app')).toBe('')
})

test('a path with a space stays one rule target, unquoted', () => {
  const spaced = '/Volumes/My Files/Projects/iOS/quotexpedia'
  const settings = agySettings(spaced, { addDirs: [], shell: false })
  expect(settings.permissions.allow).toContain(`write_file(${spaced}/)`)
  expect(settings.permissions.deny).toContain(`write_file(${spaced}/.git/)`)
})
