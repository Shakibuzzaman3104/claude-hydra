/**
 * @author Shakib
 * @since 17/11/26
 */
import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { joinProject, leaveProject, writeRules } from './engines/commandcode'
import { resetPlatform } from './lib/platform'

const rulesOf = (cwd: string) => `${cwd}/.commandcode/settings.local.json`

/** Lets other pending work run for `n` steps, as a real write or process yields while the OS works. */
const yieldFor = async (n: number) => {
  for (let i = 0; i < n * 10; i++) await Promise.resolve()
}

/**
 * A `$` on macOS whose `fs.write` is not atomic, as a real `writeFile` is not: it truncates the file, yields, then
 * fills it. `/bin/mv` renames in one step. `slowFind` makes the `.env` check of the next calls take longer, so two
 * calls that start in one order finish in the other.
 */
const posix = (cwd: string, files: Record<string, string> = {}) => {
  const writes: string[] = []
  const findDelays: number[] = []
  const $ = {
    plugin: { root: '/plugins/hydra' },
    env: { get: async (name: string) => ({ HOME: '/home/me' } as Record<string, string>)[name] },
    session: { id: async () => 's1' },
    clock: { now: async () => 1_000 },
    fs: {
      exists: async (path: string) => path in files,
      read: async (path: string) => {
        if (!(path in files)) throw new Error(`ENOENT ${path}`)
        return files[path]!
      },
      write: async (path: string, text: string) => {
        writes.push(path)
        files[path] = ''
        await yieldFor(2)
        files[path] = text
      },
      list: async () => [],
    },
    process: {
      run: async (argv: string[]) => {
        if (argv[0] === 'uname') return { exitCode: 0, stdout: 'Darwin\n', stderr: '' }
        if (argv[0] === 'find') {
          await yieldFor(findDelays.shift() ?? 1)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === 'git') return { exitCode: 0, stdout: `${cwd}/.git/info/exclude\n`, stderr: '' }
        if (argv[0] === '/bin/mv') {
          const [from, to] = argv.slice(-2) as [string, string]
          if (!(from in files)) return { exitCode: 1, stdout: '', stderr: 'no such file' }
          files[to] = files[from]!
          delete files[from]
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === '/bin/rm') delete files[argv[argv.length - 1]!]
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  } as unknown as EngineInterface
  return { $, files, writes, findDelays }
}

const isJson = (text: string | undefined) => {
  try {
    JSON.parse(text ?? '')
    return true
  } catch {
    return false
  }
}

const otherSessionHead = JSON.stringify({ managedBy: 'hydra', hydraHeads: [{ addDirs: [], shell: false, key: 'other/h0', until: 10_000_000 }] })

test('nine Heads starting at once never see the rules file half written, and it ends valid', async () => {
  resetPlatform()
  const CWD = '/work/nine'
  const RULES = rulesOf(CWD)
  const { $, files } = posix(CWD, { [RULES]: otherSessionHead })
  const refusals = await Promise.all(Array.from({ length: 9 }, (_, i) => joinProject($, CWD, `h${i + 1}`, { addDirs: [], shell: false }, 10)))
  expect(refusals).toEqual(Array(9).fill(undefined))
  expect(isJson(files[RULES])).toBe(true)
  const keys = (JSON.parse(files[RULES]!) as { hydraHeads: { key: string }[] }).hydraHeads.map(head => head.key).sort()
  expect(keys).toEqual(['other/h0', ...Array.from({ length: 9 }, (_, i) => `s1/h${i + 1}`)].sort())
  await Promise.all(Array.from({ length: 9 }, (_, i) => leaveProject($, CWD, `h${i + 1}`)))
  resetPlatform()
})

test('a Head that joins while an earlier write is still running is in the file that write leaves', async () => {
  resetPlatform()
  const CWD = '/work/two'
  const RULES = rulesOf(CWD)
  const { $, files, findDelays } = posix(CWD)
  // The first Head's .env check is slow and the second's fast. The second joins while the first write is parked in its
  // check, after it took the list of Heads: without ordering, the first write lands last and drops the second Head.
  findDelays.push(20, 1)
  const slow = joinProject($, CWD, 'slow', { addDirs: [], shell: false }, 10)
  await yieldFor(5)
  expect(await joinProject($, CWD, 'fast', { addDirs: [], shell: true }, 10)).toBeUndefined()
  expect(await slow).toBeUndefined()
  const settings = JSON.parse(files[RULES]!) as { hydraHeads: { key: string }[]; permissions: { deny: string[] } }
  expect(settings.hydraHeads.map(head => head.key).sort()).toEqual(['s1/fast', 's1/slow'])
  await leaveProject($, CWD, 'fast')
  // The slow Head is still running: the file must still be there for it.
  expect(isJson(files[RULES])).toBe(true)
  expect((JSON.parse(files[RULES]!) as { hydraHeads: { key: string }[] }).hydraHeads.map(head => head.key)).toEqual(['s1/slow'])
  await leaveProject($, CWD, 'slow')
  expect(RULES in files).toBe(false)
  resetPlatform()
})

test('the rules file is replaced in one step, never written in place where Command Code could read half of it', async () => {
  resetPlatform()
  const CWD = '/work/one'
  const RULES = rulesOf(CWD)
  const { $, files, writes } = posix(CWD, { [RULES]: otherSessionHead })
  expect(await writeRules($, CWD)).toBeUndefined()
  expect(writes).not.toContain(RULES)
  expect(isJson(files[RULES])).toBe(true)
  // No temporary file is left next to it.
  expect(Object.keys(files).filter(path => path.startsWith(`${CWD}/.commandcode/`))).toEqual([RULES])
  resetPlatform()
})
