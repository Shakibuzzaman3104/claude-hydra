/**
 * @author Shakib
 * @since 15/10/26
 */
import { expect, test } from 'claude-code/testing'

import { codexFilesystem } from './engines/codex'
import { headSettings, secretReadDeny } from './engines/commandcode'
import { REPORT_HEAD, reportNotice } from './lib/format'
import { CODEX_SECRET_DIRS, guardCommand, homeHeadRefusal, parseHomeReadDirs } from './lib/safety'

test('closes the home folder to a Codex Head, keeping the project, granted folders and toolchains readable', async () => {
  const profile = codexFilesystem('/home/me/app', { addDirs: ['/home/me/brief'], writeDirs: [], shell: true }, '/home/me', ['.gitconfig', '.nvm'])
  expect(profile).toContain('"/"="read"')
  expect(profile).toContain('"/home/me"="none"')
  expect(profile).toContain('"/home/me/.gitconfig"="read"')
  expect(profile).toContain('"/home/me/.nvm"="read"')
  expect(profile).toContain('"/home/me/brief"="read"')
  expect(profile).toContain('"/home/me/app"="write"')
  for (const dir of CODEX_SECRET_DIRS) expect(profile).toContain(`"/home/me/${dir}"="none"`)
})

test('leaves the home folder alone for a project outside it, and never closes a home the project holds', async () => {
  expect(codexFilesystem('/srv/app', { addDirs: [], shell: true }, '/home/me', [])).toContain('"/home/me"="none"')
  expect(codexFilesystem('/home', { addDirs: [], shell: true }, '/home/me', [])).not.toContain('"/home/me"="none"')
})

test('a granted read folder inside the project stays writable', async () => {
  const profile = codexFilesystem('/home/me/app', { addDirs: ['/home/me/app/docs'], shell: true }, '/home/me', [])
  expect(profile).not.toContain('"/home/me/app/docs"="read"')
})

test('refuses to run a Head in the root, the home folder or a folder above it', async () => {
  expect(homeHeadRefusal('/', '/home/me')).toContain('root of the disk')
  expect(homeHeadRefusal('C:/', 'C:/Users/me')).toContain('root of the disk')
  expect(homeHeadRefusal('/home/me', '/home/me')).toContain('home folder')
  expect(homeHeadRefusal('/home/me/', '/home/me')).toContain('home folder')
  expect(homeHeadRefusal('/home', '/home/me')).toContain('holds it')
  expect(homeHeadRefusal('/home/me/app', '/home/me')).toBeUndefined()
  expect(homeHeadRefusal('/srv/app', '/home/me')).toBeUndefined()
})

test('takes extra home read folders from the option, never a credential folder or a way out of home', async () => {
  expect(parseHomeReadDirs('~/.sdk, /home/me/tools/,\n.cache/bazel', '/home/me')).toEqual(['.sdk', 'tools', '.cache/bazel'])
  expect(parseHomeReadDirs('.ssh, .aws/config, ../other, /etc', '/home/me')).toEqual([])
})

test('denies a Command Code Head the credential folders, for the read tool and in shell commands', async () => {
  const deny = secretReadDeny('/Users/me')
  expect(deny).toContain('Read(//Users/me/.ssh)')
  expect(deny).toContain('Read(//Users/me/.ssh/**)')
  expect(deny).toContain('Shell(*/.aws*)')
  expect(secretReadDeny('')).toEqual([])
  expect(secretReadDeny('/')).toEqual([])
  const settings = headSettings([{ addDirs: [], shell: false }], [], false, undefined, '/Users/me')
  expect(settings.permissions?.deny).toContain('Read(//Users/me/.aws/**)')
})

test('quotes the write guard for the Windows command line', async () => {
  expect(guardCommand('C:/p/hydra', 'C:/work/my "app"', [], true)).toBe('py -3 -I "C:/p/hydra/bin/head-guard.py" "C:/work/my ""app"""')
  expect(guardCommand('/p', '/w')).toBe("/usr/bin/env python3 -I '/p/bin/head-guard.py' '/w'")
})

test('shows one line for a background report and keeps the whole report for Claude', async () => {
  const done = 'Hydra Head login-tests finished.\nhead login-tests · Codex · gpt-6-luna · finished · exit 0 · 1 round(s)\nedited (3): a.kt, b.kt, c.kt\n--- head report ---\nAll good.\nHEAD DONE'
  expect(REPORT_HEAD.test(done)).toBe(true)
  expect(reportNotice(done)).toBe('🐉 Head login-tests · ✓ finished · 3 files edited · report sent to Claude (/heads for detail)')
  const failed = 'Hydra Head api failed before it reported: boom'
  expect(reportNotice(failed)).toBe('🐉 Head api · ✗ did not finish · no edits · report sent to Claude (/heads for detail)')
  const partial = 'Hydra Head x finished.\nhead x · Codex · m · NOT finished · exit 9\nedited (1): a\ndenied (2):\n  - shell curl'
  expect(reportNotice(partial)).toBe('🐉 Head x · ✗ did not finish · 1 file edited · 2 denied · report sent to Claude (/heads for detail)')
  expect(REPORT_HEAD.test('please fix the Hydra Head bug')).toBe(false)
})
