/**
 * @author Shakib
 * @since 18/10/26
 */
import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { agyCaseRefusal, agyGrantRefusal, agySettings, tooManySpellings } from './engines/agy'
import { BUDDY_SHELL_DENY, buddyArgs, buddySettings, buddyTools } from './engines/codebuddy'
import { codexFilesystem } from './engines/codex'
import { PROJECT_DENY, SEARCH_DENY, headSettings } from './engines/commandcode'
import { OPENCODE_IGNORE, linkDenies, opencodeConfig } from './engines/opencode'
import { formatReport, reportNotice } from './lib/format'
import { IGNORE_CAP, guardedPaths, ignoreChangedLine, ignoreChanges } from './lib/protect'
import type { Guarded } from './lib/protect'

type Ran = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean }

/** A `$` whose `.hydraignore` files are `present` and whose git answers with `ran` (or rejects when it is undefined). */
const fake = (present: readonly string[], ran: Ran | undefined, calls: string[][] = []) => ({
  fs: { exists: async (path: string) => present.includes(path) },
  process: {
    run: async (argv: string[]) => {
      calls.push(argv)
      if (!ran) throw new Error('spawn failed')
      return ran
    },
  },
}) as unknown as EngineInterface

const guard: Guarded = { paths: ['/p/app/local.properties', '/p/app/secrets'], folders: ['/p/app/secrets'], ignoreFiles: ['/p/app/.hydraignore'] }

test('a project without .hydraignore keeps nothing extra and never runs git', async () => {
  const calls: string[][] = []
  expect(await guardedPaths(fake([], { exitCode: 0, stdout: '', stderr: '' }, calls), [{ path: '/p/app' }])).toEqual({ paths: [], folders: [], ignoreFiles: [] })
  expect(calls).toEqual([])
})

test('lists what .hydraignore names under every spelling of the root, anchored at the file\'s own folder', async () => {
  const calls: string[][] = []
  const out = await guardedPaths(fake(['/link/app/.hydraignore'], { exitCode: 0, stdout: 'local.properties\0secrets/\0app/google-services.json\0', stderr: '' }, calls), [{ path: '/link/app/', real: '/p/app' }])
  expect(out).toEqual({
    paths: ['/link/app/app/google-services.json', '/link/app/local.properties', '/link/app/secrets', '/p/app/app/google-services.json', '/p/app/local.properties', '/p/app/secrets'],
    folders: ['/link/app/secrets', '/p/app/secrets'],
    ignoreFiles: ['/link/app/.hydraignore', '/p/app/.hydraignore'],
  })
  expect(calls[0]).toContain('--exclude-per-directory=.hydraignore')
  expect(calls[0]).toContain('--cached')
  expect(calls[0]).toContain('--others')
})

test('refuses the Head when .hydraignore cannot be read, never treating it as empty', async () => {
  const notGit = await guardedPaths(fake(['/p/app/.hydraignore'], { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }), [{ path: '/p/app' }])
  expect('refusal' in notGit && notGit.refusal).toContain('not a git repository')
  const noGit = await guardedPaths(fake(['/p/app/.hydraignore'], undefined), [{ path: '/p/app' }])
  expect('refusal' in noGit && noGit.refusal).toContain('could not be read')
  const cut = await guardedPaths(fake(['/p/app/.hydraignore'], { exitCode: 0, stdout: 'a\0', stderr: '', isStdoutTruncated: true }), [{ path: '/p/app' }])
  expect('refusal' in cut).toBe(true)
})

test('an existence check that fails counts as a .hydraignore that is there', async () => {
  const $ = { fs: { exists: async () => { throw new Error('EACCES') } }, process: { run: async () => ({ exitCode: 128, stdout: '', stderr: 'denied' }) } } as unknown as EngineInterface
  expect('refusal' in (await guardedPaths($, [{ path: '/p/app' }]))).toBe(true)
})

test(`refuses more than ${IGNORE_CAP} matches, asking for folders instead`, async () => {
  const many = Array.from({ length: IGNORE_CAP + 1 }, (_, index) => `f${index}`).join('\0')
  const out = await guardedPaths(fake(['/p/app/.hydraignore'], { exitCode: 0, stdout: many, stderr: '' }), [{ path: '/p/app' }])
  expect('refusal' in out && out.refusal).toContain('Name whole folders')
})

test('Command Code keeps .hydraignore matches from reads, edits, search and shell lines, and .hydraignore from edits', async () => {
  const deny = headSettings([{ addDirs: [], shell: true, guarded: guard }], []).permissions?.deny ?? []
  expect(deny).toContain('Read(//p/app/local.properties)')
  expect(deny).toContain('Read(//p/app/secrets/**)')
  expect(deny).toContain('Edit(//p/app/local.properties)')
  expect(deny).toContain('Shell(* local.properties*)')
  expect(deny).toContain(SEARCH_DENY)
  expect(PROJECT_DENY).toContain('Edit(.hydraignore)')
  expect(headSettings([{ addDirs: [], shell: false }], []).permissions?.deny).not.toContain(SEARCH_DENY)
})

test('CodeBuddy keeps .hydraignore matches from its read, edit and write tools and from shell lines', async () => {
  const deny = buddySettings('/p/app', { addDirs: [], shell: true, guarded: guard }).permissions.deny
  for (const tool of ['Read', 'Edit', 'Write']) {
    expect(deny).toContain(`${tool}(/p/app/local.properties)`)
    expect(deny).toContain(`${tool}(/p/app/secrets/**)`)
  }
  expect(deny).toContain('Bash(* secrets*)')
  expect(deny).toContain('Edit(/p/app/**/.hydraignore)')
})

test('Antigravity names a matched folder with its trailing slash and keeps .hydraignore read-only', async () => {
  const deny = agySettings('/p/app', { addDirs: [], shell: false, guarded: guard }).permissions.deny
  expect(deny).toContain('read_file(/p/app/local.properties)')
  expect(deny).toContain('read_file(/p/app/secrets/)')
  expect(deny).toContain('write_file(/p/app/secrets/)')
  expect(deny).toContain('write_file(/p/app/.hydraignore)')
})

test('Codex closes each match and makes .hydraignore read-only, naming nothing outside the Head\'s folders', async () => {
  const profile = codexFilesystem('/p/app', { addDirs: [], shell: true, guarded: { ...guard, paths: [...guard.paths, '/elsewhere/x'] } }, '/home/me', [])
  expect(profile).toContain('"/p/app/local.properties"="none"')
  expect(profile).toContain('"/p/app/secrets"="none"')
  expect(profile).toContain('"/p/app/.hydraignore"="read"')
  expect(profile).not.toContain('**/.hydraignore')
  expect(profile).not.toContain('/elsewhere/x')
})

test('OpenCode denies each match for reads and edits in any letter case, and .hydraignore for edits', async () => {
  const config = opencodeConfig('/p/app', { addDirs: [], shell: false, guarded: guard })
  const read = Object.keys(config.permission.read as Record<string, string>)
  const edit = config.permission.edit as Record<string, string>
  expect(read.some(rule => /^lo\?+\.\?+$/.test(rule))).toBe(true)
  expect(read.some(rule => rule.startsWith('se') && rule.endsWith('/*'))).toBe(true)
  for (const rule of OPENCODE_IGNORE) expect(edit[rule]).toBe('deny')
})

test('an OpenCode symlink to a .hydraignore match, in any letter case, is denied for reads', async () => {
  const denied = linkDenies([{ path: '/p/app/props', target: '/p/app/LOCAL.PROPERTIES' }, { path: '/p/app/docs-link', target: '/p/app/docs' }], '/p/app', { addDirs: [], shell: false, guarded: guard })
  expect(denied.read).toContain('/p/app/props')
  expect(denied.read).not.toContain('/p/app/docs-link')
})

test('a report flags a Head that changed a .hydraignore, at the top and in the one-line notice', async () => {
  const text = formatReport({ id: 'x', model: 'm', cwd: '/p/app', finished: true, rounds: 1, turns: 2, usd: 0, files: ['/p/app/sub/.HydraIgnore'], denied: [], finalText: 'done', exit: '0' })
  expect(text).toContain('⚠ CHANGED .hydraignore (sub/.HydraIgnore)')
  expect(reportNotice(`Hydra Head x finished\n${text}`)).toContain('⚠ changed .hydraignore')
})

test('CodeBuddy loses its Grep tool while a .hydraignore match is in reach (its search walks past Read rules)', async () => {
  expect(buddyTools(false)).toContain('Grep')
  expect(buddyTools(false, false)).not.toContain('Grep')
  expect(buddyArgs({ prompt: 'p', model: 'm', maxTurns: 5, cwd: '/p', addDirs: [], settings: '/s.json', shell: false, sessionId: 's', search: false })).toContain('Read,Write,Edit,Glob')
})

test('on a disk that ignores case, Antigravity denies each protected path in every spelling below its root', async () => {
  const deny = agySettings('/p/app', { addDirs: [], shell: false, guarded: { paths: ['/p/app/secrets'], folders: ['/p/app/secrets'], ignoreFiles: [] } }, '', ['/p/app/.env'], [], true).permissions.deny
  for (const spelling of ['.env', '.ENV', '.Env', '.eNv']) expect(deny).toContain(`read_file(/p/app/${spelling})`)
  for (const spelling of ['.git', '.GIT', '.Git']) expect(deny).toContain(`write_file(/p/app/${spelling}/)`)
  expect(deny).toContain('read_file(/p/app/SECRETS/)')
  expect(deny).not.toContain('read_file(/P/app/.env)')
  expect(agySettings('/p/app', { addDirs: [], shell: false }, '', ['/p/app/.env']).permissions.deny).not.toContain('read_file(/p/app/.ENV)')
})

test('refuses an Antigravity Head whose rules would grow past the cap, or whose grant holds a credential folder, only where case is ignored', async () => {
  const caseless = { fs: { exists: async () => true }, process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }, env: { get: async () => '/home/me' } } as unknown as EngineInterface
  const exact = { fs: { exists: async () => false } } as unknown as EngineInterface
  expect(await agyCaseRefusal(caseless, '/p/app', { addDirs: [], shell: false })).toBeUndefined()
  expect(await agyCaseRefusal(caseless, '/p/app', { addDirs: [], shell: false, guarded: guard })).toContain('rules')
  expect(await agyCaseRefusal(exact, '/p/app', { addDirs: [], shell: false, guarded: guard })).toBeUndefined()
  expect(agyGrantRefusal(['/home/me'], '/home/me')).toContain('holds /home/me/.ssh')
  expect(agyGrantRefusal(['/home/me/work'], '/home/me')).toBeUndefined()
  expect(tooManySpellings(5000)).toContain('5000 rules')
})

test('notices a .hydraignore a Head removed or changed, on any engine', async () => {
  const before = new Map([['/p/.hydraignore', 'local.properties\n'], ['/p/sub/.hydraignore', null]])
  expect(ignoreChanges(before, new Map([['/p/.hydraignore', 'local.properties\n']]))).toEqual([])
  expect(ignoreChanges(before, new Map([['/p/.hydraignore', null]]))).toEqual(['/p/.hydraignore'])
  expect(ignoreChanges(before, new Map([['/p/.hydraignore', '!local.properties\n']]))).toEqual(['/p/.hydraignore'])
  expect(ignoreChangedLine(['/p/.hydraignore'])).toContain('REMOVED OR CHANGED')
})

test('a shell line that names .hydraignore is denied on Command Code and CodeBuddy', async () => {
  expect(PROJECT_DENY).toContain('Shell(* .hydraignore*)')
  expect(BUDDY_SHELL_DENY).toContain('Bash(* .hydraignore*)')
})
