/**
 * @author Shakib
 * @since 23/10/26
 */
import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { codexArgs, codexEnv, codexFilesystem, removeCodexTemp } from './register'

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
  expect(codexEnv(TEMP)).toEqual({ TMPDIR: `${TEMP}/` })
  // The person's own environment stays, and TMPDIR wins in the Head.
  expect(codexEnv(TEMP, { FOO: 'bar', TMPDIR: '/tmp' })).toEqual({ FOO: 'bar', TMPDIR: `${TEMP}/` })
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
