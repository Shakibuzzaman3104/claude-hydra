/**
 * @author Shakib
 * @since 23/10/26
 */
import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { AGY_NOT_SIGNED_IN, agyRoundErrors, agySettings, writeAgyHome } from './engines/agy'
import { signedInOf } from './lib/accounts'
import type { Account } from './lib/accounts'
import { AGY_TOKEN } from './lib/engines'
import { formatReport } from './lib/format'
import { resetPlatform } from './lib/platform'
import { preflight } from './lib/runtime'

const HOME = '/Users/me'
const TOKEN = `${HOME}/${AGY_TOKEN}`
const NEEDS = { addDirs: [], shell: false }

/** A `$` for one Head's setup: `files` are the paths that exist, and `runs` and `writes` record what Hydra did. */
const agyHome = (files: readonly string[] = [], platform: 'darwin' | 'linux' = 'darwin') => {
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
        if (argv[0] === 'uname') return { exitCode: 0, stdout: platform === 'darwin' ? 'Darwin\n' : 'Linux\n', stderr: '' }
        if (argv[0] === 'python3') return { exitCode: 0, stdout: 'Python 3.12.0\n', stderr: '' }
        if (argv[0] === '/usr/bin/find') return { exitCode: 1, stdout: '', stderr: '' }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  } as unknown as EngineInterface
  return { $, runs, writes }
}

test('copies an Antigravity token file into the Head\'s own HOME, as before', async () => {
  const { $, runs } = agyHome([TOKEN])
  const dir = await writeAgyHome($, '/p/app', 'h1', NEEDS)
  expect(dir).toBe('/Users/me/.claude/hydra/heads/agy-s1-h1')
  expect(runs).toContainEqual(['/bin/cp', '-p', TOKEN, `${dir}/.gemini/antigravity-cli/antigravity-oauth-token`])
  // Nothing to link and no platform to ask: the file is the sign-in.
  expect(runs.some(argv => argv[0] === '/bin/ln' || argv[0] === 'uname')).toBe(false)
})

test('links the macOS keychain into the Head\'s HOME when agy keeps no token file, and copies nothing', async () => {
  resetPlatform()
  const { $, runs, writes } = agyHome([], 'darwin')
  const dir = await writeAgyHome($, '/p/app', 'h1', NEEDS)
  expect(runs).toContainEqual(['/bin/mkdir', '-p', `${dir}/Library`])
  expect(runs).toContainEqual(['/bin/ln', '-s', '/Users/me/Library/Keychains', `${dir}/Library/Keychains`])
  expect(runs.some(argv => argv[0] === '/bin/cp')).toBe(false)
  // The rules written beside it deny the folder the link sits in, so the model's own tools stay out of the keychain.
  const settings = JSON.parse(writes.find(write => write.path.endsWith('/settings.json'))!.text) as { permissions: { deny: string[] } }
  expect(settings.permissions.deny).toContain(`read_file(${dir}/Library)`)
  expect(settings.permissions.deny).toContain(`write_file(${dir}/Library)`)
})

test('refuses to set up an Antigravity Head elsewhere with no token file', async () => {
  resetPlatform()
  const { $ } = agyHome([], 'linux')
  const message = await writeAgyHome($, '/p/app', 'h1', NEEDS).then(() => '', (error: Error) => error.message)
  expect(message).toBe(AGY_NOT_SIGNED_IN)
  expect(message).toContain('not signed in')
})

test('denies an Antigravity Head its own Library folder, with a shell too', async () => {
  const headHome = '/Users/me/.claude/hydra/heads/agy-s1-h1'
  const settings = agySettings('/p/app', { addDirs: [], shell: true }, HOME, [], [], false, headHome)
  expect(settings.permissions.deny).toContain(`read_file(${headHome}/Library)`)
  expect(settings.permissions.deny).toContain(`write_file(${headHome}/Library)`)
  // The deny is a path rule like the credential folders', so a shell does not drop it.
  expect(settings.permissions.allow).toContain('command(*)')
  expect(settings.permissions.deny).toContain(`read_file(${HOME}/Library/Keychains)`)
})

test('reads an Antigravity sign-in from the token file, or says it cannot check the keychain', async () => {
  const account: Account = { engine: 'agy', name: 'default' }
  resetPlatform()
  expect(await signedInOf(agyHome([TOKEN], 'darwin').$, account, true)).toBe(true)
  resetPlatform()
  expect(await signedInOf(agyHome([], 'darwin').$, account, true)).toBeUndefined()
  resetPlatform()
  expect(await signedInOf(agyHome([], 'linux').$, account, true)).toBe(false)
})

test('stops an Antigravity Head before it starts where a missing token file means signed out', async () => {
  resetPlatform()
  const { $ } = agyHome([], 'linux')
  const check = await preflight($, 'agy')
  expect(check.problems).toContain('Antigravity is not signed in. Run `agy` once in a terminal (choose Google OAuth), then try again.')
  expect(check.warnings).toEqual([])
})

// Last: a preflight that passes is kept for the session, so a later test could not read this warning again.
test('warns, rather than refusing, when macOS may hold the Antigravity sign-in in its keychain', async () => {
  resetPlatform()
  const { $ } = agyHome([], 'darwin')
  const check = await preflight($, 'agy')
  expect(check.problems).toEqual([])
  expect(check.warnings).toEqual([
    'Antigravity keeps its sign-in in the macOS keychain here, so Hydra cannot check it before a Head starts. If a Head stops with "not signed in", run `agy` once in a terminal.',
  ])
})

test('says plainly that Antigravity is not signed in when a round fails that way', async () => {
  expect(agyRoundErrors('', { status: 'ERROR', finalText: '{"status":"ERROR","error":"authentication failed or timed out"}' })).toBe(AGY_NOT_SIGNED_IN)
  expect(agyRoundErrors('You are not logged into Antigravity. Run `agy` to sign in.', { status: undefined, finalText: '' })).toBe(AGY_NOT_SIGNED_IN)
  expect(AGY_NOT_SIGNED_IN).toBe('Antigravity is not signed in. Run `agy` once in a terminal (choose Google OAuth), then run the Head again.')
  // Any other failure keeps what the CLI printed, for the quota check and the report.
  expect(agyRoundErrors('Error: connect ECONNREFUSED', { status: 'ERROR', finalText: 'boom' })).toBe('Error: connect ECONNREFUSED\nboom')
  expect(agyRoundErrors('', { status: 'ERROR', finalText: 'usage limit reached' })).toBe('usage limit reached')
  // The Head's report shows that sentence in place of the CLI's stderr.
  const report = formatReport({
    id: 'h', model: 'gemini-3.8-flash', cwd: '/p', finished: false, rounds: 1, turns: 0, usd: null, files: [], denied: [],
    finalText: '', exit: '1', errors: agyRoundErrors('', { status: 'ERROR', finalText: 'authentication failed or timed out' }), engine: 'agy',
  })
  expect(report).toContain(`--- stderr ---\n${AGY_NOT_SIGNED_IN}`)
})
