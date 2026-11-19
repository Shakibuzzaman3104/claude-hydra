/**
 * @author Shakib
 * @since 23/10/26
 */
import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { codexArgs, codexEnv, codexFilesystem, makeCodexTemp, removeCodexTemp } from './register'

const CWD = '/home/me/app'
const TEMP = '/var/folders/ab/T/hydra-codex-session-1-head-1'

test('writes the Head\'s own temp folder so macOS git can make its cache files', async () => {
  const profile = codexFilesystem(CWD, { addDirs: [], writeDirs: [], shell: true }, '/home/me', [], TEMP)
  expect(profile).toContain(`"${TEMP}"="write"`)
  expect(profile).not.toContain('"/tmp"="write"')
  expect(profile).not.toContain('"/private/tmp"="write"')
  // A Head without one gets no temp folder at all, and /tmp still stays out.
  expect(codexFilesystem(CWD, { addDirs: [], writeDirs: [], shell: true }, '/home/me', [])).not.toContain(TEMP)
})

test('passes the temp folder in the filesystem profile and TMPDIR in the round environment', async () => {
  const filesystem = codexFilesystem(CWD, { addDirs: [], writeDirs: [], shell: true }, '/home/me', [], TEMP)
  const args = codexArgs({ prompt: 'do it', model: 'gpt-6-luna', maxTurns: 40, cwd: CWD, addDirs: [], filesystem })
  expect(args.join(' ')).toContain(TEMP)
  expect(args).toContain(`permissions.hydra.filesystem=${filesystem}`)
  expect(codexEnv(TEMP)).toEqual({ TMPDIR: `${TEMP}/`, TMPPREFIX: `${TEMP}/zsh`, GOCACHE: `${TEMP}/go-build`, GOTMPDIR: `${TEMP}/go-tmp` })
  // The person's own environment stays, TMPDIR wins in the Head, and their module cache is left alone.
  expect(codexEnv(TEMP, { FOO: 'bar', TMPDIR: '/tmp', GOCACHE: '/home/me/Library/Caches/go-build', GOMODCACHE: '/home/me/go/pkg/mod' })).toEqual({
    FOO: 'bar', TMPDIR: `${TEMP}/`, TMPPREFIX: `${TEMP}/zsh`, GOCACHE: `${TEMP}/go-build`, GOTMPDIR: `${TEMP}/go-tmp`, GOMODCACHE: '/home/me/go/pkg/mod',
  })
})

test('creates Go\'s build cache and temp folders inside the Head\'s private temp folder', async () => {
  const ran: string[] = []
  const $ = {
    env: { get: async () => '/var/folders/ab/T' },
    session: { id: async () => 'session-1' },
    process: { run: async (argv: string[]) => {
      ran.push(argv.join(' '))
      return { exitCode: 0, stdout: '', stderr: '' }
    } },
  } as unknown as EngineInterface
  const dir = await makeCodexTemp($, 'head-1')
  expect(dir).toBe(TEMP)
  expect(ran).toEqual([
    `/bin/mkdir -p ${TEMP} ${TEMP}/go-build ${TEMP}/go-tmp`,
    `/bin/chmod 700 ${TEMP} ${TEMP}/go-build ${TEMP}/go-tmp`,
  ])
})

test('keeps every .env.* file closed: Codex takes only none on a glob, so .env.example cannot be exempted', async () => {
  const profile = codexFilesystem(CWD, { addDirs: [], writeDirs: [], shell: true }, '/home/me')
  expect(profile).toContain(`"${CWD}/**/.env.*"="none"`)
  expect(profile).not.toContain('.env.example')
})

test('removes only folders Hydra named, never a foreign path', async () => {
  const ran: string[] = []
  const $ = {
    process: { run: async (argv: string[]) => {
      ran.push(argv.join(' '))
      return { exitCode: 0, stdout: '', stderr: '' }
    } },
  } as unknown as EngineInterface
  await removeCodexTemp($, TEMP)
  expect(ran).toEqual([`/bin/rm -rf ${TEMP}`])
  for (const path of ['/tmp', '/home/me/important', '/home/me/hydra-codex', '/tmp/not-hydra/']) await removeCodexTemp($, path)
  expect(ran).toEqual([`/bin/rm -rf ${TEMP}`])
})
