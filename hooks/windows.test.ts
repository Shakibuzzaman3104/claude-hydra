/**
 * @author Shakib
 * @since 27/10/26
 */
import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { PROJECT_DENY, SEARCH_DENY, guardPolicy, headSettings, windowsPathRefusal, writeRules } from './engines/commandcode'
import { outsideFiles, relativeTo } from './lib/format'
import { HYDRA_POLICY } from './lib/policy'
import { pauseOneSecond, resetPlatform } from './lib/platform'
import { WINDOWS_ENGINES, preflight, windowsRefusal } from './lib/runtime'
import { DANGEROUS_SHELL, SECRET_PATHS, strictGuardCommand } from './lib/safety'

const CWD = 'C:/Users/me/app'
const RULES = `${CWD}/.commandcode/settings.local.json`
const POLICY = `${CWD}/.commandcode/hydra-guard.json`

/** A `$` on native Windows: `files` holds what exists (and what Hydra writes), `runs` every command Hydra ran. */
const windows = (files: Record<string, string> = {}, python = true) => {
  const runs: string[][] = []
  const $ = {
    plugin: { root: 'C:/Users/me/.claude/plugins/hydra' },
    env: { get: async (name: string) => ({ OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\me' } as Record<string, string>)[name] },
    session: { id: async () => 's1' },
    clock: { now: async () => 1_000 },
    fs: {
      exists: async (path: string) => path in files,
      read: async (path: string) => files[path] ?? '',
      write: async (path: string, text: string) => void (files[path] = text),
      list: async () => {
        throw new Error('there is no / to list on Windows')
      },
    },
    process: {
      run: async (argv: string[]) => {
        runs.push(argv)
        if (argv.includes('--version')) return python ? { exitCode: 0, stdout: 'Python 3.12.0\n', stderr: '' } : { exitCode: 9009, stdout: '', stderr: '' }
        if (argv[0] === 'git') return { exitCode: 0, stdout: 'C:/Users/me/app/.git/info/exclude\n', stderr: '' }
        if (argv[0]?.startsWith('/') || argv[0] === 'find') throw new Error(`${argv[0]} does not exist on Windows`)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  } as unknown as EngineInterface
  return { $, runs, files }
}

/** A rules file another session left for a Head still running in the project, so `writeRules` has a Head to lock down. */
const running = (needs: { addDirs: string[]; shell: boolean; writeDirs?: string[] }) =>
  JSON.stringify({ managedBy: 'hydra', hydraHeads: [{ ...needs, key: 'other/h1', until: 10_000_000 }] })

test('Command Code is the one engine allowed on native Windows; the others still point at WSL or Command Code', async () => {
  expect([...WINDOWS_ENGINES]).toEqual(['commandcode'])
  expect(windowsRefusal('codex')).toContain('WSL')
  expect(windowsRefusal('codex')).toContain('Command Code')
})

test('preflight no longer refuses Command Code on Windows, and still refuses an engine with no lockdown there', async () => {
  resetPlatform()
  const { $ } = windows()
  expect((await preflight($, 'codex')).problems.join(' ')).toContain('not locked down on native Windows')
  expect((await preflight($, 'commandcode')).problems.join(' ')).not.toContain('not locked down')
  resetPlatform()
})

test('the strict settings run the guard before every tool, fail closed, and deny shell and search outright', async () => {
  const settings = headSettings([{ addDirs: [], shell: true }], [], false, 'guard', 'C:/Users/me', true)
  const hook = settings.hooks?.PreToolUse[0]
  expect(hook?.matcher).toBeUndefined()
  expect(hook?.hooks[0]).toEqual({ type: 'command', command: 'guard', timeout: 10, failClosed: true })
  const deny = settings.permissions?.deny ?? []
  expect(deny).toContain('Shell')
  expect(deny).toContain(SEARCH_DENY)
  for (const rule of PROJECT_DENY) expect(deny).toContain(rule)
  expect(deny.some(rule => DANGEROUS_SHELL.includes(rule))).toBe(false)
})

test('the usual settings are unchanged: the guard watches writes only, and shell follows the Head', async () => {
  const settings = headSettings([{ addDirs: [], shell: true }], [], false, 'guard')
  expect(settings.hooks?.PreToolUse[0]?.matcher).toBe('write|edit')
  expect(settings.hooks?.PreToolUse[0]?.hooks[0]?.failClosed).toBeUndefined()
  expect(settings.permissions?.deny).not.toContain('Shell')
  expect(settings.permissions?.deny).not.toContain(SEARCH_DENY)
})

test('the guard policy names the project and writeDirs to write, addDirs to read, and the secrets to keep out of', async () => {
  const guarded = { paths: [`${CWD}/secrets`], folders: [`${CWD}/secrets`], ignoreFiles: [`${CWD}/.hydraignore`] }
  const policy = guardPolicy(CWD, [{ addDirs: ['D:/brief'], shell: false, writeDirs: ['D:/shared'] }, { addDirs: ['D:/brief', 'E:/docs'], shell: false, guarded }], 'C:/Users/me')
  expect(policy.write).toEqual([CWD, 'D:/shared'])
  expect(policy.read).toEqual(['D:/brief', 'E:/docs'])
  expect(policy.guarded).toEqual([`${CWD}/secrets`])
  expect(policy.home).toBe('C:/Users/me')
  expect(policy.secrets).toEqual(SECRET_PATHS)
})

test('the strict guard command quotes the script and policy for cmd.exe and keeps the Python launcher as found', async () => {
  expect(strictGuardCommand('C:/p/hy dra', 'C:/work/my "app"/.commandcode/hydra-guard.json', ['py', '-3']))
    .toBe('py -3 -I "C:/p/hy dra/bin/head-guard.py" --policy "C:/work/my ""app""/.commandcode/hydra-guard.json"')
  expect(strictGuardCommand('C:/p', 'C:/w/x.json', ['python'])).toBe('python -I "C:/p/bin/head-guard.py" --policy "C:/w/x.json"')
})

test('a Windows project path is still refused off Windows, where the strict guard is not set up', async () => {
  expect(windowsPathRefusal('C:/Users/me/app')).toContain('WSL')
})

test('writeRules on Windows writes the policy and strict settings, with no POSIX tools and no listing of /', async () => {
  resetPlatform()
  const { $, runs, files } = windows({ [RULES]: running({ addDirs: ['D:/brief'], shell: true, writeDirs: ['D:/shared'] }) })
  expect(await writeRules($, CWD)).toBeUndefined()
  const settings = JSON.parse(files[RULES]!) as ReturnType<typeof headSettings>
  expect(settings.permissions?.deny).toContain('Shell')
  expect(settings.permissions?.deny).toContain(SEARCH_DENY)
  expect(settings.permissions?.deny?.some(rule => rule.startsWith('Edit(//'))).toBe(false)
  const command = settings.hooks?.PreToolUse[0]?.hooks[0]
  expect(command?.failClosed).toBe(true)
  expect(command?.command).toMatch(/-I "C:\/Users\/me\/\.claude\/plugins\/hydra\/bin\/head-guard\.py" --policy "C:\/Users\/me\/app\/\.commandcode\/hydra-guard\.json"$/)
  const policy = JSON.parse(files[POLICY]!) as ReturnType<typeof guardPolicy>
  expect(policy.write).toEqual([CWD, 'D:/shared'])
  expect(policy.read).toEqual(['D:/brief'])
  expect(policy.home).toBe('C:/Users/me')
  expect(files[`${CWD}/.git/info/exclude`]?.split('\n')).toEqual(expect.arrayContaining(['.commandcode/settings.local.json', '.commandcode/hydra-guard.json']))
  expect(runs.some(argv => argv[0] === 'find' || argv[0]?.startsWith('/'))).toBe(false)
  resetPlatform()
})

test('writeRules on Windows removes the rules, the policy and the folder with Python once no Head is left', async () => {
  resetPlatform()
  const { $, runs } = windows({ [RULES]: JSON.stringify({ managedBy: 'hydra', hydraHeads: [] }) })
  expect(await writeRules($, CWD)).toBeUndefined()
  const removed = runs.filter(argv => argv.includes('-c')).map(argv => argv.slice(-2))
  expect(removed).toEqual([[RULES, 'file'], [POLICY, 'file'], [`${CWD}/.commandcode`, 'dir']])
  resetPlatform()
})

test('the Lead hears that a Command Code Head on Windows has no shell or search', async () => {
  expect(HYDRA_POLICY('deepseek/deepseek-v4.1-flash', 'auto', 'commandcode')).toContain('On native Windows')
})

test('a foreground Head waits on Windows with ping, not /bin/sleep, which does not exist there', async () => {
  resetPlatform()
  const { $, runs } = windows()
  await pauseOneSecond($)
  expect(runs).toEqual([['ping.exe', '-n', '2', '127.0.0.1']])
  resetPlatform()
})

test('a report on Windows flags a write outside the project and shows edits inside it relative to the project', async () => {
  const files = ['C:\\Users\\me\\app\\src\\a.kt', 'c:/users/ME/APP/b.kt', 'C:\\Users\\me\\x.txt', 'D:/shared/c.kt', 'C:/Users/me/app-evil/d.kt']
  expect(outsideFiles('C:\\Users\\me\\app', files, ['D:\\shared'])).toEqual(['C:\\Users\\me\\x.txt', 'C:/Users/me/app-evil/d.kt'])
  expect(relativeTo('C:\\Users\\me\\app', 'C:\\Users\\me\\app\\src\\a.kt')).toBe('src/a.kt')
  expect(relativeTo('C:/Users/me/app/', 'c:/users/me/app/B.kt')).toBe('B.kt')
  expect(relativeTo('/repo', '/repo/a/b.swift')).toBe('a/b.swift')
})
