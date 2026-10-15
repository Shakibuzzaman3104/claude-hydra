/**
 * @author Shakib
 * @since 15/10/26
 */
import { expect, test } from 'claude-code/testing'

import { dirOf, isWindowsPath, shimTarget, toSlashes } from './lib/platform'

test('runs an npm shim through node instead of cmd.exe', async () => {
  const shim = '@IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n'
  expect(shimTarget(shim)).toBe('node_modules/@openai/codex/bin/codex.js')
  expect(shimTarget('"%~dp0\\node_modules\\opencode-ai\\bin\\opencode.cjs" %*')).toBe('node_modules/opencode-ai/bin/opencode.cjs')
  expect(shimTarget('@echo off\r\nopencode.exe %*')).toBeUndefined()
})

test('handles Windows paths with forward slashes', async () => {
  expect(toSlashes('C:\\Users\\me\\app')).toBe('C:/Users/me/app')
  expect(toSlashes('/Users/me/app')).toBe('/Users/me/app')
  expect(dirOf('C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd')).toBe('C:/Users/me/AppData/Roaming/npm')
  expect(isWindowsPath('D:\\work\\repo')).toBe(true)
  expect(isWindowsPath('D:/work/repo')).toBe(true)
  expect(isWindowsPath('\\\\server\\share')).toBe(true)
  expect(isWindowsPath('/home/me/repo')).toBe(false)
})
